import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRaster } from './raster';

const META = {
  schema: 'aio.thermalRaster/1',
  width: 2,
  height: 2,
  family: 'flir',
  camera: 'x',
  settings: { emissivity: 0.95, distanceM: 10, airC: 25, humidityPct: 50, reflectedC: null },
  clamped: [],
  minC: 1,
  maxC: 4,
  medianC: 2,
  decoder: 'd',
  settingsKey: 'a'.repeat(64),
};

function mockFetch(files: Record<string, Uint8Array | object>) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    seen.push(url);
    const f = files[url];
    if (!f) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(f),
      arrayBuffer: () =>
        Promise.resolve(
          f instanceof Uint8Array
            ? f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)
            : null,
        ),
    });
  });
  return seen;
}
const base = 'aio://project/p%201/thermal/rasters/L/ph';
afterEach(() => vi.unstubAllGlobals());

describe('loadRaster', () => {
  it('reads the sidecar and the float32 data', async () => {
    const seen = mockFetch({
      [`${base}.json`]: META,
      [`${base}.f32`]: new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer),
    });
    const r = await loadRaster('p 1', 'L', 'ph');
    expect(r?.width).toBe(2);
    expect([...(r?.data ?? [])]).toEqual([1, 2, 3, 4]);
    expect(seen).toContain(`${base}.f32`);
  });
  it('gives null on a length mismatch, a bad schema or a missing file', async () => {
    mockFetch({
      [`${base}.json`]: META,
      [`${base}.f32`]: new Uint8Array(new Float32Array([1, 2, 3]).buffer),
    });
    expect(await loadRaster('p 1', 'L', 'ph')).toBeNull();
    mockFetch({ [`${base}.json`]: { ...META, width: 'x' } });
    expect(await loadRaster('p 1', 'L', 'ph')).toBeNull();
    mockFetch({});
    expect(await loadRaster('p 1', 'L', 'ph')).toBeNull();
  });
});
