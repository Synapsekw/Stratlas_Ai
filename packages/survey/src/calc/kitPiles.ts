// Volumetric parity W3: the old stockpile kit's piles become engine volume measurements. The kit's
// stored figures are carried over unchanged as results labelled "From an earlier version (kit
// <base>)"; nothing here recomputes a volume. A build numbers its piles afresh, so a pile already
// converted is found again by its outline (`matchPiles`) and its measurement follows the new id.
import type {
  AuditEntry,
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
import { addKitOutlines, kitOutlines } from './outlines';

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
  /** The site material id for a kit material name, if one exists. */
  materialId: (name: string) => SurveyId | undefined;
  /**
   * The ground height at a site point on a kit date (the kit's DSM): a new pile's outline is
   * draped on the date whose toe line it is (`drapeZ`). Without it, or with no height under the
   * outline, its Z stays 0.
   */
  heightAt?: KitHeightAt;
  /**
   * Right after a volumetric build (Detect piles): a pile already converted comes back unless an
   * existing kit-pile measurement overlaps it, and a measurement whose pile is gone loses its link.
   * Without it (opening a project), a converted pile stays converted and every link is kept, so
   * moving a pile's outline never brings the pile back.
   */
  rebuilt?: boolean;
  /**
   * On opening only (not `rebuilt`): the project journal was read, and these are the kit piles
   * whose measurement the person deleted on purpose (`deliberatelyDeletedKitPiles`). A converted
   * pile no kit-pile measurement holds (no link to its number, no outline match) whose id is not
   * here vanished without a person deleting it, and is converted again, exactly as a first
   * conversion does (kit figures carried). Absent means no evidence (journal off, a package, a
   * failed read): a converted pile with no measurement stays gone, as before.
   */
  deletedKitPiles?: ReadonlySet<string>;
}

/**
 * One volume measurement per effective pile not in `file.kitPilesConverted`. carry=true sets each
 * date's result from the kit figure of `volumes.defaultBase` (series) and, only when the pile is
 * on the file's last capture, that date as results[0] (the kit's register showed a pile gone by
 * then as absent, so it gets no headline); carry=false adds the item only (the engine computes).
 * The outline (`points`) is the latest non-empty toe line, and `outlines` holds each date's own
 * (`kitOutlines`), so every date's figure is worked out inside that date's toe line. A duplicate
 * pile id converts once, the first.
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
    let outline: { ring: PileEpoch['ring']; epoch: string } | undefined;
    for (const { capture, ep } of dates)
      if (ep.ring.length > 0) outline = { ring: ep.ring, epoch: capture.epoch };
    if (!outline) return [];
    const flat = outline.ring.map((xz) => opts.toSite(xz));
    const ring: Ring2 = flat.map((p) => [p[0], p[1]] as const);
    return [{ pile, dates, flat, epoch: outline.epoch, ring, id: pile.id }];
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
  // After a build only (the kit numbers its piles afresh then): a number a relinked measurement
  // held is free; an unmatched measurement whose number a pile of this build carries lost its pile
  // (that pile is elsewhere): it keeps its figures, not the link. On opening, an unmatched
  // measurement is one the person moved: it keeps its link, and its pile is not added again.
  const freed = new Set(
    opts.rebuilt
      ? links.filter((l) => relinked.some((r) => r.id === l.m.id)).map((l) => l.pile)
      : [],
  );
  const matched = new Set([...match.values()].map((l) => l.m.id));
  const built = new Set(piles.map((p) => p.id));
  const detached = opts.rebuilt
    ? links.filter((l) => !matched.has(l.m.id) && built.has(l.pile)).map((l) => l.m.id)
    : [];
  for (const l of links) if (detached.includes(l.m.id)) freed.add(l.pile);

  for (const { pile, dates, flat, epoch, ring } of piles) {
    if (match.has(pile.id)) {
      if (!done.has(pile.id)) converted.push(pile.id);
      done.add(pile.id);
      continue;
    }
    // converted before and its number not freed: on opening, its measurement is gone. It stays
    // gone unless the journal was read (`deletedKitPiles`) and shows no deliberate deletion of it
    // and no measurement holds its number: then it vanished (a lost write, an old build's bug)
    // and is restored, with its kit figures carried as at a first conversion. After a build, only
    // a pile an existing kit-pile measurement overlaps is skipped (a pile the person deleted can
    // come back, never a new pile under an old number).
    let restored = false;
    if (done.has(pile.id) && !freed.has(pile.id)) {
      if (!opts.rebuilt) {
        const evidence = opts.deletedKitPiles;
        if (!evidence || evidence.has(pile.id) || links.some((l) => l.pile === pile.id)) continue;
        restored = true;
      } else if (links.some((l) => overlapShare(ring, l.ring) >= SAME_PILE_SHARE)) continue;
    }
    const carry = opts.carry || restored;

    const heightAt = opts.heightAt;
    const z = heightAt ? drapeZ(flat, (e, n) => heightAt(epoch, e, n)) : null;
    const site: SitePoint[] = z ? flat.map((p, i): SitePoint => [p[0], p[1], z[i] ?? p[2]]) : flat;
    const itemId = opts.newId();
    const series: ComparisonResult[] = carry
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
    const outlines = kitOutlines(pile, volumes, opts.toSite, heightAt);

    const m: SurveyMeasurement = {
      id: opts.newId(),
      family: 'polygon',
      tool: 'volume',
      label: (pile.name || pile.id).slice(0, LABEL_MAX),
      folder: KIT_FOLDER,
      scope: { kind: 'site' },
      points: site,
      ...(outlines.length > 0 ? { outlines } : {}),
      ...(material ? { material } : {}),
      items: [{ id: itemId, from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      results: headline ? [headline] : [],
      ...(carry ? { series } : {}),
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
 * as `@aio/volumetric`'s `localToEN` places it. The kit keeps no toe heights per vertex, so Z is
 * the caller's (a height sampled from the kit's DSM, `drapeZ`), else 0.
 */
