// The house-format report (PRD BLD-8): everything the full project report shows, for any project
// type, ready to lay out. Pure and renderer safe; wording lives in the report page (i18n).
import {
  reportSectionOn,
  type Issue,
  type IssuePagesRule,
  type Layer,
  type ProjectManifest,
  type ReportContentsSettings,
  type ReportSectionId,
  type RoadModel,
} from '@aio/schema';
import { issueLocation, noDashes, severityModelOf, type ExportContext } from './facts';
import type { ProcessingSummary } from './processing';
import { RUN_SECTIONS, SURVEY_SECTIONS } from './surveyCsv';
import { reportModel, type ReportBranding, type ReportModel, type ReportRow } from './report';

export type HouseKind = 'inspection' | 'volumetric' | 'road' | 'fusion';

export interface HouseInput extends ExportContext {
  branding: ReportBranding;
  contents?: ReportContentsSettings | undefined;
  /**
   * The site inventory of the volume measurements, from their engine results by the Volumes
   * view's rule (the caller works it out: `@aio/survey` `inventorySeries`); null without any.
   */
  volumes?: HouseVolumes | null | undefined;
  road?: RoadModel | null | undefined;
  now?: Date;
  /** M9: the audit head and the change log per issue, from the project journal. */
  audit?: AuditSummary | null | undefined;
  /** M10: the accuracy of the project's latest finished processing run (photogrammetry). */
  processing?: ProcessingSummary | null | undefined;
  /**
   * M11: the survey sections that have something to print (`SURVEY_SECTIONS`, and `RUN_SECTIONS`
   * for a project with haul-road or hydrology runs).
   */
  surveySections?: readonly ReportSectionId[] | undefined;
}

/**
 * What a report prints of the audit trail (M9 T1): the audit head (Merkle root over every chain's
 * head), the entry count and whether Verify found the history intact, plus the changes per issue
 * (newest first, capped by the caller). A later rewrite of history contradicts reports already
 * delivered.
 */
export interface AuditSummary {
  root: string;
  count: number;
  verified: boolean;
  /** One row per change of an issue the report covers. */
  rows: { code: string; at: string; who: string; change: string }[];
  /** Changes left out by the cap. */
  more: number;
}

/** A layer of the project as the report lists it under site and data. */
export interface DataRow {
  kind: Layer['kind'];
  name: string;
  /** Photos, panoramas: items; point clouds: points (when known); walks: minutes. */
  count: number | null;
  /** Rasters: ortho, dsm or plan. */
  role: string | null;
}

export interface DataTotals {
  photos: number;
  panoramas: number;
  videos: number;
  meshes: number;
  clouds: number;
  points: number;
  rasters: number;
  vectors: number;
  /** 360 video walks, and their total length in whole minutes (rounded). */
  walks: number;
  walkMinutes: number;
}

export interface ScaleRow {
  model: string;
  levels: { value: number; label: string; color: string; criteria: string; action: string }[];
  uncertain: { label: string; color: string } | null;
}

/**
 * The site inventory a report summarises (volumetric parity W4): the volume measurements' engine
 * results, a total per survey date of the current figures only (the rest named, never added).
 */
export interface HouseVolumes {
  /** The piles' bases by their standard names ("Triangulated toe"), joined when they differ. */
  base: string;
  /** Volume measurements in the inventory. */
  piles: number;
  /** The survey dates with counted piles, oldest first, and their totals, m³. */
  dates: { label: string; date: string; totalM3: number }[];
  /** The latest total's change since the date before with counted piles, over the piles on both. */
  changeM3: number | null;
  /** The latest date, its total, the change and the date that is since, in the site's units. */
  text: { date: string; total: string; change: string | null; since: string | null };
}

/** A survey date's row of the site inventory (`@aio/survey` `StackRow`, the fields read here). */
export interface InventoryDate {
  date: string;
  label: string;
  totalM3: number;
  parts: readonly unknown[];
  change?: { m3: number } | null;
}

/**
 * The house model's inventory from the Volumes view's rows (`inventorySeries`): the latest date's
 * total (current figures only) and its change since the date before with counted piles. `bases`
 * are the piles' base names; `volume` formats a volume in the site's units.
 */
