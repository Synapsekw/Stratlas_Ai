import type { Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { defaultEnvironment, defaultMode, defaultTime, siteLocation } from './envDefaults';

const ortho: Layer = {
  kind: 'raster',
  id: 'ortho',
  name: 'Ortho',
  visible: true,
  src: { path: 'o.jpg' },
  role: 'ortho',
  format: 'image',
};
const plan: Layer = { ...ortho, id: 'plan', role: 'plan' };
const tank: Layer = {
  kind: 'mesh',
  id: 'tank',
  name: 'Tank',
  visible: true,
  src: { path: 't.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};
const clip = (startUtcMs: number): Layer => ({
  kind: 'video',
  id: `v${String(startUtcMs)}`,
  name: 'Clip',
  visible: true,
  src: { path: 'v.mp4' },
  flight: { src: { path: 'f.json' }, startUtcMs },
  lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.78 },
  offsetMs: 0,
});

function manifest(layers: Layer[], patch: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32639 },
    origin: [245714, 3179542, 100], // Al-Zour, Kuwait
    captures: [{ id: 'c', label: 'Survey', date: '2023-02-21' }],
    layers,
    severityModels: [],
    classCatalogues: [],
    ...patch,
  };
}

describe('environment defaults', () => {
  it('places a UTM project on the Earth', () => {
    const loc = siteLocation(manifest([]));
    expect(loc?.lat).toBeCloseTo(28.72, 1);
    expect(loc?.lon).toBeCloseTo(48.4, 1);
    expect(loc?.utcOffsetHours).toBe(3);
    expect(Math.abs(loc?.convergenceDeg ?? 9)).toBeLessThan(3);
    expect(siteLocation(manifest([], { origin: [0, 0, 0] }))).toBeNull();
    expect(siteLocation(manifest([], { crs: { wkt: 'LOCAL_CS["x"]' } }))).toBeNull();
  });

  it('picks the sky for a placed site with imagery, the studio otherwise', () => {
    expect(defaultMode(manifest([tank, ortho]))).toBe('sky');
    expect(defaultMode(manifest([tank]))).toBe('studio');
    expect(defaultMode(manifest([tank, plan]))).toBe('studio');
    expect(defaultMode(manifest([tank, ortho], { origin: [0, 0, 0] }))).toBe('studio');
  });

  it('starts at the first flight of the capture date, else 10:00 site time', () => {
    const first = Date.UTC(2023, 1, 21, 10, 22, 38);
    expect(defaultTime(manifest([clip(first + 3_600_000), clip(first)]), 0)).toBe(first);
    // a flight on another day does not count
    expect(defaultTime(manifest([clip(Date.UTC(2023, 1, 25, 9))]), 0)).toBe(
      Date.UTC(2023, 1, 21, 7),
    );
    // no capture: today, 10:00 site time
    const now = Date.UTC(2026, 9, 4, 15);
    expect(defaultTime(manifest([], { captures: [] }), now)).toBe(Date.UTC(2026, 9, 4, 7));
  });

  it('shows water from the data by default', () => {
    expect(defaultEnvironment(manifest([ortho]), 0)).toMatchObject({
      mode: 'sky',
      water: true,
      waterLevel: null,
    });
  });
});