export function kitToSite(
  origin: readonly number[],
  xz: readonly [number, number],
  z = 0,
): SitePoint {
  return [xz[0] + (origin[0] ?? 0), (origin[1] ?? 0) - xz[1], z];
}

/** The ground height at a site point (E, N) on a kit date (by epoch), or null where there is none. */
export type KitHeightAt = (epoch: string, e: number, n: number) => number | null;

/**
 * Heights for an outline's vertices from a surface: a vertex with no height takes the previous
 * vertex's, leading misses take the first one found. Null when no vertex has a height (a
 * non-finite height counts as none).
 */
export function drapeZ(
  points: readonly SitePoint[],
  at: (e: number, n: number) => number | null,
): number[] | null {
  const raw = points.map((p) => {
    const h = at(p[0], p[1]);
    return h !== null && Number.isFinite(h) ? h : null;
  });
  const first = raw.find((h): h is number => h !== null);
  if (first === undefined) return null;
  let prev = first;
  return raw.map((h) => (prev = h ?? prev));
}

/**
 * The kit date (epoch) a converted pile's figures are from: its headline's, else the latest
 * carried date in its series. Null when it carries none.
 */
export function kitEpochOf(m: SurveyMeasurement): string | null {
  const head = m.results[0]?.carried?.epoch;
  if (head !== undefined) return head;
  const series = m.series ?? [];
  for (let i = series.length - 1; i >= 0; i--) {
    const epoch = series[i]?.carried?.epoch;
    if (epoch !== undefined) return epoch;
  }
  return null;
}

/**
 * Whether a converted kit pile still lies at height 0 from a conversion made before heights
 * (every vertex Z exactly 0) and has not been repaired yet. A pile with any vertex off 0 was
 * edited by a person and is never re-heighted. The project origin's height says nothing here: a
 * kit import puts it at the lowest DSM height floored, 0 on a site near sea level, where Z 0 is
 * still wrong; a repair whose ground is 0 everywhere changes nothing (the caller skips it).
 */
export function needsHeightRepair(m: SurveyMeasurement, file: MeasurementsFile): boolean {
  if (m.origin?.kind !== 'kit-pile') return false;
  if (!m.points.every((p) => p[2] === 0)) return false;
  return !(file.kitHeightsRepaired ?? []).includes(m.id);
}

/**
 * `file` with the Z of the measurements given set (by id; heights per vertex, in order) and their
 * ids added to `kitHeightsRepaired` once. An id whose heights do not match its points in number,
 * or are not all finite, is skipped. Nothing else changes: not `updatedAt`, `pickedOn`, `results`,
 * `series` or `previousResults` (a repair is not an edit). The same file when nothing is repaired.
 */