export function houseVolumesOf(
  rows: readonly InventoryDate[],
  bases: readonly string[],
  volume: (m3: number) => string,
): HouseVolumes | null {
  if (bases.length === 0) return null;
  const cur = rows.at(-1);
  const prev = cur?.change ? rows.slice(0, -1).findLast((r) => r.parts.length > 0) : undefined;
  return {
    base: [...new Set(bases.filter((b) => b !== ''))].join(', '),
    piles: bases.length,
    dates: rows
      .filter((r) => r.parts.length > 0)
      .map((r) => ({ label: r.label, date: r.date, totalM3: r.totalM3 })),
    changeM3: cur?.change?.m3 ?? null,
    text: {
      date: cur?.date ?? '',
      total: cur && cur.parts.length > 0 ? volume(cur.totalM3) : '-',
      change: cur?.change ? volume(cur.change.m3) : null,
      since: prev?.date ?? null,
    },
  };
}

export interface RoadSummary {
  name: string;
  lengthKm: number;
  standard: string;
  headline: 'low' | 'medium' | 'high';
  networkPci: number | null;
  coveragePct: number | null;
  /** Sample units per rating class under the headline severity, best first. */
  ratings: { label: string; color: string; min: number; count: number }[];
  sections: { fromKm: number; toKm: number; pci: number | null; rating: string; color: string }[];
  units: number;
  /** Sample units with the lowest PCI, worst first. */
  worst: {
    id: string;
    km: number;
    pci: number;
    rating: string;
    color: string;
    distress: string;
  }[];
}

export interface PlanPoint {
  /** Issue id. */
  id: string;
  /** Local x (east) and z (south), metres. */
  x: number;
  z: number;
  /** Height (local y), metres; 0 for an issue placed on the map only. */
  y: number;
  color: string;
  code: string;
  /** Placed on the map only (no 3D position). */
  map: boolean;
}

export interface HouseModel {
  base: ReportModel;
  kind: HouseKind;
  /** Sections printed after the cover, in order. */
  sections: ReportSectionId[];
  issuePagesRule: IssuePagesRule;
  /** Rows that get a page of their own, in register order. */
  issuePages: ReportRow[];
  uncertain: ReportRow[];
  captures: { label: string; date: string }[];
  layers: DataRow[];
  totals: DataTotals;
  /** Issues with a 3D (or map) position, and with a photo. */
  placed: number;
  withPhoto: number;
  scale: ScaleRow[];
  volumes: HouseVolumes | null;
  road: RoadSummary | null;
  /** Issue positions for the findings map (local frame). */
  plan: PlanPoint[];
  /** M9: the audit head and change log; null for a project without a journal. */
  audit: AuditSummary | null;
  /** M10: the latest processing run's accuracy; null for a project without one. */
  processing: ProcessingSummary | null;
}

/** What kind of report to print: the builder type, else what the project holds. */
export function houseKind(
  m: ProjectManifest,
  issues: readonly Issue[],
  extra: { volumes?: unknown; road?: unknown },
): HouseKind {
  switch (m.type) {
    case 'inspection':
    case 'volumetric':
    case 'road':
    case 'fusion':
      return m.type;
    case 'twin':
      return 'fusion';
    case undefined:
      break;
  }
  if (extra.volumes) return 'volumetric';
  if (extra.road) return 'road';
  return issues.length > 0 ? 'inspection' : 'fusion';
}

/**
 * The issue page rule when the person has not chosen one: a road survey prints pages only above
 * the lowest level (a full Ring Road report with a page per defect runs to thousands of pages),
 * every other kind a page per issue.
 */
export function defaultIssuePages(kind: HouseKind): IssuePagesRule {
  return kind === 'road' ? 'above-lowest' : 'all';
}

const rank = (r: ReportRow) => (r.severity === 'uncertain' ? -1 : r.severity);

/** The lowest severity value of each model, for the `above-lowest` issue page rule. */
function lowestLevels(m: ProjectManifest): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of m.severityModels) {
    const low = s.levels[0];
    if (low) out.set(s.id, low.value);
  }
  return out;
}

