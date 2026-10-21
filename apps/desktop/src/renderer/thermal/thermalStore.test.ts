import type { IpcChannel, ThermalFile, ThermalRasterIndex, ThermalSettings } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { Bridge, Res } from '../bridge';
import { autoRange } from './autoRange';
import type { ThermalRaster } from './raster';
import { createThermalStore, type ThermalDeps } from './thermalStore';

const S: ThermalSettings = {
  emissivity: 0.9,
  distanceM: 5,
  airC: 20,
  humidityPct: 40,
  reflectedC: null,
};
const FILE: ThermalFile = {
  schema: 'aio.thermal/1',
  photos: { 'L/a': { settings: S } },
  readings: [
    {
      id: 'r1',
      layer: 'L',
      photo: 'a',
      geom: { type: 'point', p: [1, 1] } as never,
      stats: { maxC: 1, minC: 1, meanC: 1 },
    },
  ],
  hotspots: [],
};
const INDEX: ThermalRasterIndex = {
  schema: 'aio.thermalRaster/1',
  photos: { a: { status: 'ok' } },
};
const raster = (v: number): ThermalRaster => ({
  width: 2,
  height: 1,
  data: Float32Array.from([v, v + 1]),
  meta: {} as ThermalRaster['meta'],
});

/** A store whose raster loads wait until the test resolves them. */
function setupDeferred() {
  const pending = new Map<string, (r: ThermalRaster) => void>();
  const store = createThermalStore({
    bridge: {
      call: (channel) =>
        Promise.resolve(
          (channel === 'thermal:read'
            ? { ok: true, value: { ok: true, file: FILE } }
            : { ok: true, value: { ok: true, photos: [] } }) as Res<never>,
        ),
    },
    loadRaster: (_p, _l, photoId) =>
      new Promise<ThermalRaster>((r) => {
        pending.set(photoId, r);
      }),
    loadIndex: () => Promise.resolve(INDEX),
    decode: () => Promise.resolve(null),
  });
  const deps = {
    /** Resolve the load of `photoId` once it has started. */
    resolve: async (photoId: string, r: ThermalRaster) => {
      await vi.waitFor(() => {
        expect(pending.has(photoId)).toBe(true);
      });
      pending.get(photoId)?.(r);
    },
  };
  return { store, deps };
}

function setup(index: ThermalRasterIndex | null = INDEX) {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const decodes: { layerId: string; photos: string[] }[] = [];
  const loads: string[] = [];
  let value = 10;
  const handlers: Partial<Record<IpcChannel, (req: unknown) => unknown>> = {
    'thermal:read': () => ({ ok: true, file: FILE }),
    'thermal:probe': () => ({
      ok: true,
      photos: [
        { photoId: 'a', family: 'flir', make: 'DJI', model: 'XT2' },
        { photoId: 'w', family: null, make: null, model: null },
        { photoId: 'b', family: 'flir', make: 'DJI', model: 'XT2' },
      ],
    }),
    'thermal:write': () => ({ ok: true }),
  };
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      const h = handlers[channel];
      return Promise.resolve(
        (h ? { ok: true, value: h(req) } : { ok: false, error: 'no' }) as Res<never>,
      );
    },
  };
  const deps: ThermalDeps = {
    bridge,
    loadRaster: (_p, _l, photoId) => {
      loads.push(photoId);
      return Promise.resolve(raster(value));
    },
    loadIndex: () => Promise.resolve(index),
    decode: (layerId, photos) => {
      decodes.push({ layerId, photos });
      value = 50;
      return Promise.resolve(null);
    },
  };
  return { store: createThermalStore(deps), calls, decodes, loads };
}

