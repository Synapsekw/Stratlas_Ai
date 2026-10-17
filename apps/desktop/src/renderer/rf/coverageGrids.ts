/**
 * The coverage the layer draws, as grids: the selected run's composite grids (read from its
 * GeoTIFFs) or a live preview's output, in one shape. Pure, so the class areas, the corners and
 * the line-up shift are tested without a map.
 *
 * Grid convention (`RfRunGrid`, `preview.ts`): row-major, row 0 at the top, the top-left corner in
 * the project CRS. Antenna geometry, and so the grid, is stored in its survey date's own frame and
 * drawn moved by that date's line-up shift (`coverageShift`), as the antenna boxes are.
 */
import { NO_SERVER, readGridTiff, type PreviewGrid, type PreviewOutput } from '@aio/rf';
import {
  shiftEN,
  type AntennasFile,
  type DateShift,
  type ProjectManifest,
  type RfRun,
  type RfThresholds,
} from '@aio/schema';
import { captureShift, dateShiftOf } from '@aio/workspace';
import { RSRP_CLASSES, classOf } from './coverageRamp';
import type { RfClassStat } from './rfStore';

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

/**
 * A run's composite grids from the bytes of its three GeoTIFFs. Nodata (`run.grid.nodata`) is NaN
 * RSRP and NO_SERVER; best server is the index into `run.inputs.sectors.sectors` (the job's rule).
 */
export function gridsFromRun(
  run: RfRun,
  bytes: { rsrp: Uint8Array; bestServer: Uint8Array; overlap: Uint8Array },
): CoverageGrids {
  const grid = runGrid(run);
  const n = grid.width * grid.height;
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
  const rsrp = new Float32Array(n);
  const bestServer = new Uint8Array(n);
  const overlap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = r[i] ?? Number.NaN;
    const none = v === nodata || !Number.isFinite(v);
    rsrp[i] = none ? Number.NaN : v;
    const s = b[i] ?? nodata;
    bestServer[i] = none || s === nodata || !(s >= 0 && s < NO_SERVER) ? NO_SERVER : Math.round(s);
    const c = o[i] ?? 0;
    overlap[i] = none || !(c > 0) ? 0 : Math.min(254, Math.round(c));
  }
  return {
    key: `run:${run.runId}`,
    source: 'run',
    grid,
    rsrp,
    bestServer,
    overlap,
    sectorIds: run.inputs.sectors.sectors.map((s) => s.id),
    thresholds: run.inputs.sectors.study.thresholds,
  };
}

/**
 * A live preview's output as coverage grids. Best server is renumbered to the index in
 * `allSectorIds` (the sectors file's order, as a run numbers it), so a sector keeps its colour
 * between the preview and the run.
 */
export function gridsFromPreview(
  key: string,
  grid: PreviewGrid,
  out: PreviewOutput,
  thresholds: RfThresholds,
  allSectorIds: readonly string[],
): CoverageGrids {
  const to = out.sectorIds.map((id) => {
    const at = allSectorIds.indexOf(id);
    return at < 0 || at >= NO_SERVER ? NO_SERVER : at;
  });
  const bestServer = new Uint8Array(out.bestServer.length);
  for (let i = 0; i < bestServer.length; i++) {
    const s = out.bestServer[i] ?? NO_SERVER;
    bestServer[i] = s === NO_SERVER ? NO_SERVER : (to[s] ?? NO_SERVER);
  }
  return {
    key,
    source: 'preview',
    grid,
    rsrp: out.rsrpDbm,
    bestServer,
    overlap: out.overlap,
    sectorIds: [...allSectorIds],
    thresholds,
  };
}

/**
 * Area and share of each RSRP class over the pixels a sector reaches (the job's `classAreasM2`:
 * "no service" is the reached area below the poor threshold).
 */
export function classStatsOf(g: CoverageGrids): RfClassStat[] {
  const counts = new Map<string, number>(RSRP_CLASSES.map((c) => [c, 0]));
  let total = 0;
  for (const v of g.rsrp) {
    const cls = classOf(v, g.thresholds);
    if (cls === null) continue;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
    total++;
  }
  const px = g.grid.resolutionM * g.grid.resolutionM;
  return RSRP_CLASSES.map((cls) => {
    const k = counts.get(cls) ?? 0;
    return { cls, areaM2: k * px, share: total > 0 ? k / total : 0 };
  });
}

/**
 * The line-up shift of the survey date the antenna inventory belongs to (its run's `captureId`,
 * else the cloud layer's date in an older file); null when that date is not lined up. The
 * coverage is computed from that inventory, so it moves with it (R9).
 */
export function coverageShift(
  antennas: Pick<AntennasFile, 'run'> | null,
  manifest: Pick<ProjectManifest, 'captures' | 'layers'> | null,
): DateShift | null {
  if (!antennas || !manifest) return null;
  const { captureId, cloudLayer } = antennas.run;
  return captureId !== undefined
    ? captureShift(manifest, captureId)
    : dateShiftOf(manifest, cloudLayer);
}

/** Project CRS (east, north) corners of the grid as drawn: tl, tr, br, bl, line-up shift applied. */
export function gridCorners(
  g: PreviewGrid,
  shift: DateShift | null,
): [[number, number], [number, number], [number, number], [number, number]] {
  const w = g.originEast;
  const n = g.originNorth;
  const e = w + g.width * g.resolutionM;
  const s = n - g.height * g.resolutionM;
  const at = (x: number, y: number): [number, number] => shiftEN([x, y] as [number, number], shift);
  return [at(w, n), at(e, n), at(e, s), at(w, s)];
}