/** The rows that get an issue page under `rule`; uncertain issues are listed in an appendix. */
export function issuePageRows(
  m: ProjectManifest,
  issues: readonly Issue[],
  rows: readonly ReportRow[],
  rule: IssuePagesRule,
): ReportRow[] {
  if (rule === 'none') return [];
  const graded = rows.filter((r) => r.severity !== 'uncertain');
  if (rule === 'all') return graded;
  const lowest = lowestLevels(m);
  const modelOf = new Map(issues.map((i) => [i.id, i.severityModelId]));
  return graded.filter((r) => {
    const low = lowest.get(modelOf.get(r.id) ?? '');
    return low === undefined || rank(r) > low;
  });
}

function dataRows(m: ProjectManifest): { layers: DataRow[]; totals: DataTotals } {
  const totals: DataTotals = {
    photos: 0,
    panoramas: 0,
    videos: 0,
    meshes: 0,
    clouds: 0,
    points: 0,
    rasters: 0,
    vectors: 0,
    walks: 0,
    walkMinutes: 0,
  };
  let walkSeconds = 0;
  const layers: DataRow[] = [];
  for (const l of m.layers) {
    // a Model builder preview nobody accepted is no project data (M8)
    if (l.derived?.draft) continue;
    let count: number | null = null;
    let role: string | null = null;
    switch (l.kind) {
      case 'photos':
        count = l.items.length;
        totals.photos += count;
        break;
      case 'panoramas':
        count = l.items.length;
        totals.panoramas += count;
        break;
      case 'video':
        totals.videos++;
        break;
      case 'walk':
        totals.walks++;
        walkSeconds += l.durationS;
        // the row's amount is the walk's length in minutes
        count = Math.round(l.durationS / 60);
        break;
      case 'mesh':
        totals.meshes++;
        break;
      case 'pointcloud':
        count = l.pointCount ?? null;
        totals.clouds++;
        totals.points += l.pointCount ?? 0;
        break;
      case 'raster':
        role = l.role;
        totals.rasters++;
        break;
      case 'vector':
        totals.vectors++;
        break;
      case 'basemap':
      case 'legacy':
        // the offline viewer and street maps are not survey data
        continue;
    }
    layers.push({ kind: l.kind, name: noDashes(l.name), count, role });
  }
  totals.walkMinutes = Math.round(walkSeconds / 60);
  return { layers, totals };
}

function scaleRows(m: ProjectManifest, issues: readonly Issue[]): ScaleRow[] {
  const used = new Set(issues.map((i) => i.severityModelId));
  return m.severityModels
    .filter((s) => used.size === 0 || used.has(s.id))
    .map((s) => ({
      model: noDashes(s.name),
      levels: [...s.levels].reverse().map((l) => ({
        value: l.value,
        label: noDashes(l.label),
        color: l.color,
        criteria: noDashes(l.criteria),
        action: noDashes(l.action ?? ''),
      })),
      uncertain: s.uncertain
        ? { label: noDashes(s.uncertain.label), color: s.uncertain.color }
        : null,
    }));
}

/** The recommended action for an issue: its severity level's action, else its criteria. */
export function issueAction(m: ProjectManifest, issue: Issue): string {
  if (issue.severity === 'uncertain') return '';
  const level = severityModelOf(m, issue)?.levels.find((l) => l.value === issue.severity);
  return noDashes(level?.action ?? level?.criteria ?? '');
}

/** The rating class a PCI value falls in (ratings are highest `min` first). */
export function pciRating(
  ratings: RoadModel['pci']['ratings'],
  pci: number | null,
): { label: string; color: string } {
  if (pci === null) return { label: '', color: '#8a94a6' };
  const r = ratings.find((x) => pci >= x.min) ?? ratings.at(-1);
  return { label: noDashes(r?.label ?? ''), color: r?.color ?? '#8a94a6' };
}