describe('the thermal store', () => {
  it('a new pick clears the raster on show until its own has loaded', async () => {
    const { store, deps } = setupDeferred();
    const first = store.getState().open('p', 'L', 'a');
    await deps.resolve('a', raster(10));
    await first;
    expect(store.getState().currentOf).toBe('a');
    const second = store.getState().select('b');
    expect(store.getState().photoId).toBe('b');
    expect(store.getState().current).toBeNull();
    expect(store.getState().currentOf).toBeNull();
    await deps.resolve('b', raster(70));
    await second;
    expect(store.getState().current).toEqual(raster(70));
    expect(store.getState().currentOf).toBe('b');
  });

  it('a decode of another layer does not write its index over the open one', async () => {
    let releaseIndex: (i: ThermalRasterIndex) => void = () => undefined;
    let indexCalls = 0;
    const store = createThermalStore({
      bridge: {
        call: (channel) =>
          Promise.resolve(
            (channel === 'thermal:read'
              ? { ok: true, value: { ok: true, file: FILE } }
              : channel === 'thermal:write'
                ? { ok: true, value: { ok: true } }
                : {
                    ok: true,
                    value: {
                      ok: true,
                      photos: [{ photoId: 'b', family: 'flir', make: null, model: null }],
                    },
                  }) as Res<never>,
          ),
      },
      loadRaster: () => Promise.resolve(raster(1)),
      loadIndex: () => {
        indexCalls++;
        // the third read is the reload after the decode of L
        if (indexCalls === 2)
          return new Promise<ThermalRasterIndex>((r) => {
            releaseIndex = r;
          });
        return Promise.resolve(indexCalls === 1 ? null : INDEX);
      },
      decode: () => Promise.resolve(null),
    });
    await store.getState().open('p', 'L', 'b');
    const decoding = store.getState().decodeMissing();
    await vi.waitFor(() => {
      expect(indexCalls).toBe(2);
    });
    await store.getState().open('p', 'M');
    releaseIndex({ schema: 'aio.thermalRaster/1', photos: { b: { status: 'ok' } } });
    await decoding;
    expect(store.getState().layerId).toBe('M');
    expect(store.getState().index).toEqual(INDEX);
  });

  it('a read-only open never probes and works from the raster index', async () => {
    const { store, calls, decodes } = setup();
    await store.getState().open('p', 'L', 'a', { readOnly: true });
    expect(calls.map((c) => c.channel)).toEqual(['thermal:read']);
    const s = store.getState();
    expect(s.readOnly).toBe(true);
    expect(s.probe).toBeNull();
    expect(s.index).toEqual(INDEX);
    expect(s.current).toEqual(raster(10));
    await s.decodeMissing();
    await s.saveSettings(['L/a'], { airC: 1 });
    expect(decodes).toEqual([]);
    expect(calls.some((c) => c.channel === 'thermal:write')).toBe(false);
  });

  it('decodeMissing starts one decode for the thermal photos with no raster, once', async () => {
    const { store, decodes, loads } = setup();
    await store.getState().open('p', 'L', 'a');
    loads.length = 0;
    await store.getState().decodeMissing();
    await store.getState().decodeMissing();
    // `a` has a raster entry, `w` is not thermal
    expect(decodes).toEqual([{ layerId: 'L', photos: ['b'] }]);
    expect(loads).toEqual([]);
  });

  it('decodeMissing reloads the index and the shown photo when it was decoded', async () => {
    const { store, decodes, loads } = setup(null);
    await store.getState().open('p', 'L', 'a');
    loads.length = 0;
    await store.getState().decodeMissing();
    expect(decodes).toEqual([{ layerId: 'L', photos: ['a', 'b'] }]);
    expect(loads).toEqual(['a']);
    expect(store.getState().current).toEqual(raster(50));
    expect(store.getState().decoding).toBe(false);
  });

  it('nothing missing: no decode', async () => {
    const { store, decodes } = setup({
      schema: 'aio.thermalRaster/1',
      photos: { a: { status: 'ok' }, b: { status: 'unverified' } },
    });
    await store.getState().open('p', 'L', 'a');
    await store.getState().decodeMissing();
    expect(decodes).toEqual([]);
  });

  it('opens a layer: file, probe, index and the first photo with an auto range', async () => {
    const { store } = setup();
    await store.getState().open('p', 'L', 'a');
    const s = store.getState();
    expect(s.file).toEqual(FILE);
    expect(s.index).toEqual(INDEX);
    expect(s.current).toEqual(raster(10));
    expect(s.range).toEqual(autoRange(raster(10)));
  });

  it('saveSettings writes once, starts one job for those photos and reloads their rasters', async () => {
    const { store, calls, decodes, loads } = setup();
    await store.getState().open('p', 'L', 'a');
    loads.length = 0;
    await store.getState().saveSettings(['L/a', 'L/b'], { emissivity: 0.5 });
    const writes = calls.filter((c) => c.channel === 'thermal:write');
    expect(writes).toHaveLength(1);
    const written = (writes[0]?.req as { file: ThermalFile }).file;
    expect(written.photos['L/a']?.settings.emissivity).toBe(0.5);
    expect(written.photos['L/b']?.settings.emissivity).toBe(0.5);
    expect(decodes).toEqual([{ layerId: 'L', photos: ['a', 'b'] }]);
    expect(loads).toEqual(['a']);
    expect(store.getState().current).toEqual(raster(50));
  });

  it('never clears readings or hot spots', async () => {
    const { store, calls } = setup();
    await store.getState().open('p', 'L', 'a');
    await store.getState().saveSettings(['L/a'], { airC: 1 });
    expect(store.getState().file?.readings).toEqual(FILE.readings);
    const w = calls.find((c) => c.channel === 'thermal:write')?.req as { file: ThermalFile };
    expect(w.file.readings).toEqual(FILE.readings);
    expect(w.file.hotspots).toEqual(FILE.hotspots);
  });

  it('does not start a job when the write fails', async () => {
    const { store, decodes } = setup();
    await store.getState().open('p', 'L', 'a');
    // a store whose write is refused
    const bad = createThermalStore({
      bridge: {
        call: (channel) =>
          Promise.resolve(
            (channel === 'thermal:write'
              ? { ok: false, error: 'read only' }
              : channel === 'thermal:read'
                ? { ok: true, value: { ok: true, file: FILE } }
                : { ok: true, value: { ok: true, photos: [] } }) as Res<never>,
          ),
      },
      loadRaster: () => Promise.resolve(null),
      loadIndex: () => Promise.resolve(null),
      decode: () => {
        decodes.push({ layerId: 'x', photos: [] });
        return Promise.resolve(null);
      },
    });
    await bad.getState().open('p', 'L');
    await bad.getState().saveSettings(['L/a'], { airC: 1 });
    expect(decodes).toHaveLength(0);
    expect(bad.getState().error).toBe('read only');
  });
});
