// Real heights for converted old-kit piles (volumetrics redesign A3). A pile converted from the
// stockpile kit is draped on the kit's DSM of the date whose outline it is; when that date has no
// kit DSM, on the prepared surface of the matching survey date. Piles converted before heights
// existed (every vertex at Z 0) are repaired once with the same heights (`@aio/survey`
// `needsHeightRepair`, `repairKitHeights`).
import type {
  BoundaryEditsFile,
  MeasurementsFile,
  ProjectManifest,
  SurveyMeasurement,
  VolumesFile,
} from '@aio/schema';
import { applyEdits, drapeZ, kitEpochOf, needsHeightRepair, type KitHeightAt } from '@aio/survey';
import { decodeDsm, sampleDsm, type DsmGrid } from '@aio/volumetric';
import type { groundAt } from './dateSurfaces';

/** Where imports before `VolumesFile.grids` existed keep the kit's DSMs. */
const LEGACY_DSM = 'legacy/data/dsm_{epoch}.js';

/**
 * The kit's DSM of one survey (epoch), as a project path: where `volumes.grids.dsm` names it
 * (imports since 11 Oct), else the layout of older imports under `legacy/data/` (as
 * `@aio/volumetric`'s store reads them).
 */
export const kitDsmPath = (epoch: string, volumes?: VolumesFile | null): string =>
  (volumes?.grids?.dsm ?? LEGACY_DSM).replaceAll('{epoch}', encodeURIComponent(epoch));

/**
 * Decoded kit DSMs by epoch, kept for the session of one project: decoding is the slow part. Only
 * grids that decoded are kept; a missing file is asked again (a build may write it).
 */
export type DsmCache = Map<string, DsmGrid>;

/**
 * Heights from the kit's DSMs of the epochs given, each read once (`textOf`), or taken from
 * `cache` when decoded before. An epoch whose file is missing or will not read has no heights
 * (null), as has a point off its grid.
 */
export async function dsmHeightAt(
  epochs: readonly string[],
  textOf: (epoch: string) => Promise<string | null>,
  cache?: DsmCache,
): Promise<KitHeightAt> {
  const grids = new Map<string, DsmGrid>();
  await Promise.all(
    [...new Set(epochs)].map(async (epoch) => {
      const kept = cache?.get(epoch);
      if (kept) {
        grids.set(epoch, kept);
        return;
      }
      try {
        const text = await textOf(epoch);
        if (text === null) return;
        const grid = await decodeDsm(text);
        grids.set(epoch, grid);
        cache?.set(epoch, grid);
      } catch {
        // no heights for this date
      }
    }),
  );
  return (epoch, e, n) => {
    const g = grids.get(epoch);
    return g ? sampleDsm(g, e, n) : null;
  };
}

/** `dsmHeightAt` over the project's `aio://` files (`kitDsmPath`). */
export function kitDsmHeightAt(
  projectId: string,
  epochs: readonly string[],
  fetchText: (url: string) => Promise<string | null>,
  opts: { volumes?: VolumesFile | null; cache?: DsmCache } = {},
): Promise<KitHeightAt> {
  const base = `aio://project/${encodeURIComponent(projectId)}/`;
  return dsmHeightAt(
    epochs,
    (epoch) => fetchText(`${base}${kitDsmPath(epoch, opts.volumes)}`),
    opts.cache,
  );
}

/** A project file's text through the app's `aio://` protocol; null when it is not there. */
export async function fetchKitText(url: string): Promise<string | null> {
  const r = await fetch(url);
  return r.ok ? r.text() : null;
}

/** The kit's survey dates (epochs), first to last. */
export const kitEpochs = (volumes: VolumesFile): string[] => volumes.captures.map((c) => c.epoch);

/** The capture a kit epoch was surveyed as (the rule `workspace/volumeDates.ts` uses). */
export const captureOfEpoch =
  (volumes: VolumesFile | null) =>
  (epoch: string): string | null =>
    volumes?.captures.find((c) => c.epoch === epoch)?.captureId ?? null;

/**
 * The epoch of a kit pile's outline: its latest date with a toe line, hand edits applied (the one
 * a conversion draws and drapes, `convertKitPiles`).
 */
export const epochOfPile = (volumes: VolumesFile | null, edits?: BoundaryEditsFile | null) => {
  const piles = volumes ? applyEdits(volumes, edits?.edits ?? []) : [];
  return (pile: string): string | null => {
    const p = piles.find((x) => x.id === pile);
    if (!p || !volumes) return null;
    let found: string | null = null;
    for (const c of volumes.captures)
      if ((p.epochs[c.epoch]?.ring.length ?? 0) > 0) found = c.epoch;
    return found;
  };
};