function roadSummary(r: RoadModel): RoadSummary {
  const h = r.pci.headline;
  const counts = new Map<string, number>();
  for (const u of r.pci.units) {
    const label = pciRating(r.pci.ratings, u.pci[h]).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const worst = r.pci.units
    .filter((u) => u.pci[h] !== null)
    .sort((a, b) => (a.pci[h] ?? 0) - (b.pci[h] ?? 0))
    .slice(0, 12)
    .map((u) => {
      const top = [...u.deducts].sort((a, b) => b.deduct - a.deduct)[0];
      const rating = pciRating(r.pci.ratings, u.pci[h]);
      return {
        id: u.id,
        km: u.km,
        pci: u.pci[h] ?? 0,
        rating: rating.label,
        color: rating.color,
        distress: noDashes((top?.distress ?? '').replace(/_/g, ' ')),
      };
    });
  return {
    name: noDashes(r.name),
    lengthKm: r.centreline.lengthKm,
    standard: noDashes(r.pci.standard),
    headline: h,
    networkPci: r.pci.network[h],
    coveragePct: r.pci.coveragePct ?? null,
    ratings: r.pci.ratings.map((x) => ({
      label: noDashes(x.label),
      color: x.color,
      min: x.min,
      count: counts.get(noDashes(x.label)) ?? 0,
    })),
    sections: r.pci.sections.map((s) => {
      const rating = pciRating(r.pci.ratings, s.pci[h]);
      return {
        fromKm: s.fromKm,
        toKm: s.toKm,
        pci: s.pci[h],
        rating: rating.label,
        color: rating.color,
      };
    }),
    units: r.pci.units.length,
    worst,
  };
}

/** Everything the house-format report shows. Text has no em or en dashes. */
/**
 * The sections the house report prints, in order (Settings lists these). `audit` (M9 T1) prints
 * only for a project with a journal; `approvals` joins when T3 prints it; `processing` (M10)
 * only for a project with a finished photogrammetry run; the survey sections (M11) only for a
 * project with survey measurements of their kind, the haul-road and hydrology ones with runs.
 */
export const HOUSE_SECTIONS = [
  'contents',
  'summary',
  'scope',
  'site',
  'processing',
  ...SURVEY_SECTIONS,
  ...RUN_SECTIONS,
  'statistics',
  'register',
  'issues',
  'approvals',
  'audit',
  'appendices',
] as const satisfies readonly ReportSectionId[];

export function houseReportModel(input: HouseInput): HouseModel {
  const m = input.manifest;
  const base = reportModel(input, {
    branding: input.branding,
    ...(input.now ? { now: input.now } : {}),
  });
  const kind = houseKind(m, input.issues, { volumes: input.volumes, road: input.road });
  const rule = input.contents?.issuePages ?? defaultIssuePages(kind);
  const issuePages = issuePageRows(m, input.issues, base.rows, rule);
  const sections = HOUSE_SECTIONS.filter(
    (id) =>
      reportSectionOn(input.contents, id) &&
      (id !== 'issues' || issuePages.length > 0) &&
      (id !== 'audit' || Boolean(input.audit)) &&
      (id !== 'processing' || Boolean(input.processing)) &&
      (!([...SURVEY_SECTIONS, ...RUN_SECTIONS] as readonly ReportSectionId[]).includes(id) ||
        Boolean(input.surveySections?.includes(id))),
  );
  const { layers, totals } = dataRows(m);
  const plan: PlanPoint[] = [];
  const byId = new Map(input.issues.map((i) => [i.id, i]));
  for (const r of base.rows) {
    if (r.position) {
      const [x, y, z] = r.position;
      plan.push({ id: r.id, x, y, z, color: r.severityColor, code: r.code, map: false });
      continue;
    }
    // placed on the map only: back to the local frame from the project CRS
    const issue = byId.get(r.id);
    const loc = issue ? issueLocation(m, issue, input.shiftOf) : null;
    if (loc) {
      const x = loc.project[0] - m.origin[0];
      const z = m.origin[1] - loc.project[1];
      plan.push({ id: r.id, x, y: 0, z, color: r.severityColor, code: r.code, map: true });
    }
  }
  return {
    base,
    kind,
    sections,
    issuePagesRule: rule,
    issuePages,
    uncertain: base.rows.filter((r) => r.severity === 'uncertain'),
    captures: [...m.captures]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => ({ label: noDashes(c.label), date: c.date })),
    layers,
    totals,
    placed: base.rows.filter((r) => r.position !== null || r.coords !== '').length,
    withPhoto: base.rows.filter((r) => r.photo?.src).length,
    scale: scaleRows(m, input.issues),
    volumes: input.volumes ?? null,
    road: input.road ? roadSummary(input.road) : null,
    plan,
    audit: input.audit ?? null,
    processing: input.processing ?? null,
  };
}

