import { CrsCatalogueEntry } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { bboxHolds, parseCatalogue, searchCatalogue } from './catalogue/search';

const gz = readFileSync(new URL('./catalogue/epsg.json.gz', import.meta.url));
const catalogue = parseCatalogue(gunzipSync(gz).toString('utf8'));
const entries = catalogue.entries;

describe('the EPSG catalogue file', () => {
  it('stays under its 1.5 MB budget and names its PROJ source', () => {
    expect(gz.length).toBeLessThan(1.5 * 1024 * 1024);
    expect(catalogue.source).toMatch(/PROJ \d+\.\d+/);
  });

  it('holds every kind, each row a valid CrsCatalogueEntry', () => {
    expect(entries.length).toBeGreaterThan(5000);
    for (const e of entries) expect(CrsCatalogueEntry.safeParse(e).success).toBe(true);
    const kinds = new Set(entries.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['compound', 'geographic', 'projected', 'vertical']);
    expect(new Set(entries.map((e) => e.code)).size).toBe(entries.length);
  });

  it('knows the units of a state plane zone in US survey feet', () => {
    const georgia = entries.find((e) => e.code === 2240);
    expect(georgia?.unit).toBe('US survey foot');
    expect(entries.find((e) => e.code === 32639)?.unit).toBe('metre');
    expect(entries.find((e) => e.code === 3855)?.kind).toBe('vertical');
  });

  it('keeps proj4 only where proj4js matches PROJ (eligibility spot check)', () => {
    const utm = entries.find((e) => e.code === 32639);
    expect(utm?.proj4).toContain('+proj=utm +zone=39');
    // web mercator needs +nadgrids=@null in proj4: never offered
    expect(entries.find((e) => e.code === 3857)?.proj4).toBeUndefined();
    // a matched string reproduces PROJ at Kuwait City (pyproj 3.8, PROJ 9.8) to the millimetre
    const conv = proj4('+proj=longlat +datum=WGS84 +no_defs', utm?.proj4 ?? '');
    const [x, y] = conv.forward([47.9783, 29.3759]);
    expect(x).toBeCloseTo(206686.7355, 3);
    expect(y).toBeCloseTo(3253429.5682, 3);
  });
});

describe('searchCatalogue', () => {
  it('finds a code typed with or without EPSG', () => {
    expect(searchCatalogue(entries, { query: '2240' })[0]?.code).toBe(2240);
    expect(searchCatalogue(entries, { query: 'EPSG:32639' })[0]?.code).toBe(32639);
  });

  it('finds by words of the name and the area of use', () => {
    const r = searchCatalogue(entries, { query: 'Georgia West ftUS' });
    expect(r[0]?.code).toBe(2240);
    const kuwait = searchCatalogue(entries, { query: 'Kuwait', kinds: ['projected'] });
    expect(kuwait.length).toBeGreaterThan(0);
    expect(kuwait.every((e) => e.kind === 'projected')).toBe(true);
    expect(kuwait.some((e) => e.name.includes('KTM'))).toBe(true);
  });

  it('ranks the WGS 84 UTM zone first near a GCC site, and filters by area with no query', () => {
    const doha: [number, number] = [51.53, 25.29];
    const r = searchCatalogue(entries, { query: 'UTM', near: doha, limit: 20 });
    expect(r[0]?.code).toBe(32639);
    const local = searchCatalogue(entries, { query: '', near: doha, kinds: ['projected'] });
    expect(local.length).toBeGreaterThan(3);
    expect(local.every((e) => e.bbox && bboxHolds(e.bbox, doha))).toBe(true);
    expect(local.slice(0, 3).some((e) => e.code === 32639)).toBe(true);
  });

  it('puts current CRSs before deprecated ones and honours the limit', () => {
    const r = searchCatalogue(entries, { query: 'NAD83', limit: 30 });
    expect(r).toHaveLength(30);
    const firstDeprecated = r.findIndex((e) => e.deprecated);
    if (firstDeprecated >= 0)
      expect(r.slice(firstDeprecated).every((e) => e.deprecated)).toBe(true);
    expect(searchCatalogue(entries, { query: '' })).toEqual([]);
  });

  it('handles areas across the antimeridian', () => {
    expect(bboxHolds([170, -50, -170, -30], [179, -40])).toBe(true);
    expect(bboxHolds([170, -50, -170, -30], [-175, -40])).toBe(true);
    expect(bboxHolds([170, -50, -170, -30], [0, -40])).toBe(false);
  });
});
