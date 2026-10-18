/**
 * The coverage the layer draws, as grids: the selected run's composite grids (read from its
 * GeoTIFFs) or a live preview's output, in one shape. Pure, so the class areas, the corners and
 * the line-up shift are tested without a map.
 *
 * Grid convention (`RfRunGrid`, `preview.ts`): row-major, row 0 at the top, the top-left corner in
 * the project CRS. Antenna geometry, and so the grid, is stored in its survey date's own frame and
 * drawn moved by that date's line-up shift (`coverageShift`), as the antenna boxes are.
 */
import { NO_SERVER, type PreviewGrid, type PreviewOutput } from '@aio/rf';
import {
  shiftEN,
  type AntennasFile,
  type DateShift,
  type ProjectManifest,
  type RfThresholds,
} from '@aio/schema';
import { antennaShift } from '../telecom/antennaScene';
import type { CoverageGrids } from './runGrids';

export {
  classStatsOf,
  gridsFromRun,
  readRunGrids,
  runFile,
  runGrid,
  MAX_DRAWN_SIDE,
  type CoverageGrids,
  type ReducedFrom,
} from './runGrids';

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
 * The line-up shift of the survey date the antenna inventory belongs to, by the inventory's own
 * rule (telecom `antennaShift`: its run's `captureId`, else the cloud layer's date); null when that
 * date is not lined up. The coverage is computed from that inventory, so it moves with it (R9).
 */
export const coverageShift: (
  antennas: AntennasFile | null,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'> | null,
) => DateShift | null = antennaShift;

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
