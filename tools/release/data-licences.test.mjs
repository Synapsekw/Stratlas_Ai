import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPackMeta,
  checkSources,
  dataPolicy,
  findPackMetas,
  loadSources,
  runDataGate,
} from './data-licences.mjs';

const policy = dataPolicy({
  allowed: { data: ['public-domain', 'CC0-1.0', 'CC-BY-4.0', 'LicenseRef-Copernicus-Sentinel'] },
});

const pack = (over = {}) => ({
  schema: 'aio.raster-pack/1',
  id: 'gcc-s2-2021',
  kind: 'imagery',
  label: 'GCC imagery 2021',
  licence: 'CC-BY-4.0',
  attribution: 'ESA WorldCover 2021, Contains modified Copernicus Sentinel data (2021)',
  provenance: 'ESA WorldCover 2021 RGB composite',
  customerLicence: false,
  ...over,
});

describe('raster pack metadata', () => {
  it('passes an open licence with attribution and provenance', () => {
    expect(checkPackMeta(pack(), policy)).toEqual([]);
    expect(checkPackMeta(pack({ licence: 'public-domain' }), policy)).toEqual([]);
  });

  it('refuses non-commercial, share-alike, no-derivatives and unknown licences', () => {
    for (const licence of ['CC-BY-NC-4.0', 'CC-BY-SA-4.0', 'CC-BY-ND-4.0', 'ODbL-1.0', 'Custom'])
      expect(checkPackMeta(pack({ licence }), policy).join('\n'), licence).toMatch(licence);
  });

  it('refuses a pack without attribution or provenance', () => {
    expect(checkPackMeta(pack({ attribution: '' }), policy).join('\n')).toMatch(/attribution/);
    expect(checkPackMeta(pack({ attribution: undefined }), policy).join('\n')).toMatch(
      /attribution/,
    );
    expect(checkPackMeta(pack({ provenance: undefined }), policy).join('\n')).toMatch(/provenance/);
  });

  it('refuses a customer-licensed pack and the providers decision 4 rules out', () => {
    expect(checkPackMeta(pack({ customerLicence: true }), policy).join('\n')).toMatch(
      /customer licence/,
    );
    for (const provenance of [
      'EOX Sentinel-2 cloudless 2020',
      'Cesium ion World Terrain',
      'Bing Maps aerial',
      'Google satellite',
      'Esri World Imagery',
      'Mapbox Satellite',
    ])
      expect(checkPackMeta(pack({ provenance }), policy).join('\n'), provenance).toMatch(
        /decision 4/,
      );
    expect(checkPackMeta(pack({ provenance: 'EOX Sentinel-2 cloudless 2016' }), policy)).toEqual(
      [],
    );
  });
});

describe('the data inventory', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'data-gate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('checks the committed sources: raster sources by the policy, street maps listed', () => {
    const sources = loadSources();
    expect(checkSources(sources, dataPolicy())).toEqual([]);
    expect(sources.map((s) => s.kind)).toEqual(expect.arrayContaining(['imagery', 'terrain']));
    for (const s of sources) expect(s.attribution, s.name).toBeTruthy();
  });

  it('finds pack metadata in folders and fails the bad ones by file', () => {
    mkdirSync(join(dir, 'imagery'));
    writeFileSync(join(dir, 'imagery', 'good.json'), JSON.stringify(pack()));
    writeFileSync(
      join(dir, 'imagery', 'bad.json'),
      JSON.stringify(pack({ licence: 'CC-BY-NC-4.0' })),
    );
    writeFileSync(join(dir, 'imagery', 'other.json'), JSON.stringify({ schema: 'aio.other/1' }));
    expect(findPackMetas([dir]).map((m) => m.file.replaceAll('\\', '/'))).toEqual([
      expect.stringMatching(/imagery\/bad\.json$/),
      expect.stringMatching(/imagery\/good\.json$/),
    ]);
    const out = runDataGate({ dirs: [dir], policy, sources: [] });
    expect(out.packs).toBe(2);
    expect(out.problems.join('\n')).toMatch(/bad\.json.*CC-BY-NC-4.0/);
    expect(out.problems).toHaveLength(1);
  });
});
