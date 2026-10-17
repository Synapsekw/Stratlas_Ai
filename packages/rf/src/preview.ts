/**
 * Live preview engine (spec D15, D16, D18). Path loss depends only on distance, frequency and
 * heights, so it arrives as cached Float32 grids (one per sector and band, from the `rf.coverage`
 * job or `pathLossGrid`). A slider change recomputes only the pattern and link-budget terms here:
 *
 *   RSRP = P_port - 10 log10(12 N_RB) - L_feeder + G_ant - patternLoss(phi, theta) - PL - margin
 *
 * Views (D18): composite RSRP = max over sectors (a sector's RSRP is the max over its antennas),
 * best server = the argmax sector, overlap = how many sectors are within 6 dB of the best (the
 * best included, so a lone server counts 1).
 *
 * Grid: row-major, row 0 at the top. Pixel (col, row) has its centre at
 * (originEast + (col + 0.5) res, originNorth - (row + 0.5) res) in the project CRS, the top-left
 * convention of `RfRunGrid`. NaN path loss means no data; a pixel no sector reaches is NaN RSRP,
 * NO_SERVER and overlap 0.
 *
 * The hot loop inlines the rotation of `toAntennaFrame` (geometry.ts), which allocates per call.
 * It turns by the grid azimuth: `directionToAntennaFrame` rotates both the direction and the
 * azimuth by the convergence, which cancels, but a missing convergence is still refused (D2).
 * `preview.test.ts` checks every pixel against `evaluatePoint`.
 *
 * `servePreview` is the Worker side (preview.worker.ts is only its entry point): it keeps the
 * path-loss grids by key so slider moves send settings, not grids.
 */

import { DEFAULT_AM_DB, DEFAULT_SLAV_DB, type AntennaPattern } from './pattern';
import { makePathLoss, type PathLossSetup } from './propagation';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Best-server value where no sector reaches the pixel. */
export const NO_SERVER = 255;
/** Overlap counts sectors within this many dB of the best (D18). */
export const OVERLAP_WINDOW_DB = 6;

export interface PreviewGrid {
  width: number;
  height: number;
  resolutionM: number;
  /** Top-left corner of the grid, project CRS. */
  originEast: number;
  originNorth: number;
}

export interface PreviewSource {
  /** Antenna position, project CRS. */
  east: number;
  north: number;
  /** Antenna height above the tower-base ground (flat ground, D17). */
  heightM: number;
  azimuthGridDeg: number;
  convergenceDeg: number | null;
  mechanicalDowntiltDeg: number;
  /** A parametric pattern carries the electrical tilt; a two-cut pattern holds it already. */
  pattern: AntennaPattern;
  portPowerDbm: number;
  /** 12 N_RB (`subcarrierCount`). */
  subcarriers: number;
  feederLossDb: number;
  antennaGainDbi: number;
  /** width x height path loss, dB, NaN for no data. */
  pathLossDb: Float32Array;
}

export interface PreviewSector {
  id: string;
  sources: readonly PreviewSource[];
}

export interface PreviewInput {
  grid: PreviewGrid;
  /** UE height above the tower-base ground. */
  ueHeightM: number;
  /** Total margin (`margins(...).totalDb`), dB. */
  marginDb: number;
  sectors: readonly PreviewSector[];
  overlapWindowDb?: number;
}

export interface PreviewOutput {
  /** Sector ids in best-server index order. */
  sectorIds: string[];
  rsrpDbm: Float32Array;
  /** Index into `sectorIds`, NO_SERVER where none. */
  bestServer: Uint8Array;
  overlap: Uint8Array;
}

export function pixelCentre(
  g: PreviewGrid,
  col: number,
  row: number,
): { east: number; north: number } {
  return {
    east: g.originEast + (col + 0.5) * g.resolutionM,
    north: g.originNorth - (row + 0.5) * g.resolutionM,
  };
}

/**
 * The study grid around a site (python `rf/grid.py` `build_grid`): snapped to whole multiples of
 * the resolution, the site in its centre pixel and `ceil(radius / res)` pixels on each side, so a
 * preview and a run of one site share pixels.
 */
