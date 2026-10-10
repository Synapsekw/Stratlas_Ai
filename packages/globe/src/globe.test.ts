import { ONLINE_SATELLITE } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BANNED_CESIUM_IMPORTS,
  OFFLINE_CESIUM,
  ONLINE_GLOBE_HOSTS,
  ONLINE_SATELLITE_CREDIT,
  creditLines,
  offlineSource,
  onlineHostsIn,
} from './index';

const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('@aio/globe public API (G0)', () => {
  it('keeps Cesium offline: no ion token, our own base layer, the online providers banned', () => {
    expect(OFFLINE_CESIUM.ionToken).toBeNull();
    expect(OFFLINE_CESIUM.baseLayer).toBe('earth-shapes');
    expect(OFFLINE_CESIUM.naturalEarth).toBe('natural-earth-ii');
    expect(BANNED_CESIUM_IMPORTS).toEqual(
      expect.arrayContaining(['Ion', 'createWorldImageryAsync', 'BingMapsImageryProvider']),
    );
    expect(onlineHostsIn('fetch("https://api.cesium.com/v1/assets")')).toEqual(['cesium.com']);
    expect(onlineHostsIn('aio://packs/imagery/world.pmtiles')).toEqual([]);
  });

  it('the lint rule bans every online Cesium export listed here', () => {
    const eslint = repoFile('eslint.config.js');
    for (const name of BANNED_CESIUM_IMPORTS) expect(eslint, name).toContain(`'${name}'`);
    expect(eslint).toContain("'@cesium/widgets'");
  });

  it('the bundle check refuses every online host listed here', () => {
    const check = repoFile('tools/release/check-bundle.mjs');
    for (const host of ONLINE_GLOBE_HOSTS) expect(check, host).toContain(`'${host}'`);
  });

  it('rewrites every online host and its subdomains to a name that never resolves', () => {
    const src = [
      'const s = new Resource({ url: "https://api.cesium.com/" });',
      'const b = "https://dev.virtualearth.net/REST/v1/Imagery";',
      'const g = "https://tile.googleapis.com/v1/";',
      'const e = "//services.arcgisonline.com/ArcGIS/rest";',
      'const m = "https://api.mapbox.com/styles/v1/";',
      'const keep = "aio://packs/imagery/world.pmtiles";',
    ].join('\n');
    const out = offlineSource(src);
    expect(onlineHostsIn(out)).toEqual([]);
    expect(out).toContain('"https://offline.invalid/"');
    expect(out).toContain('"//offline.invalid/ArcGIS/rest"');
    expect(out).toContain('aio://packs/imagery/world.pmtiles');
    expect(offlineSource('const x = 1;')).toBe('const x = 1;');
  });

  it('credits the bundled imagery and every pack once', () => {
    expect(
      creditLines([
        { attribution: 'Contains modified Copernicus Sentinel data 2025', customerLicence: false },
        { attribution: 'Contains modified Copernicus Sentinel data 2025', customerLicence: false },
        { attribution: 'Customer aerial survey 2026', customerLicence: true },
      ]),
    ).toEqual([
      'Natural Earth II (public domain)',
      'Contains modified Copernicus Sentinel data 2025',
      'Customer aerial survey 2026 (customer licence)',
    ]);
  });

  it('credits the online satellite imagery when it is drawn, right above the bundled one', () => {
    expect(ONLINE_SATELLITE_CREDIT).toBe(ONLINE_SATELLITE.attribution);
    expect(ONLINE_SATELLITE_CREDIT).toContain('EOX IT Services GmbH');
    expect(ONLINE_SATELLITE_CREDIT).toContain('Copernicus Sentinel data 2016');
    const packs = [{ attribution: 'Customer aerial survey 2026', customerLicence: true }];
    expect(creditLines(packs, { onlineSatellite: true })).toEqual([
      'Natural Earth II (public domain)',
      ONLINE_SATELLITE_CREDIT,
      'Customer aerial survey 2026 (customer licence)',
    ]);
    expect(creditLines(packs, { onlineSatellite: false })).not.toContain(ONLINE_SATELLITE_CREDIT);
    expect(creditLines(packs)).not.toContain(ONLINE_SATELLITE_CREDIT);
  });

  it('the online satellite source is read through the app, never from a server by name', () => {
    // ADR 0007, amendment of 10 Oct 2026: main owns the address of the service
    const provider = repoFile('packages/globe/src/view/onlineSatellite.ts');
    expect(provider).toContain('onlineSatelliteTileUrl');
    expect(provider).not.toMatch(/https?:\/\//);
    expect(onlineHostsIn(provider)).toEqual([]);
    // and it is one of our own providers, not a banned online one
    for (const name of BANNED_CESIUM_IMPORTS)
      expect(provider, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});
