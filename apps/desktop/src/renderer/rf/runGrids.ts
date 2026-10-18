/**
 * A run's composite grids, read from its GeoTIFFs, and what the class table counts on them. On its
 * own (no map, no telecom import) so the run reader Worker (`run.worker.ts`) bundles small.
 *
 * A run larger than `MAX_DRAWN_SIDE` on its long side is drawn reduced (integration review I1): the
 * Worker keeps one cell in every `step` along each axis, so no more than 2048 x 2048 cells reach
 * the main thread, the picture or the GPU. The class areas are counted on the full grid first, and
 * the exports read the run's files, so both stay at full resolution.
 */
import { NO_SERVER, readGridTiff, type PreviewGrid } from '@aio/rf';
import type { RfRun, RfThresholds } from '@aio/schema';
import { RSRP_CLASSES, classOf } from './coverageRamp';
import type { RfClassStat } from './rfStore';

/** The most cells a drawn grid has on its long side (the preview's cap, `MAX_PREVIEW_PIXELS`). */
export const MAX_DRAWN_SIDE = 2048;

/** The full size of a run drawn reduced, and the step between the cells drawn. */
export interface ReducedFrom {
  width: number;
  height: number;
  step: number;
}

export interface CoverageGrids {
  /** What the grids are, for caching: the run id, or the preview's number. */
  key: string;
  source: 'run' | 'preview';
  grid: PreviewGrid;
  /** dBm; NaN where no sector reaches. */
  rsrp: Float32Array;
  /** Index into `sectorIds`; NO_SERVER where none. */
  bestServer: Uint8Array;
  /** Sectors within the overlap window of the best (the best included); 0 where none. */
  overlap: Uint8Array;
  sectorIds: string[];
  thresholds: RfThresholds;
  /** Set when a large run is drawn reduced: its full size. */
  reducedFrom?: ReducedFrom;
  /** The class areas counted on the full grid, for a reduced run (else counted on these grids). */
  classStats?: RfClassStat[];
}

/** A run's grid in the preview's terms. */
export function runGrid(run: RfRun): PreviewGrid {
  return {
    width: run.grid.width,
    height: run.grid.height,
    resolutionM: run.grid.resolutionM,
    originEast: run.grid.origin[0],
    originNorth: run.grid.origin[1],
  };
}

/** The project-relative home of one of a run's grid files. */
export const runFile = (run: RfRun, file: string): string => `rf/runs/${run.runId}/${file}`;

export interface RunBytes {
  rsrp: Uint8Array;
  bestServer: Uint8Array;
  overlap: Uint8Array;
}

/** The three decoded grids and the rule that turns one cell into what is drawn. */
function decode(run: RfRun, bytes: RunBytes) {
  const grid = runGrid(run);
  const read = (b: Uint8Array, name: string): Float32Array => {
    const t = readGridTiff(b);
    if (t.width !== grid.width || t.height !== grid.height)
      throw new Error(
        `${name} is ${String(t.width)} x ${String(t.height)} but the run's grid is ${String(grid.width)} x ${String(grid.height)}.`,
      );
    return t.data;
  };
  const nodata = run.grid.nodata;
  const r = read(bytes.rsrp, 'rsrp');
  const b = read(bytes.bestServer, 'best server');
  const o = read(bytes.overlap, 'overlap');
  const rsrpAt = (i: number): number => {
    const v = r[i] ?? Number.NaN;
    return v === nodata || !Number.isFinite(v) ? Number.NaN : v;
  };
  const serverAt = (i: number): number => {
    if (Number.isNaN(rsrpAt(i))) return NO_SERVER;
    const s = b[i] ?? nodata;
    return s === nodata || !(s >= 0 && s < NO_SERVER) ? NO_SERVER : Math.round(s);
  };
  const overlapAt = (i: number): number => {
    if (Number.isNaN(rsrpAt(i))) return 0;
    const c = o[i] ?? 0;
    return !(c > 0) ? 0 : Math.min(254, Math.round(c));
  };
  return { grid, rsrpAt, serverAt, overlapAt };
}