export function studyGrid(
  centreEast: number,
  centreNorth: number,
  radiusM: number,
  resolutionM: number,
): PreviewGrid {
  const k = Math.ceil(radiusM / resolutionM - 1e-9);
  const ce = Math.floor(centreEast / resolutionM);
  const cn = Math.floor(centreNorth / resolutionM);
  return {
    width: 2 * k + 1,
    height: 2 * k + 1,
    resolutionM,
    originEast: (ce - k) * resolutionM,
    originNorth: (cn + 1 + k) * resolutionM,
  };
}

function checkGrid(g: PreviewGrid): number {
  if (!(Number.isInteger(g.width) && g.width > 0 && Number.isInteger(g.height) && g.height > 0))
    throw new Error('The preview grid needs a whole, positive width and height');
  if (!(g.resolutionM > 0)) throw new Error('The preview grid resolution must be more than 0 m');
  return g.width * g.height;
}

/**
 * Path loss at every pixel centre from the horizontal distance to the antenna, dB. Pixels beyond
 * `radiusM` are NaN. Throws PathLossRefusalError for a refused setup.
 */
export function pathLossGrid(
  g: PreviewGrid,
  antenna: { east: number; north: number },
  setup: PathLossSetup,
  radiusM = Number.POSITIVE_INFINITY,
): Float32Array {
  const n = checkGrid(g);
  const pl = makePathLoss(setup);
  const out = new Float32Array(n);
  const r2 = radiusM * radiusM;
  for (let row = 0; row < g.height; row++) {
    const dn = g.originNorth - (row + 0.5) * g.resolutionM - antenna.north;
    for (let col = 0; col < g.width; col++) {
      const de = g.originEast + (col + 0.5) * g.resolutionM - antenna.east;
      const d2 = de * de + dn * dn;
      out[row * g.width + col] = d2 > r2 ? Number.NaN : pl(Math.sqrt(d2));
    }
  }
  return out;
}

/** Adds one source into its sector's running maximum (`acc`, -Infinity where unset). */
function accumulate(
  g: PreviewGrid,
  ueHeightM: number,
  marginDb: number,
  s: PreviewSource,
  acc: Float64Array,
): void {
  if (s.convergenceDeg === null || !Number.isFinite(s.convergenceDeg))
    throw new Error(
      'No grid convergence: the project needs a CRS before coverage can face the right way',
    );
  const n = g.width * g.height;
  if (s.pathLossDb.length !== n)
    throw new Error(
      `The path-loss grid has ${String(s.pathLossDb.length)} values; the preview grid needs ${String(n)} values`,
    );

  const constant =
    s.portPowerDbm - 10 * Math.log10(s.subcarriers) - s.feederLossDb + s.antennaGainDbi - marginDb;
  const sa = Math.sin(s.azimuthGridDeg * RAD);
  const ca = Math.cos(s.azimuthGridDeg * RAD);
  const st = Math.sin(s.mechanicalDowntiltDeg * RAD);
  const ct = Math.cos(s.mechanicalDowntiltDeg * RAD);
  const dz = ueHeightM - s.heightM;
  const dzSt = dz * st;
  const dzCt = dz * ct;
  const res = g.resolutionM;
  const pl = s.pathLossDb;

  // Per column: east offset turned by the azimuth (both rotation terms).
  const w = g.width;
  const colF = new Float64Array(w);
  const colR = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const de = g.originEast + (c + 0.5) * res - s.east;
    colF[c] = de * sa;
    colR[c] = de * ca;
  }

  const p = s.pattern;
  if (p.kind === 'parametric') {
    if (!(p.hBeamwidthDeg > 0) || !(p.vBeamwidthDeg > 0))
      throw new Error('Beamwidths must be positive');
    const kh = 12 / (p.hBeamwidthDeg * p.hBeamwidthDeg);
    const kv = 12 / (p.vBeamwidthDeg * p.vBeamwidthDeg);
    const am = p.amDb ?? DEFAULT_AM_DB;
    const slav = p.slavDb ?? DEFAULT_SLAV_DB;
    const et = p.eTiltDeg;
    for (let row = 0; row < g.height; row++) {
      const dn = g.originNorth - (row + 0.5) * res - s.north;
      const dnCa = dn * ca;
      const dnSa = dn * sa;
      const base = row * w;
      for (let c = 0; c < w; c++) {
        const i = base + c;
        const loss = pl[i] ?? Number.NaN;
        if (loss !== loss) continue; // NaN: no data
        const f = (colF[c] ?? 0) + dnCa;
        const r = (colR[c] ?? 0) - dnSa;
        const fwd = f * ct - dzSt;
        const up = f * st + dzCt;
        const az = Math.atan2(r, fwd) * DEG;
        const dv = -Math.atan2(up, Math.sqrt(fwd * fwd + r * r)) * DEG - et;
        let aH = kh * az * az;
        if (aH > am) aH = am;
        let aV = kv * dv * dv;
        if (aV > slav) aV = slav;
        let a = aH + aV;
        if (a > am) a = am;
        const v = constant - a - loss;
        if (v > (acc[i] ?? Number.POSITIVE_INFINITY)) acc[i] = v;
      }
    }
    return;
  }

  const hc = p.horizontalDb;
  const vc = p.verticalDb;
  const cap = p.capDb;
  const cut = (arr: readonly number[], deg: number): number => {
    let x = deg % 360;
    if (x < 0) x += 360;
    const i0 = Math.floor(x);
    const t = x - i0;
    const v0 = arr[i0 % 360] ?? 0;
    return v0 + ((arr[(i0 + 1) % 360] ?? 0) - v0) * t;
  };
  for (let row = 0; row < g.height; row++) {
    const dn = g.originNorth - (row + 0.5) * res - s.north;
    const dnCa = dn * ca;
    const dnSa = dn * sa;
    const base = row * w;
    for (let c = 0; c < w; c++) {
      const i = base + c;
      const loss = pl[i] ?? Number.NaN;
      if (loss !== loss) continue;
      const f = (colF[c] ?? 0) + dnCa;
      const r = (colR[c] ?? 0) - dnSa;
      const fwd = f * ct - dzSt;
      const up = f * st + dzCt;
      const az = Math.atan2(r, fwd) * DEG;
      const down = -Math.atan2(up, Math.sqrt(fwd * fwd + r * r)) * DEG;
      let a = cut(hc, az) + cut(vc, down);
      if (a > cap) a = cap;
      const v = constant - a - loss;
      if (v > (acc[i] ?? Number.POSITIVE_INFINITY)) acc[i] = v;
    }
  }
}

