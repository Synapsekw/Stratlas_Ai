// Volumetric parity W3: the old stockpile kit's piles become engine volume measurements. The kit's
// stored figures are carried over unchanged as results labelled "From an earlier version (kit
// <base>)"; nothing here recomputes a volume. Everything is keyed by the kit pile's id.
import type {
  BoundaryEdit,
  BoundaryEditsFile,
  ComparisonResult,
  MeasurementsFile,
  PileEpoch,
  SitePoint,
  StockPile,
  SurveyId,
  SurveyMeasurement,
  VolumeBaseId,
  VolumesFile,
} from '@aio/schema';

/** The Datasets folder converted kit piles land in. */
export const KIT_FOLDER = 'Stockpiles';

/** The kit base named in "From an earlier version (kit <base>)". */
export const KIT_BASE_LABEL: Record<VolumeBaseId, string> = {
  tin: 'tin',
  plane: 'plane',
  avg: 'avg',
  low: 'low',
};

/** The kit computed pile volumes on 10 cm grids. */
const KIT_CELL_M = 0.1;
/** The schema's longest measurement label. */
const LABEL_MAX = 200;

/** A pile with hand edits applied; `edited` lists the epochs whose toe line was corrected. */
export type EffectivePile = StockPile & { edited: string[]; auto: Record<string, PileEpoch> };

/** Piles as the register shows them: an edit replaces the automatic line and volumes. */
export function applyEdits(file: VolumesFile, edits: readonly BoundaryEdit[]): EffectivePile[] {
  return file.piles.map((p) => {
    const epochs: Record<string, PileEpoch> = { ...p.epochs };
    const edited: string[] = [];
    for (const e of edits) {
      if (e.pile !== p.id) continue;
      const auto = p.epochs[e.epoch];
      const capture = file.captures.find((c) => c.epoch === e.epoch);
      epochs[e.epoch] = {
        ...(auto ?? {}),
        captureId: auto?.captureId ?? capture?.captureId ?? e.epoch,
        ring: e.ring,
        areaM2: e.areaM2,
        topM: e.topM,
        heightM: e.heightM,
        volumes: e.volumes,
        groundToeFrac: 1,
      };
      edited.push(e.epoch);
    }
    return { ...p, epochs, edited, auto: p.epochs };
  });
}

export interface KitConversion {
  added: SurveyMeasurement[];
  /** Kit pile ids converted by this call; append them to `kitPilesConverted`. */
  converted: string[];
}

export interface KitConversionOptions {
  /** Carry the kit figures over as stored results; false adds the items only (the engine computes). */
  carry: boolean;
  now: string;
  newId: () => string;
  /** A kit local-frame point (`[x, z]`, x east, z south) to the project CRS `[E, N, Z]`. */
  toSite: (xz: readonly [number, number]) => SitePoint;
  /** The site material id for a kit material name, if one exists. */
  materialId: (name: string) => SurveyId | undefined;
}

/**
 * One volume measurement per effective pile not in `file.kitPilesConverted`. carry=true sets each
 * date's result from the kit figure of `volumes.defaultBase` (series) and, only when the pile is
 * on the file's last capture, that date as results[0] (the kit's register showed a pile gone by
 * then as absent, so it gets no headline); carry=false adds the item only (the engine computes).
 * The outline is the latest non-empty toe line. A duplicate pile id converts once, the first.
 */
export function convertKitPiles(
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
  file: MeasurementsFile,
  opts: KitConversionOptions,
): KitConversion {
  const done = new Set<string>(file.kitPilesConverted ?? []);
  const base = volumes.defaultBase;
  const lastEpoch = volumes.captures[volumes.captures.length - 1]?.epoch;
  const added: SurveyMeasurement[] = [];
  const converted: string[] = [];

  for (const pile of applyEdits(volumes, edits?.edits ?? [])) {
    if (done.has(pile.id)) continue;
    // Dates the pile is on, in survey order (first to last).
    const dates = volumes.captures.flatMap((c) => {
      const ep = pile.epochs[c.epoch];
      return ep ? [{ capture: c, ep }] : [];
    });
    // The latest non-empty toe line; a pile with none has nothing to draw.
    let outline: PileEpoch['ring'] | undefined;
    for (const { ep } of dates) if (ep.ring.length > 0) outline = ep.ring;
    if (!outline) continue;

    const itemId = opts.newId();
    const series: ComparisonResult[] = opts.carry
      ? dates.map(({ capture, ep }) => {
          const v = ep.volumes[base];
          return {
            item: itemId,
            status: 'ok',
            cutM3: v.cut,
            fillM3: v.fill,
            netM3: v.net,
            totalM3: v.fill + v.cut,
            areaM2: ep.areaM2,
            areaCutM2: 0,
            areaFillM2: 0,
            areaUnchangedM2: 0,
            uncoveredM2: 0,
            fromLabel: KIT_BASE_LABEL[base],
            toLabel: capture.label,
            toCapture: ep.captureId,
            deadbandM: 0,
            usedDeadband: false,
            // The kit's 10 cm pile grids (0 would claim the exact TIN path).
            cellM: KIT_CELL_M,
            engine: 'ts',
            fingerprint: `kit:${pile.id}:${capture.epoch}:${base}`,
            computedAt: opts.now,
            carried: { from: 'kit', base, pile: pile.id, epoch: capture.epoch },
          };
        })
      : [];
    const last = series[series.length - 1];
    const headline = last?.carried?.epoch === lastEpoch ? last : undefined;
    const material = pile.material ? opts.materialId(pile.material) : undefined;

    const m: SurveyMeasurement = {
      id: opts.newId(),
      family: 'polygon',
      tool: 'volume',
      label: (pile.name || pile.id).slice(0, LABEL_MAX),
      folder: KIT_FOLDER,
      scope: { kind: 'site' },
      points: outline.map((xz) => opts.toSite(xz)),
      ...(material ? { material } : {}),
      items: [{ id: itemId, from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      results: headline ? [headline] : [],
      ...(opts.carry ? { series } : {}),
      origin: { kind: 'kit-pile', pile: pile.id },
      createdAt: opts.now,
    };
    added.push(m);
    converted.push(pile.id);
    done.add(pile.id);
  }
  return { added, converted };
}
