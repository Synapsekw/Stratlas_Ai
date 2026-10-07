import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANNED_CESIUM_IMPORTS, OFFLINE_CESIUM, creditLines, onlineHostsIn } from './index';

const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('@aio/globe public API (G0)', () => {
  it('keeps Cesium offline: no ion token, our own base layer, the online providers banned', () => {
    expect(OFFLINE_CESIUM.ionToken).toBeNull();
    expect(OFFLINE_CESIUM.baseLayer).toBe('natural-earth-ii');
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
});