export function repairKitHeights(
  file: MeasurementsFile,
  heights: ReadonlyMap<string, readonly number[]>,
): { file: MeasurementsFile; repaired: string[] } {
  const repaired: string[] = [];
  const measurements = file.measurements.map((m) => {
    const z = heights.get(m.id);
    if (z?.length !== m.points.length || !z.every((h) => Number.isFinite(h))) return m;
    repaired.push(m.id);
    return { ...m, points: m.points.map((p, i): SitePoint => [p[0], p[1], z[i] ?? p[2]]) };
  });
  if (repaired.length === 0) return { file, repaired };
  const listed = file.kitHeightsRepaired ?? [];
  const known = new Set(listed);
  return {
    file: {
      ...file,
      measurements,
      kitHeightsRepaired: [...listed, ...repaired.filter((id) => !known.has(id))],
    },
    repaired,
  };
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
  /** The kit's DSM heights: converted outlines are draped on them (`KitConversionOptions`). */
  heightAt?: KitHeightAt;
  /**
   * The journal was read: the kit piles deliberately deleted (`KitConversionOptions`). Only the
   * app's own open passes it; the report and the assistant keep the old rule (a vanished pile
   * stays gone) and read the file the app repaired.
   */
  deletedKitPiles?: ReadonlySet<string>;
}

// ---------------------------------------------------------------- the kit's density

/** The name a kit pile's material reads when the kit names none. */
export const KIT_MATERIAL_NAME = 'Stockpile material';

/** What a kit pile weighs by: the kit's density, and each pile's material name (by pile id). */
export interface KitDensity {
  densityTPerM3: number;
  names: Readonly<Record<string, string>>;
}

/** The kit's density and material names, or null without kit data. */
export function kitDensity(
  volumes: Pick<VolumesFile, 'densityTPerM3' | 'piles'> | null | undefined,
): KitDensity | null {
  if (!volumes) return null;
  const names: Record<string, string> = {};
  for (const p of volumes.piles) {
    const name = p.material?.trim();
    if (name && !(p.id in names)) names[p.id] = name.slice(0, 120);
  }
  return { densityTPerM3: volumes.densityTPerM3, names };
}

/**
 * The material a measurement is weighed by: the site material it names, else, for a pile carried
 * over from the kit (`origin` kit-pile), the kit's density under the kit's material name, worked
 * out at read time and never stored. Null when there is neither. The card, the Volumes view and its
 * CSV, the 3D callouts, the calculators and the report all read it here, so they agree.
 */
export function pileMaterial(
  m: Pick<SurveyMeasurement, 'material' | 'origin'>,
  materials: readonly SiteMaterial[],
  kit: KitDensity | null | undefined,
): SiteMaterial | null {
  const own = m.material ? materials.find((x) => x.id === m.material) : undefined;
  if (own) return own;
  if (m.origin?.kind !== 'kit-pile' || !kit) return null;
  return {
    id: 'kit',
    name: kit.names[m.origin.pile] ?? KIT_MATERIAL_NAME,
    densityTPerM3: kit.densityTPerM3,
  };
}

/**
 * Kit piles as volume measurements (`convertKitPiles`), placed through the project origin and,
 * with `heightAt`, draped on the kit DSM of the date whose outline each one is.
 */
export function kitConversion(
  file: MeasurementsFile,
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
  carry: boolean,
  opts: KitOpenOptions,
): KitConversion {
  const byName = new Map(opts.materials.map((x) => [x.name.trim().toLowerCase(), x.id]));
  return convertKitPiles(volumes, edits, file, {
    carry,
    now: opts.now,
    newId: opts.newId,
    toSite: (xz) => kitToSite(opts.origin, xz),
    materialId: (name) => byName.get(name.trim().toLowerCase()),
    ...(opts.rebuilt ? { rebuilt: true } : {}),
    ...(opts.heightAt ? { heightAt: opts.heightAt } : {}),
    ...(opts.deletedKitPiles ? { deletedKitPiles: opts.deletedKitPiles } : {}),
  });
}

/**
 * The converted kit piles (`kitPilesConverted`) of this build that no kit-pile measurement holds
 * (no link to the pile's number and no outline match, `matchPiles`): on opening they would stay
 * gone without journal evidence, so only when this is not empty is the journal worth reading
 * (`deliberatelyDeletedKitPiles`). Cheap when every converted pile's number is held.
 */
