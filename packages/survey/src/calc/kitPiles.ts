// Volumetric parity W3: the old stockpile kit's piles become engine volume measurements. The kit's
// stored figures are carried over unchanged as results labelled "From an earlier version (kit
// <base>)"; nothing here recomputes a volume. A build numbers its piles afresh, so a pile already
// converted is found again by its outline (`matchPiles`) and its measurement follows the new id.
import type {
  BoundaryEdit,
  BoundaryEditsFile,
  ComparisonResult,
  MeasurementsFile,
  PileEpoch,
  SiteMaterial,
  SitePoint,
  StockPile,
  SurveyId,
  SurveyMeasurement,
  VolumeBaseId,
  VolumesFile,
} from '@aio/schema';

/** The Datasets folder converted kit piles land in. */
export const KIT_FOLDER = 'Stockpiles';

/**
 * The kit bases by their plain names, as a carried figure's stored labels name them (the app
 * names them through the en.ts `base.*` keys, `kitBaseName`).
 */
export const KIT_BASE_LABEL: Readonly<Record<VolumeBaseId, string>> = {
  tin: 'Triangulated',
  plane: 'Best-fit plane',
  avg: 'Average edge level',
  low: 'Lowest point',
};

/** A kit base's plain name; an id this build does not know (a later build's) as it is. */
export const kitBaseLabel = (base: string): string =>
  (KIT_BASE_LABEL as Readonly<Record<string, string>>)[base] ?? base;

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
  /** Kit-pile measurements a rebuild renumbered: their `origin.pile` becomes `pile`. */
  relinked: { id: string; pile: string }[];
  /** Kit-pile measurements whose pile is gone and whose number another pile now has. */
  detached: string[];
}

/** The share of the smaller outline two piles must have in common to be one pile. */
export const SAME_PILE_SHARE = 0.5;
/** Samples per side of the grid `overlapShare` counts the common area on. */
const OVERLAP_GRID = 64;

type Ring2 = readonly (readonly [number, number])[];

function ringArea(r: Ring2): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const p = r[i];
    const q = r[j];
    if (p && q) a += (q[0] + p[0]) * (q[1] - p[1]);
  }
  return Math.abs(a) / 2;
}

function inRing(x: number, y: number, r: Ring2): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const p = r[i];
    const q = r[j];
    if (!p || !q) continue;
    if (p[1] > y !== q[1] > y && x < ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]) + p[0])
      inside = !inside;
  }
  return inside;
}

function bbox(r: Ring2): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of r) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/**
 * The area two outlines have in common over the smaller one's area (0 to 1), counted on a grid
 * over their common bounding box: close enough to tell one pile from its neighbour.
 */
export function overlapShare(a: Ring2, b: Ring2): number {
  if (a.length < 3 || b.length < 3) return 0;
  const smaller = Math.min(ringArea(a), ringArea(b));
  if (!(smaller > 0)) return 0;
  const [ax0, ay0, ax1, ay1] = bbox(a);
  const [bx0, by0, bx1, by1] = bbox(b);
  const x0 = Math.max(ax0, bx0);
  const y0 = Math.max(ay0, by0);
  const x1 = Math.min(ax1, bx1);
  const y1 = Math.min(ay1, by1);
  if (!(x1 > x0 && y1 > y0)) return 0;
  const dx = (x1 - x0) / OVERLAP_GRID;
  const dy = (y1 - y0) / OVERLAP_GRID;
  let n = 0;
  for (let i = 0; i < OVERLAP_GRID; i++) {
    const x = x0 + (i + 0.5) * dx;
    for (let j = 0; j < OVERLAP_GRID; j++) {
      const y = y0 + (j + 0.5) * dy;
      if (inRing(x, y, a) && inRing(x, y, b)) n++;
    }
  }
  return Math.min(1, (n * dx * dy) / smaller);
}

/** Whether a conversion changes the file (a measurement added, relinked or detached, an id). */
export const changesFile = (c: KitConversion): boolean =>
  c.added.length > 0 || c.converted.length > 0 || c.relinked.length > 0 || c.detached.length > 0;

