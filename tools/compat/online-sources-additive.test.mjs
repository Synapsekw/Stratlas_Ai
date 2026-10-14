// Online map sources (plan 2026-10-14-satellite-providers) are additive, pinned against the 0.11
// schema (tools/compat/schema-0.11):
// - online.json stays aio.online-settings/1; it gains an optional `source`, which 0.11 keeps (its
//   object is loose) and ignores, and `satellite` still switches online imagery on for it;
// - a 0.11 file without `source` keeps Sentinel-2 when it was on and starts on Esri otherwise;
// - globe.json gains optional `base` and `packs`; 0.11 reads the file and keeps the `style` it knows.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

describe('online map sources are additive', () => {
  it('0.11 reads a new online.json and keeps the switch it knows', () => {
    const file = { schema: 'aio.online-settings/1', satellite: true, source: 'esri-world-imagery' };
    expect(current.OnlineSettings.safeParse(file).success).toBe(true);
    const old = v011.OnlineSettings.safeParse(file);
    expect(old.success).toBe(true);
    expect(v011.onlineSatelliteOn(old.data)).toBe(true);
  });

  it('a 0.11 file keeps Sentinel-2 when it was on, and starts on Esri otherwise', () => {
    const on = current.OnlineSettings.parse({ schema: 'aio.online-settings/1', satellite: true });
    expect(current.onlineState(on)).toEqual({ enabled: true, source: 's2cloudless-2016' });
    const off = current.OnlineSettings.parse({ schema: 'aio.online-settings/1' });
    expect(current.onlineState(off)).toEqual({ enabled: false, source: 'esri-world-imagery' });
  });

  it('online.json is still version 1 in the registry', () => {
    expect(current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.online-settings')).toMatchObject({
      version: 1,
      since: '0.11',
    });
  });

  it('0.11 reads a globe.json with a base map and the packs switch', () => {
    const file = {
      schema: 'aio.globe-settings/1',
      style: 'satellite',
      base: 'esri-world-imagery',
      packs: false,
    };
    const now = current.GlobeSettings.safeParse(file);
    expect(now.success).toBe(true);
    expect(now.data?.base).toBe('esri-world-imagery');
    const old = v011.GlobeSettings.safeParse(file);
    expect(old.success).toBe(true);
    expect(old.data.style).toBe('satellite');
    // a base map a later build adds reads as absent here
    expect(current.GlobeSettings.parse({ ...file, base: 'later-map' }).base).toBeUndefined();
  });
});