export function vanishedKitPiles(
  file: MeasurementsFile,
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
  origin: readonly number[],
): string[] {
  const listed = new Set(file.kitPilesConverted ?? []);
  if (listed.size === 0) return [];
  const held = new Set(
    file.measurements.flatMap((m) => (m.origin?.kind === 'kit-pile' ? [m.origin.pile] : [])),
  );
  if (volumes.piles.every((p) => !listed.has(p.id) || held.has(p.id))) return [];
  let n = 0;
  const probe = convertKitPiles(volumes, edits, file, {
    carry: false,
    now: '1970-01-01T00:00:00.000Z',
    newId: () => `probe-${String(++n)}`,
    toSite: (xz) => kitToSite(origin, xz),
    materialId: () => undefined,
    deletedKitPiles: new Set(),
  });
  return probe.added.flatMap((m) =>
    m.origin?.kind === 'kit-pile' && listed.has(m.origin.pile) ? [m.origin.pile] : [],
  );
}

/** The journal entry fields `deliberatelyDeletedKitPiles` reads (`journal:history` rows). */
export type KitJournalEntry = Pick<
  AuditEntry,
  'op' | 'hlc' | 'kind' | 'target' | 'how' | 'label' | 'changes'
>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The kit pile a measurement's `origin` names, if it is a kit pile's. */
const kitPileOf = (origin: unknown): string | undefined =>
  isObj(origin) && origin.kind === 'kit-pile' && typeof origin.pile === 'string'
    ? origin.pile
    : undefined;

/**
 * A deletion the person made on purpose: by hand or through the assistant, and unlabelled. The
 * app labels its automatic writes (its migrations `audit.migration.*`, a refused write's undo
 * "Not saved, change undone"), and a file changed outside the app reads `external`.
 */
const deliberate = (e: KitJournalEntry): boolean =>
  (e.how === 'hand' || e.how === 'agent') && e.label === undefined;

/**
 * The kit piles whose measurement the person deliberately deleted, from the project journal's
 * measurement entries (any order; `journal:history` gives them newest first). A measurement is
 * the kit pile its create entry's record names (`origin` kit-pile), as later patches setting
 * `origin` relink it (a rebuild renumbers piles), as it stood just before the delete. A pile a
 * later entry links a measurement to again (a build added it back) is held again, not deleted.
 * A measurement whose create the journal does not hold names no pile.
 */
export function deliberatelyDeletedKitPiles(entries: readonly KitJournalEntry[]): Set<string> {
  const ordered = entries
    .filter((e) => e.target.rec === 'measurement')
    .sort((a, b) =>
      a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.op < b.op ? -1 : a.op > b.op ? 1 : 0,
    );
  const pileOf = new Map<string, string | undefined>();
  const deleted = new Set<string>();
  const link = (id: string, pile: string | undefined) => {
    pileOf.set(id, pile);
    if (pile !== undefined) deleted.delete(pile);
  };
  for (const e of ordered) {
    const id = e.target.id;
    if (e.kind === 'measurement.create') {
      const record = e.changes?.find((c) => c.field === 'record')?.after;
      link(id, isObj(record) ? kitPileOf(record.origin) : undefined);
    } else if (e.kind === 'measurement.patch') {
      const change = e.changes?.find((c) => c.field === 'origin');
      if (change) link(id, kitPileOf(change.after));
    } else if (e.kind === 'measurement.delete') {
      const pile = pileOf.get(id);
      pileOf.delete(id);
      if (pile !== undefined && deliberate(e)) deleted.add(pile);
    }
  }
  return deleted;
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
 * an old project's kit data; a read-only one is left as it is. With `deletedKitPiles` (the app's
 * open, the journal read), a converted pile whose measurement vanished without a deliberate
 * deletion is converted again. The same file when nothing changes.
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
  const converted = !changesFile(c) && !carry ? file : withKitConversion(file, c);
  // piles converted before per-date outlines get theirs once (read-only: in memory only)
  return addKitOutlines(converted, kit.volumes, kit.edits, {
    toSite: (xz) => kitToSite(opts.origin, xz),
    ...(opts.heightAt ? { heightAt: opts.heightAt } : {}),
  }).file;
}