function base(run: RfRun) {
  return {
    key: `run:${run.runId}`,
    source: 'run' as const,
    sectorIds: run.inputs.sectors.sectors.map((s) => s.id),
    thresholds: run.inputs.sectors.study.thresholds,
  };
}

/**
 * A run's composite grids from the bytes of its three GeoTIFFs, at full size. Nodata
 * (`run.grid.nodata`) is NaN RSRP and NO_SERVER; best server is the index into
 * `run.inputs.sectors.sectors` (the job's rule).
 */
export function gridsFromRun(run: RfRun, bytes: RunBytes): CoverageGrids {
  const d = decode(run, bytes);
  const n = d.grid.width * d.grid.height;
  const rsrp = new Float32Array(n);
  const bestServer = new Uint8Array(n);
  const overlap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rsrp[i] = d.rsrpAt(i);
    bestServer[i] = d.serverAt(i);
    overlap[i] = d.overlapAt(i);
  }
  return { ...base(run), grid: d.grid, rsrp, bestServer, overlap };
}

/** The step between drawn cells for a grid of this size (1 when it fits). */
export function drawnStep(
  g: Pick<PreviewGrid, 'width' | 'height'>,
  maxSide: number = MAX_DRAWN_SIDE,
): number {
  return Math.max(1, Math.ceil(Math.max(g.width, g.height) / maxSide));
}

/**
 * A run's grids as the layer draws them: whole when the long side fits `maxSide`, else one cell in
 * every `step` (the middle cell of each step x step block, the same cell for all three grids, so
 * the views agree), with the class areas counted on the full grid. The reduced grid keeps the
 * origin; its cells are `step` times larger, so its east and south edges can reach up to
 * `step - 1` cells past the full grid's.
 */
export function readRunGrids(
  run: RfRun,
  bytes: RunBytes,
  maxSide: number = MAX_DRAWN_SIDE,
): CoverageGrids {
  const full = runGrid(run);
  const step = drawnStep(full, maxSide);
  if (step === 1) return gridsFromRun(run, bytes);
  const d = decode(run, bytes);
  const { width: W, height: H } = full;
  const th = run.inputs.sectors.study.thresholds;
  const stats = countClasses(W * H, d.rsrpAt, th, full.resolutionM);
  const w = Math.ceil(W / step);
  const h = Math.ceil(H / step);
  const mid = Math.floor(step / 2);
  const rsrp = new Float32Array(w * h);
  const bestServer = new Uint8Array(w * h);
  const overlap = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.min(y * step + mid, H - 1) * W;
    for (let x = 0; x < w; x++) {
      const i = row + Math.min(x * step + mid, W - 1);
      const j = y * w + x;
      rsrp[j] = d.rsrpAt(i);
      bestServer[j] = d.serverAt(i);
      overlap[j] = d.overlapAt(i);
    }
  }
  return {
    ...base(run),
    grid: { ...full, width: w, height: h, resolutionM: full.resolutionM * step },
    rsrp,
    bestServer,
    overlap,
    reducedFrom: { width: W, height: H, step },
    classStats: stats,
  };
}

function countClasses(
  n: number,
  rsrpAt: (i: number) => number,
  th: RfThresholds,
  resolutionM: number,
): RfClassStat[] {
  const counts = new Map<string, number>(RSRP_CLASSES.map((c) => [c, 0]));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const cls = classOf(rsrpAt(i), th);
    if (cls === null) continue;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
    total++;
  }
  const px = resolutionM * resolutionM;
  return RSRP_CLASSES.map((cls) => {
    const k = counts.get(cls) ?? 0;
    return { cls, areaM2: k * px, share: total > 0 ? k / total : 0 };
  });
}

/**
 * Area and share of each RSRP class over the pixels a sector reaches (the job's `classAreasM2`:
 * "no service" is the reached area below the poor threshold). A reduced run gives the areas it
 * counted on its full grid.
 */
export function classStatsOf(g: CoverageGrids): RfClassStat[] {
  if (g.classStats) return g.classStats;
  return countClasses(
    g.rsrp.length,
    (i) => g.rsrp[i] ?? Number.NaN,
    g.thresholds,
    g.grid.resolutionM,
  );
}
