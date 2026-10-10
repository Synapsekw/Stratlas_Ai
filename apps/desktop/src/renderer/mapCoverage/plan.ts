/**
 * Street maps for the places of the library's projects, and nothing more: which projects have a
 * detailed street map among the installed packs, and the fewest, smallest regions to download for
 * the ones that do not. A plan has three layers, most detailed first:
 *
 * - a full-detail box around each site (or cluster of nearby sites): the project origin plus
 *   `SITE_MARGIN_KM` on every side, at `SITE_ZOOM`;
 * - an overview of each country that has projects (the Country list of Add a region), at the
 *   highest of `COUNTRY_ZOOMS` that keeps it under `COUNTRY_BUDGET`;
 * - one world overview, at the highest of `WORLD_ZOOMS` under `WORLD_BUDGET`, so the Globe has a
 *   continuous street map at every zoom.
 *
 * A region an installed pack already covers at that detail is never planned. Pure: no IPC, no
 * download. Sizes are the estimates of Add a region (`estimatePackBytes`).
 */
import {
  COUNTRIES,
  estimatePackBytes,
  normaliseBbox,
  packCovers,
  type Bbox,
  type PackEstimate,
  type Region,
} from '@aio/maps';
import type { MapPackInfo, PackJob, PackRegion } from '@aio/schema';
import { t } from '@aio/ui';

/** A pack reaches this zoom: streets read at site scale (as the street map under the site). */
export const DETAIL_ZOOM = 12;
/** Zoom of a site box: full detail. */
export const SITE_ZOOM = 15;
/** How far a site box reaches from the project origin, on every side. */
export const SITE_MARGIN_KM = 12;
/** Country overviews: the first of these that fits the budget, else the last. */
export const COUNTRY_ZOOMS: readonly number[] = [10, 9, 8, 7, 6];
export const COUNTRY_BUDGET = 40 * 1024 * 1024;
/** A project in no listed country gets an overview box this far around it instead. */
export const AREA_MARGIN_KM = 150;
/** The world overview: the first of these that fits the budget, else the last. */
export const WORLD_ZOOMS: readonly number[] = [8, 7, 6, 5, 4];
export const WORLD_BUDGET = 50 * 1024 * 1024;
/** The whole Web Mercator world. */
export const WORLD_BBOX: Bbox = [-180, -85.05, 180, 85.05];

/**
 * Ids of the packs this plan downloads start with this, which is how they are told apart later
 * (a pack's id is the one piece of its record that is free to carry it).
 */
export const PROJECT_PACK_PREFIX = 'prj-';

/** A library project and where it is on the Earth (WGS84 degrees), or null when not placed. */
export interface CoverageProject {
  id: string;
  name: string;
  lonLat: readonly [number, number] | null;
}

/**
 * `detail`: an installed pack of zoom `DETAIL_ZOOM` or better covers the site. `overview`: only a
 * coarser pack does. `none`: no pack does. `no-location`: the project is not placed on the Earth.
 */
export type CoverageStatus = 'detail' | 'overview' | 'none' | 'no-location';

export interface ProjectCoverage {
  project: CoverageProject;
  status: CoverageStatus;
  /** The most detailed pack that covers the site. */
  packId?: string;
}

type Pack = Pick<MapPackInfo, 'id' | 'bbox' | 'maxZoom'>;

/** Each project's street map among the installed packs. */
export function projectCoverage(
  projects: readonly CoverageProject[],
  packs: readonly Pack[],
): ProjectCoverage[] {
  return projects.map((project) => {
    if (!project.lonLat) return { project, status: 'no-location' };
    const [lon, lat] = project.lonLat;
    const best = packs
      .filter((p) => packCovers(p, lon, lat))
      .sort((a, b) => b.maxZoom - a.maxZoom)[0];
    if (!best) return { project, status: 'none' };
    return {
      project,
      status: best.maxZoom >= DETAIL_ZOOM ? 'detail' : 'overview',
      packId: best.id,
    };
  });
}

export interface CoverageSummary {
  total: number;
  /** Placed on the Earth. */
  located: number;
  /** Placed, without a detailed street map (`overview` or `none`). */
  missing: number;
  overviewOnly: number;
  uncovered: number;
  noLocation: number;
}