/**
 * The project statistics a narrative is written from (BLD-7): what the AI prompt carries (shown
 * to the person before it is sent, AI-6) and what the template fills in. Numbers and labels only;
 * no photos, positions or notes.
 */
export interface NarrativeFacts {
  project: string;
  customer: string;
  site: string;
  kind: HouseKind;
  captures: { label: string; date: string }[];
  data: DataTotals;
  issues: {
    total: number;
    placed: number;
    withPhoto: number;
    uncertain: number;
    bySeverity: { label: string; count: number }[];
    byClass: { label: string; count: number }[];
    byZone: { zone: string; count: number }[];
    byStatus: { status: string; count: number }[];
    /** The most severe issues, worst first. */
    worst: { code: string; title: string; severity: string; zone: string }[];
  };
  severityScale: { label: string; criteria: string; action: string }[];
  volumes: {
    base: string;
    /** The survey dates with counted piles, and their totals (current figures only), m³. */
    captures: string[];
    piles: number;
    totalsM3: number[];
    /** The latest total's change since the date before with counted piles, m³. */
    changeM3: number | null;
    /** The latest total, its change and the date it is since, in the site's units. */
    total: string;
    change: string | null;
    since: string | null;
    date: string;
  } | null;
  road: {
    lengthKm: number;
    standard: string;
    networkPci: number | null;
    rating: string;
    units: number;
    ratings: { label: string; count: number }[];
  } | null;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function narrativeFacts(h: HouseModel): NarrativeFacts {
  const b = h.base;
  const road = h.road;
  return {
    project: b.title,
    customer: b.customer,
    site: b.site,
    kind: h.kind,
    captures: h.captures,
    data: h.totals,
    issues: {
      total: b.total,
      placed: h.placed,
      withPhoto: h.withPhoto,
      uncertain: h.uncertain.length,
      bySeverity: b.bySeverity.map((s) => ({ label: s.label, count: s.count })),
      byClass: b.byClass.slice(0, 10).map((c) => ({ label: c.label, count: c.count })),
      byZone: b.byZone.slice(0, 10),
      byStatus: b.byStatus.filter((s) => s.count > 0),
      worst: b.rows
        .filter((r) => r.severity !== 'uncertain')
        .slice(0, 5)
        .map((r) => ({ code: r.code, title: r.title, severity: r.severityLabel, zone: r.zone })),
    },
    severityScale: h.scale.flatMap((s) =>
      s.levels.map((l) => ({ label: l.label, criteria: l.criteria, action: l.action })),
    ),
    volumes: h.volumes
      ? {
          base: h.volumes.base,
          captures: h.volumes.dates.map((c) => c.date),
          piles: h.volumes.piles,
          totalsM3: h.volumes.dates.map((d) => round(d.totalM3, 0)),
          changeM3: h.volumes.changeM3 === null ? null : round(h.volumes.changeM3, 0),
          total: h.volumes.text.total,
          change: h.volumes.text.change,
          since: h.volumes.text.since,
          date: h.volumes.text.date,
        }
      : null,
    road: road
      ? {
          lengthKm: round(road.lengthKm, 2),
          standard: road.standard,
          networkPci: road.networkPci,
          rating:
            road.ratings.find((r) => road.networkPci !== null && road.networkPci >= r.min)?.label ??
            '',
          units: road.units,
          ratings: road.ratings.map((r) => ({ label: r.label, count: r.count })),
        }
      : null,
  };
}
