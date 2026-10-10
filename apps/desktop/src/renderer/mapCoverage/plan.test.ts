import { COUNTRIES, estimatePackBytes, packCovers, regionById, type Bbox } from '@aio/maps';
import { PackRegion, type MapPackInfo } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  AREA_MARGIN_KM,
  boxAround,
  chosenRegions,
  COUNTRY_BUDGET,
  countryOf,
  coveragePlan,
  coverageProjects,
  coverageReport,
  coverageSummary,
  orphanPacks,
  projectCoverage,
  SITE_MARGIN_KM,
  SITE_ZOOM,
  toPackRegion,
  totalBytes,
  WORLD_BBOX,
  WORLD_BUDGET,
  WORLD_ZOOMS,
  zoomWithin,
  type CoverageProject,
} from './plan';

const MB = 1024 * 1024;

// Made-up sites at real coordinates.
const harbour: CoverageProject = { id: 'p-harbour', name: 'Harbour Yard', lonLat: [47.98, 29.37] };
const depot: CoverageProject = { id: 'p-depot', name: 'North Depot', lonLat: [48.06, 29.42] };
const quarry: CoverageProject = { id: 'p-quarry', name: 'Hill Quarry', lonLat: [58.4, 23.6] };
const island: CoverageProject = { id: 'p-island', name: 'Island Works', lonLat: [-21.9, 64.1] };
const unplaced: CoverageProject = { id: 'p-shed', name: 'Shed Model', lonLat: null };

const pack = (id: string, bbox: Bbox, maxZoom: number): MapPackInfo => ({
  id,
  label: id,
  bbox,
  maxZoom,
  sizeBytes: 1,
});
const kuwait = regionById('kuwait')?.bbox ?? WORLD_BBOX;
const oman = regionById('oman')?.bbox ?? WORLD_BBOX;
const kinds = (regions: readonly { kind: string }[]) => regions.map((r) => r.kind);

describe('projectCoverage', () => {
  it('tells detailed, overview only, not covered and not placed apart', () => {
    const packs = [
      pack('city-z14', [47.8, 29.2, 48.2, 29.5], 14),
      pack('kuwait-z10', kuwait, 10),
      pack('oman-z8', oman, 8),
    ];
    const got = projectCoverage([harbour, quarry, island, unplaced], packs);
    expect(got.map((c) => c.status)).toEqual(['detail', 'overview', 'none', 'no-location']);
    // the most detailed covering pack is the one named
    expect(got[0]?.packId).toBe('city-z14');
    expect(got[1]?.packId).toBe('oman-z8');
    expect(coverageSummary(got)).toEqual({
      total: 4,
      located: 3,
      missing: 2,
      overviewOnly: 1,
      uncovered: 1,
      noLocation: 1,
    });
  });

  it('counts a pack of zoom 12 as detailed and zoom 11 as an overview', () => {
    expect(projectCoverage([harbour], [pack('a', kuwait, 12)])[0]?.status).toBe('detail');
    expect(projectCoverage([harbour], [pack('a', kuwait, 11)])[0]?.status).toBe('overview');
  });
});