/**
 * Whether opening the file with this kit data may need heights: a pile still to convert, or a
 * converted pile still at Z 0. Saves reading the DSMs on every open.
 */
export function wantsKitHeights(file: MeasurementsFile, volumes: VolumesFile): boolean {
  const done = file.kitPilesConverted;
  if (done === undefined) return true;
  const known = new Set(done);
  if (volumes.piles.some((p) => !known.has(p.id))) return true;
  return file.measurements.some((m) => needsHeightRepair(m, file));
}

/**
 * The kit dates whose DSMs opening the file may drape on: each pile still to convert on its
 * outline's date, each converted pile still at Z 0 on its own (`epochOf`). Only these are decoded.
 */
export function kitEpochsWanted(
  file: MeasurementsFile,
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
): string[] {
  const outline = epochOfPile(volumes, edits);
  const done = new Set(file.kitPilesConverted ?? []);
  const wanted = new Set<string>();
  for (const p of volumes.piles) {
    if (done.has(p.id)) continue;
    const e = outline(p.id);
    if (e !== null) wanted.add(e);
  }
  const deps = { epochOfPile: outline };
  for (const m of file.measurements) {
    if (!needsHeightRepair(m, file)) continue;
    const e = epochOf(m, deps);
    if (e !== null) wanted.add(e);
  }
  return kitEpochs(volumes).filter((e) => wanted.has(e));
}

export interface KitRepairDeps {
  /** The kit's DSM heights (`kitDsmHeightAt`). */
  dsm: KitHeightAt;
  /** The ground under points on a date's prepared surface (`dateSurfaces.ts`), NaN where none. */
  groundAt: typeof groundAt;
  captureOfEpoch: (epoch: string) => string | null;
  /** The date of a pile's outline (`epochOfPile`); without it the date of its carried figure. */
  epochOfPile?: (pile: string) => string | null;
}

/**
 * Heights from the kit's DSM only, with no prepared surface read (opening a project, before its
 * surfaces load; the report).
 */
export function dsmOnly(
  volumes: VolumesFile,
  dsm: KitHeightAt,
  edits?: BoundaryEditsFile | null,
): KitRepairDeps {
  return {
    dsm,
    groundAt: (_capture, drawn) => Promise.resolve(new Float64Array(drawn.length).fill(Number.NaN)),
    captureOfEpoch: captureOfEpoch(volumes),
    epochOfPile: epochOfPile(volumes, edits),
  };
}

/**
 * The kit date a converted pile's outline belongs to: the date its outline was drawn from (as the
 * conversion drapes it), else, without the kit's volumes, the date of its carried figure.
 */
function epochOf(m: SurveyMeasurement, deps: Pick<KitRepairDeps, 'epochOfPile'>): string | null {
  const drawn = m.origin?.kind === 'kit-pile' ? (deps.epochOfPile?.(m.origin.pile) ?? null) : null;
  return drawn ?? kitEpochOf(m);
}

/**
 * Heights for the converted piles that still lie at Z 0 (`needsHeightRepair`), by measurement
 * id: the kit DSM of the pile's date first, else the prepared surface of that date's capture. A
 * pile with no height anywhere, or with a ground of 0 everywhere (nothing to change), gets no
 * entry (it keeps Z 0 and is not marked repaired).
 */
export async function kitRepairHeights(
  file: MeasurementsFile,
  manifest: ProjectManifest,
  deps: KitRepairDeps,
): Promise<ReadonlyMap<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const m of file.measurements) {
    if (!needsHeightRepair(m, file)) continue;
    const epoch = epochOf(m, deps);
    if (epoch === null) continue;
    let z = drapeZ(m.points, (e, n) => deps.dsm(epoch, e, n));
    const capture = z ? null : deps.captureOfEpoch(epoch);
    if (capture !== null) {
      let ground: Float64Array;
      try {
        ground = await deps.groundAt(capture, m.points, manifest);
      } catch {
        ground = new Float64Array(0);
      }
      // drapeZ asks for the points in order: the i-th ask is the i-th point
      let i = 0;
      z = drapeZ(m.points, () => ground[i++] ?? null);
    }
    if (z?.some((h) => h !== 0)) out.set(m.id, z);
  }
  return out;
}