export function coverageSummary(coverage: readonly ProjectCoverage[]): CoverageSummary {
  const count = (s: CoverageStatus) => coverage.filter((c) => c.status === s).length;
  const overviewOnly = count('overview');
  const uncovered = count('none');
  const noLocation = count('no-location');
  return {
    total: coverage.length,
    located: coverage.length - noLocation,
    missing: overviewOnly + uncovered,
    overviewOnly,
    uncovered,
    noLocation,
  };
}

export type PlannedKind = 'site' | 'country' | 'area' | 'world';

/** One region of the plan: what `packs:download` takes, and why it is there. */
export interface PlannedRegion extends PackRegion {
  bbox: Bbox;
  kind: PlannedKind;
  /** Ids of the projects it is for (none for the world overview). */
  projects: string[];
  estimate: PackEstimate;
  /** Already in Downloads (running, or interrupted and waiting for Resume): not started again. */
  busy: boolean;
}

export interface CoveragePlan {
  regions: PlannedRegion[];
}

const KM_PER_DEG = 111.32;

/** The box `km` around a point, clamped to the Web Mercator world. */
export function boxAround([lon, lat]: readonly [number, number], km: number): Bbox {
  const dLat = km / KM_PER_DEG;
  // near the poles a degree of longitude is short: never wider than the box is tall times 20
  const dLon = Math.min(dLat * 20, km / (KM_PER_DEG * Math.max(0.05, Math.cos(rad(lat)))));
  return normaliseBbox([lon - dLon, lat - dLat, lon + dLon, lat + dLat]);
}

const rad = (deg: number) => (deg * Math.PI) / 180;

const area = ([w, s, e, n]: readonly number[]) => ((e ?? 0) - (w ?? 0)) * ((n ?? 0) - (s ?? 0));

function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function union(a: Bbox, b: Bbox): Bbox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const EPS = 1e-6;

/** `outer` holds all of `inner`. */
export function contains(outer: readonly number[], inner: Bbox): boolean {
  const [w = 0, s = 0, e = 0, n = 0] = outer;
  return w <= inner[0] + EPS && s <= inner[1] + EPS && e >= inner[2] - EPS && n >= inner[3] - EPS;
}

/** An installed pack already has all of `bbox` at `zoom` or better. */
export function coveredAt(packs: readonly Pack[], bbox: Bbox, zoom: number): boolean {
  return packs.some((p) => p.maxZoom >= zoom && contains(p.bbox, bbox));
}

/** The first zoom whose estimate fits the budget, else the last (the coarsest). */
export function zoomWithin(bbox: Bbox, zooms: readonly number[], budget: number): number {
  for (const z of zooms) if (estimatePackBytes(bbox, z).bytes <= budget) return z;
  return zooms.at(-1) ?? 0;
}

/**
 * The country of a point: the listed country whose box holds it, the smallest when boxes overlap
 * (a point in Kuwait is also inside the boxes of its larger neighbours). Undefined in a country
 * that is not on the list, and at sea.
 */
export function countryOf([lon, lat]: readonly [number, number]): Region | undefined {
  return COUNTRIES.filter((c) => packCovers(c, lon, lat)).sort(
    (a, b) => area(a.bbox) - area(b.bbox),
  )[0];
}

function slug(text: string, max: number): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** The centre of a box as an id part, e.g. `e04798n2937` (hundredths of a degree). */
function placeKey([w, s, e, n]: Bbox): string {
  const part = (v: number, pos: string, neg: string, width: number) =>
    `${v < 0 ? neg : pos}${String(Math.round(Math.abs(v) * 100)).padStart(width, '0')}`;
  return `${part((w + e) / 2, 'e', 'w', 5)}${part((s + n) / 2, 'n', 's', 4)}`;
}

/** "A", "A and B", "A, B and 2 more", cut to fit a pack label. */
function nameList(names: readonly string[]): string {
  const [a = '', b = '', ...rest] = [...names].sort((x, y) => x.localeCompare(y));
  if (names.length <= 1) return a;
  if (names.length === 2) return t('maps.coverage.names.two', { a, b });
  return t('maps.coverage.names.more', { a, b, count: rest.length });
}