interface KitLink {
  m: SurveyMeasurement;
  pile: string;
  ring: Ring2;
}

/**
 * Which existing kit-pile measurement each built pile is (C1): a build numbers its piles afresh,
 * so a pile is matched by outline. First a pile and the measurement holding its number, when they
 * overlap; then the closest overlap left (at least `SAME_PILE_SHARE` of the smaller outline).
 * A number alone never matches. One measurement per pile.
 */
function matchPiles(
  piles: readonly { id: string; ring: Ring2 }[],
  links: readonly KitLink[],
): Map<string, KitLink> {
  const match = new Map<string, KitLink>();
  const taken = new Set<KitLink>();
  const holder = new Map<string, KitLink>();
  for (const l of links) if (!holder.has(l.pile)) holder.set(l.pile, l);
  for (const p of piles) {
    const l = holder.get(p.id);
    if (l && overlapShare(p.ring, l.ring) >= SAME_PILE_SHARE) {
      match.set(p.id, l);
      taken.add(l);
    }
  }
  const pairs: { p: string; l: KitLink; share: number }[] = [];
  for (const p of piles) {
    if (match.has(p.id)) continue;
    for (const l of links) {
      if (taken.has(l)) continue;
      const share = overlapShare(p.ring, l.ring);
      if (share >= SAME_PILE_SHARE) pairs.push({ p: p.id, l, share });
    }
  }
  pairs.sort((x, y) => y.share - x.share);
  for (const { p, l } of pairs) {
    if (match.has(p) || taken.has(l)) continue;
    match.set(p, l);
    taken.add(l);
  }
  return match;
}

export interface KitConversionOptions {
  /** Carry the kit figures over as stored results; false adds the items only (the engine computes). */
  carry: boolean;
  now: string;
  newId: () => string;
  /** A kit local-frame point (`[x, z]`, x east, z south) to the project CRS `[E, N, Z]`. */
  toSite: (xz: readonly [number, number]) => SitePoint;
  /** The site material id for a kit material name (null: the pile names none), if any. */
  materialId: (name: string | null) => SurveyId | undefined;
  /**
   * Right after a volumetric build (Detect piles): a pile already converted comes back unless an
   * existing kit-pile measurement overlaps it. Without it (opening a project), it stays converted.
   */
  rebuilt?: boolean;
}

