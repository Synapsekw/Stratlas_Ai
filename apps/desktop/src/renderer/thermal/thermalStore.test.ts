import type { IpcChannel, ThermalFile, ThermalRasterIndex, ThermalSettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
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

function setup() {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const decodes: { layerId: string; photos: string[] }[] = [];
  const loads: string[] = [];
  let value = 10;
  const handlers: Partial<Record<IpcChannel, (req: unknown) => unknown>> = {
    'thermal:read': () => ({ ok: true, file: FILE }),
    'thermal:probe': () => ({ ok: true, photos: [] }),
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
    loadIndex: () => Promise.resolve(INDEX),
    decode: (layerId, photos) => {
      decodes.push({ layerId, photos });
      value = 50;
      return Promise.resolve(null);
    },
  };
  return { store: createThermalStore(deps), calls, decodes, loads };
}

describe('the thermal store', () => {
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