const fit = (label: string) => (label.length > 80 ? `${label.slice(0, 79).trimEnd()}…` : label);

interface Cluster {
  bbox: Bbox;
  projects: CoverageProject[];
}

/**
 * Boxes that overlap become one box whenever the one box is no larger a download than the two
 * (each pack repeats the coarse zooms, so nearby sites are cheaper together). Sites strung along
 * a diagonal stay apart: one box over them would be mostly the empty land in between. The total
 * is therefore never more than one box per site.
 */
function cluster(items: readonly Cluster[], zoom: number): Cluster[] {
  const boxes = [...items];
  const cost = (b: Bbox) => estimatePackBytes(b, zoom).bytes;
  for (;;) {
    let merged = false;
    search: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b || !intersects(a.bbox, b.bbox)) continue;
        const both = union(a.bbox, b.bbox);
        if (cost(both) > cost(a.bbox) + cost(b.bbox)) continue;
        boxes.splice(j, 1);
        boxes[i] = { bbox: both, projects: [...a.projects, ...b.projects] };
        merged = true;
        break search;
      }
    }
    if (!merged) return boxes;
  }
}

const BUSY: readonly PackJob['state'][] = ['running', 'verifying', 'interrupted'];

/**
 * What to download so every placed project has a detailed street map, its country an overview
 * and the Globe a world map: site boxes first, then countries, then the world. Regions an
 * installed pack already covers at that detail are left out; so is a region whose pack id is
 * installed. `jobs` marks the regions that are already in Downloads.
 */
export function coveragePlan(
  projects: readonly CoverageProject[],
  packs: readonly Pack[],
  jobs: readonly Pick<PackJob, 'id' | 'state'>[] = [],
): CoveragePlan {
  const installed = new Set(packs.map((p) => p.id));
  const busy = new Set(jobs.filter((j) => BUSY.includes(j.state)).map((j) => j.id));
  const ordered = [...projects].sort((a, b) => a.id.localeCompare(b.id));
  const coverage = projectCoverage(ordered, packs);
  const regions: PlannedRegion[] = [];
  const add = (
    kind: PlannedKind,
    id: string,
    label: string,
    bbox: Bbox,
    maxZoom: number,
    forProjects: readonly CoverageProject[],
  ) => {
    if (installed.has(id) || coveredAt(packs, bbox, maxZoom)) return;
    if (regions.some((r) => r.id === id)) return;
    regions.push({
      kind,
      id,
      label: fit(label),
      bbox,
      maxZoom,
      projects: forProjects.map((p) => p.id),
      estimate: estimatePackBytes(bbox, maxZoom),
      busy: busy.has(id),
    });
  };

  // 1. full detail around every site that has none
  const sites = coverage
    .filter((c) => c.status === 'overview' || c.status === 'none')
    .flatMap(({ project }) =>
      project.lonLat
        ? [{ bbox: boxAround(project.lonLat, SITE_MARGIN_KM), projects: [project] }]
        : [],
    );
  for (const c of cluster(sites, SITE_ZOOM)) {
    const first = [...c.projects].sort((a, b) => a.name.localeCompare(b.name))[0];
    add(
      'site',
      `${PROJECT_PACK_PREFIX}site-${slug(first?.name ?? '', 16) || 'site'}-${placeKey(c.bbox)}-z${String(SITE_ZOOM)}`,
      t('maps.coverage.label.site', { names: nameList(c.projects.map((p) => p.name)) }),
      c.bbox,
      SITE_ZOOM,
      c.projects,
    );
  }

  // 2. an overview of every country that has a project; a box where the country is not listed
  const located = ordered.filter((p) => p.lonLat !== null);
  const byCountry = new Map<string, { country: Region; projects: CoverageProject[] }>();
  const elsewhere: Cluster[] = [];
  for (const project of located) {
    if (!project.lonLat) continue;
    const country = countryOf(project.lonLat);
    if (!country) {
      elsewhere.push({ bbox: boxAround(project.lonLat, AREA_MARGIN_KM), projects: [project] });
      continue;
    }
    const entry = byCountry.get(country.id) ?? { country, projects: [] };
    entry.projects.push(project);
    byCountry.set(country.id, entry);
  }
  for (const { country, projects: inside } of [...byCountry.values()].sort((a, b) =>
    a.country.label.localeCompare(b.country.label),
  )) {
    const zoom = zoomWithin(country.bbox, COUNTRY_ZOOMS, COUNTRY_BUDGET);
    add(
      'country',
      `${PROJECT_PACK_PREFIX}country-${country.id}-z${String(zoom)}`,
      t('maps.coverage.label.country', { country: country.label }),
      country.bbox,
      zoom,
      inside,
    );
  }
  const areaZoom = COUNTRY_ZOOMS[0] ?? 10;
  for (const c of cluster(elsewhere, areaZoom)) {
    add(
      'area',
      `${PROJECT_PACK_PREFIX}area-${placeKey(c.bbox)}-z${String(areaZoom)}`,
      t('maps.coverage.label.area', { names: nameList(c.projects.map((p) => p.name)) }),
      c.bbox,
      areaZoom,
      c.projects,
    );
  }

  // 3. the world, coarse, for the Globe
  const worldZoom = zoomWithin(WORLD_BBOX, WORLD_ZOOMS, WORLD_BUDGET);
  add(
    'world',
    `${PROJECT_PACK_PREFIX}world-z${String(worldZoom)}`,
    t('maps.coverage.label.world'),
    WORLD_BBOX,
    worldZoom,
    [],
  );

  return { regions };
}