/**
 * One volume measurement per effective pile not in `file.kitPilesConverted`. carry=true sets each
 * date's result from the kit figure of `volumes.defaultBase` (series) and, only when the pile is
 * on the file's last capture, that date as results[0] (the kit's register showed a pile gone by
 * then as absent, so it gets no headline); carry=false adds the item only (the engine computes).
 * The outline is the latest non-empty toe line. A duplicate pile id converts once, the first.
 * A pile that overlaps an existing kit-pile measurement (`matchPiles`) is that measurement: it is
 * relinked to the pile's new id, never added again.
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

  // Each pile once (a duplicate id converts once, the first), with the dates it is on, in survey
  // order, and its latest non-empty toe line: a pile with none has nothing to draw.
  const seen = new Set<string>();
  const piles = applyEdits(volumes, edits?.edits ?? []).flatMap((pile) => {
    if (seen.has(pile.id)) return [];
    seen.add(pile.id);
    const dates = volumes.captures.flatMap((c) => {
      const ep = pile.epochs[c.epoch];
      return ep ? [{ capture: c, ep }] : [];
    });
    let outline: PileEpoch['ring'] | undefined;
    for (const { ep } of dates) if (ep.ring.length > 0) outline = ep.ring;
    if (!outline) return [];
    const site = outline.map((xz) => opts.toSite(xz));
    const ring: Ring2 = site.map((p) => [p[0], p[1]] as const);
    return [{ pile, dates, site, ring, id: pile.id }];
  });

  // The kit-pile measurements already made, matched to this build's piles by outline (C1).
  const links: KitLink[] = file.measurements.flatMap((m) =>
    m.origin?.kind === 'kit-pile'
      ? [{ m, pile: m.origin.pile, ring: m.points.map((p) => [p[0], p[1]] as const) }]
      : [],
  );
  const match = matchPiles(piles, links);
  const relinked: { id: string; pile: string }[] = [];
  for (const [pile, l] of match) if (l.pile !== pile) relinked.push({ id: l.m.id, pile });
  // a number a relinked measurement held is free; an unmatched measurement whose number a pile of
  // this build carries lost its pile (that pile is elsewhere): it keeps its figures, not the link
  const freed = new Set(
    links.filter((l) => relinked.some((r) => r.id === l.m.id)).map((l) => l.pile),
  );
  const matched = new Set([...match.values()].map((l) => l.m.id));
  const built = new Set(piles.map((p) => p.id));
  const detached = links
    .filter((l) => !matched.has(l.m.id) && built.has(l.pile))
    .map((l) => l.m.id);
  for (const l of links) if (detached.includes(l.m.id)) freed.add(l.pile);

  for (const { pile, dates, site, ring } of piles) {
    if (match.has(pile.id)) {
      if (!done.has(pile.id)) converted.push(pile.id);
      done.add(pile.id);
      continue;
    }
    // converted before and its number not freed: on opening, its measurement was deleted, so it
    // stays gone; after a build, only a pile an existing kit-pile measurement overlaps is skipped
    // (a pile the person deleted can come back, never a new pile under an old number)
    if (done.has(pile.id) && !freed.has(pile.id)) {
      if (!opts.rebuilt) continue;
      if (links.some((l) => overlapShare(ring, l.ring) >= SAME_PILE_SHARE)) continue;
    }

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
    const material = opts.materialId(pile.material ?? null);

    const m: SurveyMeasurement = {
      id: opts.newId(),
      family: 'polygon',
      tool: 'volume',
      label: (pile.name || pile.id).slice(0, LABEL_MAX),
      folder: KIT_FOLDER,
      scope: { kind: 'site' },
      points: site,
      ...(material ? { material } : {}),
      items: [{ id: itemId, from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      results: headline ? [headline] : [],
      ...(opts.carry ? { series } : {}),
      origin: { kind: 'kit-pile', pile: pile.id },
      createdAt: opts.now,
    };
    added.push(m);
    if (!done.has(pile.id)) converted.push(pile.id);
    done.add(pile.id);
  }
  return { added, converted, relinked, detached };
}

// ---------------------------------------------------------------- opening a project

/**
 * A kit local-frame point (`[x, z]`: x east, z south of the project origin) in the project CRS,
 * as `@aio/volumetric`'s `localToEN` places it. Z is 0: the kit keeps no toe heights per vertex
 * (the 3D draping is display only).
 */
export function kitToSite(origin: readonly number[], xz: readonly [number, number]): SitePoint {
  return [xz[0] + (origin[0] ?? 0), (origin[1] ?? 0) - xz[1], 0];
}

export interface KitOpenOptions {
  /** The project origin (`manifest.origin`) the kit's local frame hangs from. */
  origin: readonly number[];
  /** The site materials: a kit material name finds its id (case and spaces ignored). */
  materials: readonly { id: SurveyId; name: string }[];
  now: string;
  newId: () => string;
  /** Right after a volumetric build (`KitConversionOptions.rebuilt`). */
  rebuilt?: boolean;
}

// ---------------------------------------------------------------- the kit's density

/** The id of the material a kit pile gets when no site material has its material's name. */
export const KIT_MATERIAL_ID = 'kit-material';
/** That material's name when the kit pile names no material. */
export const KIT_MATERIAL_NAME = 'Stockpile material';

const nameKey = (name: string): string => name.trim().toLowerCase();