/** Composite RSRP, best server and overlap over cached path loss (pure; the Worker calls this). */
export function computePreview(input: PreviewInput): PreviewOutput {
  const { grid, sectors } = input;
  const n = checkGrid(grid);
  if (sectors.length >= NO_SERVER)
    throw new Error(`A preview takes at most ${String(NO_SERVER - 1)} sectors`);
  const window = input.overlapWindowDb ?? OVERLAP_WINDOW_DB;

  const perSector = sectors.map((sec) => {
    const acc = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
    for (const src of sec.sources) accumulate(grid, input.ueHeightM, input.marginDb, src, acc);
    return acc;
  });

  const rsrpDbm = new Float32Array(n);
  const bestServer = new Uint8Array(n);
  const overlap = new Uint8Array(n);
  const rows = perSector;
  const k = rows.length;
  for (let i = 0; i < n; i++) {
    let best = Number.NEGATIVE_INFINITY;
    let bi = NO_SERVER;
    for (let s = 0; s < k; s++) {
      const v = rows[s]?.[i] ?? Number.NEGATIVE_INFINITY;
      if (v > best) {
        best = v;
        bi = s;
      }
    }
    if (bi === NO_SERVER) {
      rsrpDbm[i] = Number.NaN;
      bestServer[i] = NO_SERVER;
      continue;
    }
    let count = 0;
    const floor = best - window;
    for (let s = 0; s < k; s++) if ((rows[s]?.[i] ?? Number.NEGATIVE_INFINITY) >= floor) count++;
    rsrpDbm[i] = best;
    bestServer[i] = bi;
    overlap[i] = count;
  }
  return { sectorIds: sectors.map((s) => s.id), rsrpDbm, bestServer, overlap };
}

// ---- Worker protocol ---------------------------------------------------------------------------

