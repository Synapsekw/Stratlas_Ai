// Real heights for converted old-kit piles (volumetrics redesign A3). A pile converted from the
// stockpile kit is draped on the kit's DSM of the date whose outline it is; when that date has no
// kit DSM, on the prepared surface of the matching survey date. Piles converted before heights
// existed (every vertex at Z 0) are repaired once with the same heights (`@aio/survey`
// `needsHeightRepair`, `repairKitHeights`).
import type {
  MeasurementsFile,
  ProjectManifest,
  SurveyMeasurement,
  VolumesFile,
} from '@aio/schema';
import { drapeZ, kitEpochOf, needsHeightRepair, type KitHeightAt } from '@aio/survey';
import { decodeDsm, sampleDsm, type DsmGrid } from '@aio/volumetric';
import type { groundAt } from './dateSurfaces';

/** The kit's DSM of one survey (epoch), as a project path. */
export const kitDsmPath = (epoch: string): string =>
  `legacy/data/dsm_${encodeURIComponent(epoch)}.js`;

/**
 * Heights from the kit's DSMs of the epochs given, each read once (`textOf`). An epoch whose file
 * is missing or will not read has no heights (null), as has a point off its grid.
 */
export async function dsmHeightAt(
  epochs: readonly string[],
  textOf: (epoch: string) => Promise<string | null>,
): Promise<KitHeightAt> {
  const grids = new Map<string, DsmGrid>();
  await Promise.all(
    [...new Set(epochs)].map(async (epoch) => {
      try {
        const text = await textOf(epoch);
        if (text !== null) grids.set(epoch, await decodeDsm(text));
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

/** `dsmHeightAt` over the project's `aio://` files (`legacy/data/dsm_<epoch>.js`). */
export function kitDsmHeightAt(
  projectId: string,
  epochs: readonly string[],
  fetchText: (url: string) => Promise<string | null>,
): Promise<KitHeightAt> {
  const base = `aio://project/${encodeURIComponent(projectId)}/`;
  return dsmHeightAt(epochs, (epoch) => fetchText(`${base}${kitDsmPath(epoch)}`));
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
 * The epoch of a kit pile's outline: its latest date with a toe line (the one a conversion
 * draws, `convertKitPiles`). For a pile that carries no figure to tell its date.
 */
export const epochOfPile =
  (volumes: VolumesFile | null) =>
  (pile: string): string | null => {
    const p = volumes?.piles.find((x) => x.id === pile);
    if (!p || !volumes) return null;
    let found: string | null = null;
    for (const c of volumes.captures)
      if ((p.epochs[c.epoch]?.ring.length ?? 0) > 0) found = c.epoch;
    return found;
  };

/**
 * Whether opening the file with this kit data may need heights: a pile still to convert, or a
 * converted pile still at Z 0. Saves reading the DSMs on every open.
 */
export function wantsKitHeights(
  file: MeasurementsFile,
  volumes: VolumesFile,
  originH: number,
): boolean {
  const done = file.kitPilesConverted;
  if (done === undefined) return true;
  const known = new Set(done);
  if (volumes.piles.some((p) => !known.has(p.id))) return true;
  return file.measurements.some((m) => needsHeightRepair(m, file, originH));
}

export interface KitRepairDeps {
  /** The kit's DSM heights (`kitDsmHeightAt`). */
  dsm: KitHeightAt;
  /** The ground under points on a date's prepared surface (`dateSurfaces.ts`), NaN where none. */
  groundAt: typeof groundAt;
  captureOfEpoch: (epoch: string) => string | null;
  /** The date of a pile that carries no figure (`epochOfPile`); without it such a pile is skipped. */
  epochOfPile?: (pile: string) => string | null;
}

/**
 * Heights from the kit's DSM only, with no prepared surface read (opening a project, before its
 * surfaces load; the report).
 */
export function dsmOnly(volumes: VolumesFile, dsm: KitHeightAt): KitRepairDeps {
  return {
    dsm,
    groundAt: (_capture, drawn) => Promise.resolve(new Float64Array(drawn.length).fill(Number.NaN)),
    captureOfEpoch: captureOfEpoch(volumes),
    epochOfPile: epochOfPile(volumes),
  };
}

/** The kit date a converted pile's outline belongs to. */
function epochOf(m: SurveyMeasurement, deps: KitRepairDeps): string | null {
  const carried = kitEpochOf(m);
  if (carried !== null) return carried;
  return m.origin?.kind === 'kit-pile' ? (deps.epochOfPile?.(m.origin.pile) ?? null) : null;
}

/**
 * Heights for the converted piles that still lie at Z 0 (`needsHeightRepair`), by measurement
 * id: the kit DSM of the pile's date first, else the prepared surface of that date's capture. A
 * pile with no height anywhere gets no entry (it keeps Z 0 and is not marked repaired).
 */
export async function kitRepairHeights(
  file: MeasurementsFile,
  manifest: ProjectManifest,
  deps: KitRepairDeps,
): Promise<ReadonlyMap<string, number[]>> {
  const originH = manifest.origin[2];
  const out = new Map<string, number[]>();
  for (const m of file.measurements) {
    if (!needsHeightRepair(m, file, originH)) continue;
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
    if (z) out.set(m.id, z);
  }
  return out;
}