describe('coveragePlan', () => {
  it('plans a site box, the country overview and the world overview for one new project', () => {
    const { regions } = coveragePlan([harbour], []);
    expect(kinds(regions)).toEqual(['site', 'country', 'world']);
    const [site, country, world] = regions;

    expect(site?.maxZoom).toBe(SITE_ZOOM);
    expect(site?.id).toMatch(/^prj-site-harbour-yard-e04798n2937-z15$/);
    expect(site?.label).toBe('Site area: Harbour Yard');
    expect(site?.projects).toEqual(['p-harbour']);
    // the origin plus the margin on every side, and nothing like a whole country
    const [w, s, e, n] = site?.bbox ?? WORLD_BBOX;
    expect((n - s) * 111.32).toBeCloseTo(2 * SITE_MARGIN_KM, 0);
    expect((e - w) * 111.32 * Math.cos((29.37 * Math.PI) / 180)).toBeCloseTo(2 * SITE_MARGIN_KM, 0);
    expect(packCovers({ bbox: site?.bbox ?? WORLD_BBOX }, 47.98, 29.37)).toBe(true);
    expect(site?.estimate.bytes).toBeLessThan(2 * MB);

    expect(country).toMatchObject({ id: 'prj-country-kuwait-z10', label: 'Kuwait overview' });
    expect(country?.bbox).toEqual(kuwait);
    expect(country?.estimate.bytes).toBeLessThan(2 * MB);

    expect(world).toMatchObject({ id: 'prj-world-z6', label: 'World overview', projects: [] });
    expect(world?.bbox).toEqual(WORLD_BBOX);
    expect(world?.estimate.bytes).toBeGreaterThan(10 * MB);
    expect(world?.estimate.bytes).toBeLessThan(WORLD_BUDGET);
  });

  it('uses the size estimate of Add a region', () => {
    for (const r of coveragePlan([harbour, quarry], []).regions)
      expect(r.estimate).toEqual(estimatePackBytes(r.bbox, r.maxZoom));
  });

  it('puts nearby sites in one box and far ones in their own', () => {
    const { regions } = coveragePlan([quarry, depot, harbour], []);
    const sites = regions.filter((r) => r.kind === 'site');
    expect(sites).toHaveLength(2);
    const shared = sites.find((r) => r.projects.length === 2);
    expect(shared?.projects.sort()).toEqual(['p-depot', 'p-harbour']);
    expect(shared?.label).toBe('Site area: Harbour Yard and North Depot');
    for (const p of [harbour, depot])
      expect(packCovers({ bbox: shared?.bbox ?? WORLD_BBOX }, ...(p.lonLat ?? [0, 0]))).toBe(true);
    // the two sites keep their margin inside the shared box
    expect(shared?.bbox[0]).toBeCloseTo(boxAround([47.98, 29.37], SITE_MARGIN_KM)[0], 4);
    expect(shared?.bbox[3]).toBeCloseTo(boxAround([48.06, 29.42], SITE_MARGIN_KM)[3], 4);
    // one download for both is smaller than one each
    const apart = [harbour, depot].map((p) =>
      estimatePackBytes(boxAround(p.lonLat ?? [0, 0], SITE_MARGIN_KM), SITE_ZOOM),
    );
    expect(shared?.estimate.bytes).toBeLessThan(
      totalBytes(apart.map((estimate) => ({ estimate }))),
    );
    // and one overview per country
    expect(regions.filter((r) => r.kind === 'country').map((r) => r.id)).toEqual([
      'prj-country-kuwait-z10',
      'prj-country-oman-z10',
    ]);
  });

  it('does not grow one box over the land between sites strung along a line', () => {
    const line: CoverageProject[] = Array.from({ length: 12 }, (_, i) => ({
      id: `p-${String(i).padStart(2, '0')}`,
      name: `Station ${String(i + 1)}`,
      lonLat: [44 + i * 0.2, 20 + i * 0.02],
    }));
    const sites = coveragePlan(line, []).regions.filter((r) => r.kind === 'site');
    expect(sites.length).toBeGreaterThan(1);
    expect(sites.length).toBeLessThan(line.length);
    for (const p of line) {
      const [lon, lat] = p.lonLat ?? [0, 0];
      expect(sites.filter((r) => packCovers(r, lon, lat)).length).toBeGreaterThanOrEqual(1);
    }
    expect(sites.flatMap((r) => r.projects).sort()).toEqual(line.map((p) => p.id));
    const apart = line.map((p) => ({
      estimate: estimatePackBytes(boxAround(p.lonLat ?? [0, 0], SITE_MARGIN_KM), SITE_ZOOM),
    }));
    // merging only ever saves: never more than one box per site
    expect(totalBytes(sites)).toBeLessThan(totalBytes(apart));

    // on a diagonal each box only touches the next at a corner: one box each
    const diagonal = line.map((p, i) => ({ ...p, lonLat: [44 + i * 0.2, 20 + i * 0.18] as const }));
    expect(coveragePlan(diagonal, []).regions.filter((r) => r.kind === 'site')).toHaveLength(12);
  });

  it('several projects on one site share one box', () => {
    const twin = { ...harbour, id: 'p-harbour-2', name: 'Harbour Yard phase 2' };
    const sites = coveragePlan([harbour, twin], []).regions.filter((r) => r.kind === 'site');
    expect(sites).toHaveLength(1);
    expect(sites[0]?.bbox).toEqual(boxAround([47.98, 29.37], SITE_MARGIN_KM));
  });

  it('plans nothing that an installed pack already covers at that detail', () => {
    const packs = [
      pack('city-z14', [47.8, 29.2, 48.2, 29.5], 14),
      pack('gulf-z12', [46, 28, 49, 31], 12),
      pack('world', WORLD_BBOX, 6),
    ];
    // the site is detailed (city-z14), the country is inside gulf-z12, the world is there
    expect(coveragePlan([harbour], packs).regions).toEqual([]);
    const report = coverageReport([harbour], packs);
    expect(report.summary.missing).toBe(0);
    expect(report.plan.regions).toEqual([]);
  });

  it('still plans the country and world overviews beside a detailed site pack', () => {
    const site = pack('site', boxAround([47.98, 29.37], SITE_MARGIN_KM), 15);
    expect(kinds(coveragePlan([harbour], [site]).regions)).toEqual(['country', 'world']);
    // a coarser world pack does not stand in for the planned zoom
    const coarse = pack('world-z3', WORLD_BBOX, 3);
    expect(kinds(coveragePlan([harbour], [site, coarse]).regions)).toEqual(['country', 'world']);
    // an overview-only project still gets its site box
    const overview = pack('kuwait-z10', kuwait, 10);
    expect(kinds(coveragePlan([harbour], [overview]).regions)).toEqual(['site', 'world']);
  });

  it('never plans a pack id that is installed, and marks the ones already in Downloads', () => {
    const fresh = coveragePlan([harbour], []);
    const siteId = fresh.regions[0]?.id ?? '';
    // an installed pack of that id (say, cut smaller by an older build) is not asked for again
    const again = coveragePlan([harbour], [pack('prj-country-kuwait-z10', [47, 29, 48, 30], 10)]);
    expect(again.regions.map((r) => r.id)).toEqual([siteId, 'prj-world-z6']);

    const queued = coveragePlan(
      [harbour],
      [],
      [
        { id: siteId, state: 'running' },
        { id: 'prj-country-kuwait-z10', state: 'interrupted' },
        { id: 'prj-world-z6', state: 'failed' },
      ],
    );
    expect(queued.regions.map((r) => r.busy)).toEqual([true, true, false]);
    expect(chosenRegions(queued).map((r) => r.id)).toEqual(['prj-world-z6']);
  });

  it('leaves out what the person unticks and totals the rest', () => {
    const plan = coveragePlan([harbour], []);
    const chosen = chosenRegions(plan, new Set(['prj-world-z6']));
    expect(kinds(chosen)).toEqual(['site', 'country']);
    expect(totalBytes(chosen)).toBe(
      (plan.regions[0]?.estimate.bytes ?? 0) + (plan.regions[1]?.estimate.bytes ?? 0),
    );
    expect(totalBytes(chosenRegions(plan))).toBeGreaterThan(totalBytes(chosen));
    expect(totalBytes([])).toBe(0);
  });

  it('plans no site or country for a project that is not placed, only the world', () => {
    expect(kinds(coveragePlan([unplaced], []).regions)).toEqual(['world']);
    expect(kinds(coveragePlan([], []).regions)).toEqual(['world']);
    expect(coveragePlan([unplaced, harbour], []).regions.flatMap((r) => r.projects)).toEqual([
      'p-harbour',
      'p-harbour',
    ]);
  });

  it('gives a project outside the country list an overview box of its own', () => {
    const { regions } = coveragePlan([island], []);
    expect(kinds(regions)).toEqual(['site', 'area', 'world']);
    const areaBox = regions[1];
    expect(areaBox?.id).toMatch(/^prj-area-w02190n6410-z10$/);
    expect(areaBox?.label).toBe('Region around Island Works');
    expect(areaBox?.bbox).toEqual(boxAround([-21.9, 64.1], AREA_MARGIN_KM));
    expect(areaBox?.estimate.bytes).toBeLessThan(5 * MB);
  });

  it('is the same plan whatever order the projects come in', () => {
    const a = coveragePlan([harbour, depot, quarry, island, unplaced], []);
    const b = coveragePlan([unplaced, island, quarry, depot, harbour], []);
    expect(b).toEqual(a);
  });

  it('asks main only for regions its download channel accepts', () => {
    const odd: CoverageProject = {
      id: 'p-odd',
      name: 'Übergabestation Süd / مستودع with a very long name that goes on and on and on and on',
      lonLat: [179.99, -84.9],
    };
    const nameless: CoverageProject = { id: 'p-none', name: '', lonLat: [-0.01, 0.01] };
    const { regions } = coveragePlan([harbour, depot, quarry, island, odd, nameless], []);
    expect(new Set(regions.map((r) => r.id)).size).toBe(regions.length);
    for (const r of regions) {
      const parsed = PackRegion.strict().safeParse(toPackRegion(r));
      expect(parsed.success, `${r.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(r.id.startsWith('prj-')).toBe(true);
      expect(r.label).not.toMatch(/[–—]/);
    }
  });
});

describe('zooms and sizes', () => {
  it('picks the highest world zoom that stays modest', () => {
    const zoom = zoomWithin(WORLD_BBOX, WORLD_ZOOMS, WORLD_BUDGET);
    expect(zoom).toBe(6);
    expect(estimatePackBytes(WORLD_BBOX, zoom).bytes).toBeLessThan(WORLD_BUDGET);
    expect(estimatePackBytes(WORLD_BBOX, zoom + 1).bytes).toBeGreaterThan(WORLD_BUDGET);
  });

  it('keeps every country overview small, coarser for the large countries', () => {
    const zoomOf = (id: string) => {
      const bbox = regionById(id)?.bbox ?? WORLD_BBOX;
      const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
      const region = coveragePlan([{ id: 'p', name: 'P', lonLat: centre }], []).regions.find(
        (r) => r.kind === 'country' && r.id.startsWith(`prj-country-${id}-`),
      );
      return region?.maxZoom;
    };
    expect(zoomOf('kuwait')).toBe(10);
    expect(zoomOf('saudi-arabia')).toBe(10);
    expect(zoomOf('canada')).toBeLessThan(10);
    for (const c of COUNTRIES) {
      const z = zoomWithin(c.bbox, [10, 9, 8, 7, 6], COUNTRY_BUDGET);
      expect(estimatePackBytes(c.bbox, z).bytes, c.id).toBeLessThanOrEqual(COUNTRY_BUDGET);
    }
  });
});

describe('countryOf', () => {
  it('takes the smallest country box around a point', () => {
    // Kuwait lies inside the boxes of its larger neighbours too
    expect(countryOf([47.98, 29.37])?.id).toBe('kuwait');
    expect(countryOf([58.4, 23.6])?.id).toBe('oman');
    expect(countryOf([45.0, 24.0])?.id).toBe('saudi-arabia');
  });

  it('answers nothing at sea and in a country that is not listed', () => {
    expect(countryOf([-30, 0])).toBeUndefined();
    expect(countryOf([-21.9, 64.1])).toBeUndefined();
  });
});

describe('orphanPacks', () => {
  const site = pack('prj-site-harbour-yard-e04798n2937-z15', boxAround([47.98, 29.37], 12), 15);
  const country = pack('prj-country-oman-z10', oman, 10);
  const world = pack('prj-world-z6', WORLD_BBOX, 6);
  const own = pack('my-region-z12', [10, 10, 11, 11], 12);

  it('finds the plan packs whose area has no project any more', () => {
    const packs = [site, country, world, own];
    expect(orphanPacks([harbour, quarry], packs)).toEqual([]);
    expect(orphanPacks([harbour], packs).map((p) => p.id)).toEqual(['prj-country-oman-z10']);
    expect(orphanPacks([unplaced], packs).map((p) => p.id)).toEqual([site.id, country.id]);
  });

  it('never names the world overview or a pack the person added', () => {
    expect(orphanPacks([], [world, own])).toEqual([]);
  });
});

describe('coverageProjects', () => {
  it('joins the library with the places, without the demo projects', () => {
    const library = [
      { id: 'a', name: 'Harbour Yard' },
      { id: 'b', name: 'Shed Model' },
      { id: 'demo', name: 'Demo site', demo: { primary: true } },
    ];
    const sites = [
      { projectId: 'a', lonLat: [47.98, 29.37] as [number, number] },
      { projectId: 'demo', lonLat: [50, 26] as [number, number] },
    ];
    expect(coverageProjects(library, sites)).toEqual([
      { id: 'a', name: 'Harbour Yard', lonLat: [47.98, 29.37] },
      { id: 'b', name: 'Shed Model', lonLat: null },
    ]);
  });
});