/** A source as the Worker receives it: settings plus the key of a cached path-loss grid. */
export type PreviewSourceSettings = Omit<PreviewSource, 'pathLossDb'> & { pathLossKey: string };

export interface PreviewRequest extends Omit<PreviewInput, 'sectors'> {
  sectors: readonly { id: string; sources: readonly PreviewSourceSettings[] }[];
}

export type PreviewMessage =
  | { type: 'path-loss:set'; key: string; pathLossDb: Float32Array }
  /** Work a path-loss grid out in the Worker (`pathLossGrid`) and keep it under `key`. */
  | {
      type: 'path-loss:compute';
      key: string;
      grid: PreviewGrid;
      antenna: { east: number; north: number };
      setup: PathLossSetup;
      radiusM: number;
    }
  | { type: 'path-loss:drop'; key: string }
  | { type: 'preview'; id: number; input: PreviewRequest };

export type PreviewReply =
  | { type: 'preview'; id: number; ok: true; output: PreviewOutput; elapsedMs: number }
  | { type: 'preview'; id: number; ok: false; error: string };

export interface PreviewPort {
  onmessage: ((e: { data: PreviewMessage }) => void) | null;
  postMessage(message: PreviewReply, transfer: ArrayBuffer[]): void;
}

/**
 * Resolves path-loss keys against the cache. Throws for an unknown key, with the reason the grid
 * could not be worked out when `failed` has one (a refused propagation setup).
 */
export function resolvePreviewRequest(
  req: PreviewRequest,
  cache: ReadonlyMap<string, Float32Array>,
  failed: ReadonlyMap<string, string> = new Map(),
): PreviewInput {
  return {
    ...req,
    sectors: req.sectors.map((sec) => ({
      id: sec.id,
      sources: sec.sources.map(({ pathLossKey, ...rest }) => {
        const pathLossDb = cache.get(pathLossKey);
        if (!pathLossDb)
          throw new Error(
            failed.get(pathLossKey) ?? `No path-loss grid is loaded for ${pathLossKey}`,
          );
        return { ...rest, pathLossDb };
      }),
    })),
  };
}

/**
 * Path-loss grids the Worker keeps at most (a backstop: the client drops the keys its plan no
 * longer uses). The least recently used grid goes first.
 */
export const MAX_PATH_LOSS_GRIDS = 64;

/** The Worker side: path-loss cache and preview requests. preview.worker.ts only calls this. */
export function servePreview(
  port: PreviewPort,
  now: () => number = () => performance.now(),
  maxGrids = MAX_PATH_LOSS_GRIDS,
): void {
  const cache = new Map<string, Float32Array>();
  const failed = new Map<string, string>();
  /** Keep a grid as the most recently used, then trim the oldest past the cap. */
  const keep = (key: string, grid: Float32Array) => {
    cache.delete(key);
    cache.set(key, grid);
    for (const k of cache.keys()) {
      if (cache.size <= maxGrids) break;
      cache.delete(k);
    }
  };
  port.onmessage = ({ data }) => {
    if (data.type === 'path-loss:set') {
      failed.delete(data.key);
      keep(data.key, data.pathLossDb);
      return;
    }
    if (data.type === 'path-loss:compute') {
      if (cache.has(data.key)) return;
      try {
        keep(data.key, pathLossGrid(data.grid, data.antenna, data.setup, data.radiusM));
        failed.delete(data.key);
      } catch (e) {
        failed.set(data.key, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (data.type === 'path-loss:drop') {
      cache.delete(data.key);
      failed.delete(data.key);
      return;
    }
    const t0 = now();
    try {
      const output = computePreview(resolvePreviewRequest(data.input, cache, failed));
      for (const sec of data.input.sectors)
        for (const src of sec.sources) {
          const g = cache.get(src.pathLossKey);
          if (g) keep(src.pathLossKey, g);
        }
      port.postMessage({ type: 'preview', id: data.id, ok: true, output, elapsedMs: now() - t0 }, [
        output.rsrpDbm.buffer as ArrayBuffer,
        output.bestServer.buffer as ArrayBuffer,
        output.overlap.buffer as ArrayBuffer,
      ]);
    } catch (e) {
      port.postMessage(
        {
          type: 'preview',
          id: data.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
        [],
      );
    }
  };
}