/** The regions a Download would start: not left out by the person, not already in Downloads. */
export function chosenRegions(
  plan: CoveragePlan,
  leftOut: ReadonlySet<string> = new Set(),
): PlannedRegion[] {
  return plan.regions.filter((r) => !r.busy && !leftOut.has(r.id));
}

/** Estimated bytes of a set of regions. */
export function totalBytes(regions: readonly Pick<PlannedRegion, 'estimate'>[]): number {
  return regions.reduce((n, r) => n + r.estimate.bytes, 0);
}

/** What `packs:download` takes: a planned region without the planning notes. */
export function toPackRegion(r: PlannedRegion): PackRegion {
  return { id: r.id, label: r.label, bbox: r.bbox, maxZoom: r.maxZoom };
}

/**
 * Packs this plan downloaded (`PROJECT_PACK_PREFIX`) whose area holds no project any more: the
 * project was removed from the library or moved. The world overview is never one of them.
 */
export function orphanPacks<P extends Pick<MapPackInfo, 'id' | 'bbox'>>(
  projects: readonly CoverageProject[],
  packs: readonly P[],
): P[] {
  const places = projects.flatMap((p) => (p.lonLat ? [p.lonLat] : []));
  return packs.filter(
    (p) =>
      p.id.startsWith(PROJECT_PACK_PREFIX) &&
      !p.id.startsWith(`${PROJECT_PACK_PREFIX}world-`) &&
      !places.some(([lon, lat]) => packCovers(p, lon, lat)),
  );
}

/**
 * The library as the plan sees it: every project except the demos that ship with the app (their
 * places are made up), with its place from the Globe's site list (`globe:sites`) or none.
 */
export function coverageProjects(
  library: readonly { id: string; name: string; demo?: unknown }[],
  sites: readonly { projectId: string; lonLat: readonly [number, number] }[],
): CoverageProject[] {
  const place = new Map(sites.map((s) => [s.projectId, s.lonLat]));
  return library
    .filter((e) => !e.demo)
    .map((e) => ({ id: e.id, name: e.name, lonLat: place.get(e.id) ?? null }));
}

export interface CoverageReport {
  coverage: ProjectCoverage[];
  summary: CoverageSummary;
  plan: CoveragePlan;
  /** Packs of an earlier plan that cover no project any more. */
  orphans: MapPackInfo[];
}

/** Everything the "Maps for your projects" panel shows, from the three lists it reads. */
export function coverageReport(
  projects: readonly CoverageProject[],
  packs: readonly MapPackInfo[],
  jobs: readonly Pick<PackJob, 'id' | 'state'>[] = [],
): CoverageReport {
  const coverage = projectCoverage(projects, packs);
  return {
    coverage,
    summary: coverageSummary(coverage),
    plan: coveragePlan(projects, packs, jobs),
    orphans: orphanPacks(projects, packs),
  };
}