/** The kit material id for a kit material name (null or blank: the one unnamed kit material). */
export function kitMaterialId(name: string | null): SurveyId {
  const slug = nameKey(name ?? '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `${KIT_MATERIAL_ID}-${slug}` : KIT_MATERIAL_ID;
}

/**
 * The site materials the kit's piles need and the site does not have: one per kit material name
 * (or none) that no site material has, at the kit's density (`volumes.densityTPerM3`), so an old
 * project keeps its tonnes. Held in memory with the settings (`withKitMaterials`); saving the site
 * settings keeps them.
 */
export function kitMaterials(
  volumes: VolumesFile,
  materials: readonly { id: SurveyId; name: string }[],
): SiteMaterial[] {
  const named = new Set(materials.map((x) => nameKey(x.name)));
  const out = new Map<SurveyId, SiteMaterial>();
  for (const p of volumes.piles) {
    const name = p.material?.trim() ? p.material.trim() : null;
    if (name && named.has(nameKey(name))) continue;
    const id = kitMaterialId(name);
    if (!out.has(id))
      out.set(id, {
        id,
        name: (name ?? KIT_MATERIAL_NAME).slice(0, 120),
        densityTPerM3: volumes.densityTPerM3,
      });
  }
  return [...out.values()];
}

/**
 * The site settings with the kit materials the measurements use (`kitMaterials`) added after the
 * site's own; the same settings when none is missing or there is no kit data.
 */
export function withKitMaterials<S extends { materials: readonly SiteMaterial[] }>(
  settings: S,
  volumes: VolumesFile | null,
  measurements: readonly SurveyMeasurement[],
): S {
  if (!volumes) return settings;
  const have = new Set(settings.materials.map((x) => x.id));
  const used = new Set(measurements.flatMap((m) => (m.material ? [m.material] : [])));
  const add = kitMaterials(volumes, settings.materials).filter(
    (x) => used.has(x.id) && !have.has(x.id),
  );
  return add.length === 0 ? settings : { ...settings, materials: [...settings.materials, ...add] };
}

/** Kit piles as volume measurements (`convertKitPiles`), placed through the project origin. */
export function kitConversion(
  file: MeasurementsFile,
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
  carry: boolean,
  opts: KitOpenOptions,
): KitConversion {
  const byName = new Map(opts.materials.map((x) => [nameKey(x.name), x.id]));
  return convertKitPiles(volumes, edits, file, {
    carry,
    now: opts.now,
    newId: opts.newId,
    toSite: (xz) => kitToSite(opts.origin, xz),
    // a site material by the kit material's name, else the kit's own density (`kitMaterials`)
    materialId: (name) => (name ? byName.get(nameKey(name)) : undefined) ?? kitMaterialId(name),
    ...(opts.rebuilt ? { rebuilt: true } : {}),
  });
}

/**
 * `file` with a conversion's measurements and pile ids added (`kitPilesConverted` always set), its
 * renumbered piles relinked and the measurements of piles gone detached (no `origin`).
 */
export function withKitConversion(file: MeasurementsFile, c: KitConversion): MeasurementsFile {
  const relink = new Map(c.relinked.map((r) => [r.id, r.pile]));
  const detached = new Set(c.detached);
  const measurements = file.measurements.map((m) => {
    const pile = relink.get(m.id);
    if (pile !== undefined && m.origin) return { ...m, origin: { ...m.origin, pile } };
    if (!detached.has(m.id)) return m;
    const rest = { ...m };
    delete rest.origin;
    return rest;
  });
  return {
    ...file,
    measurements: [...measurements, ...c.added],
    kitPilesConverted: [...(file.kitPilesConverted ?? []), ...c.converted],
  };
}

/**
 * The measurements file as it opens (the app, the report and the assistant alike): kit piles not
 * converted yet added, their kit figures carried only when the file has never been converted
 * (`kitPilesConverted` absent: an old project). A writable project with no kit figures yet (the
 * wizard's, before its build) is marked converted, so a build run on it later is never taken for
 * an old project's kit data; a read-only one is left as it is. The same file when nothing changes.
 */
export function openWithKitPiles(
  file: MeasurementsFile,
  kit: { volumes: VolumesFile | null; edits: BoundaryEditsFile | null },
  opts: KitOpenOptions & { readOnly: boolean },
): MeasurementsFile {
  if (!kit.volumes) {
    if (file.kitPilesConverted === undefined && !opts.readOnly)
      return { ...file, kitPilesConverted: [] };
    return file;
  }
  const carry = file.kitPilesConverted === undefined;
  const c = kitConversion(file, kit.volumes, kit.edits, carry, opts);
  if (!changesFile(c) && !carry) return file;
  return withKitConversion(file, c);
}
