import type { Detection } from '@aio/annotate/detections';
import type { AntennasFile, ProjectManifest } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  antennaHistory,
  hotspotsOf,
  isHotspot,
  loadAntennaHistory,
  siteTracks,
} from './siteTracks';

const calls = vi.hoisted(() => ({ n: 0, files: [] as unknown[] }));
vi.mock('../shell', () => ({
  bridge: {
    call: () => {
      calls.n += 1;
      return Promise.resolve({ ok: true, value: { ok: true, files: calls.files, skipped: 0 } });
    },
  },
}));

const MANIFEST = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'Synthetic',
  origin: [0, 0, 0],
  captures: [
    { id: 'c1', label: 'February', date: '2026-02-01' },
    { id: 'c2', label: 'June', date: '2026-06-01' },
  ],
  layers: [
    {
      kind: 'photos',
      id: 'th1',
      name: 'T1',
      visible: true,
      capture: 'c1',
      items: [{ id: 'p', src: { path: 'a.jpg' } }],
    },
    {
      kind: 'photos',
      id: 'th2',
      name: 'T2',
      visible: true,
      capture: 'c2',
      items: [{ id: 'p', src: { path: 'b.jpg' } }],
    },
  ],
} as unknown as ProjectManifest;

const det = (id: string, layer: string, peak: number, x = 0): Detection =>
  ({
    id,
    pass: `thermal-${layer}.json`,
    classId: '',
    source: { kind: 'photo', layer, photo: 'p' },
    size: [640, 512],
    status: 'accepted',
    fields: [{ key: 'peak_c', label: 'Peak', type: 'number', value: peak, unit: '°C' }],
    vote: { views: 2, point: [x, 0, 0] },
  }) as unknown as Detection;

const inventory = (capture: string, az: number): AntennasFile =>
  ({
    schema: 'aio.antennas/1',
    run: { id: `run-${capture}`, captureId: capture },
    units: [
      {
        id: 'ant-a-1',
        name: 'A1',
        kind: 'panel',
        status: 'accepted',
        box: {
          centre: [0, 0, 30],
          axes: [
            [1, 0, 0],
            [0, 0, 1],
            [0, 1, 0],
          ],
          extents: [0.3, 1.4, 0.1],
        },
        azimuthGridDeg: { value: az },
      },
    ],
  }) as unknown as AntennasFile;

beforeEach(() => {
  calls.n = 0;
  antennaHistory.setState({ key: null, files: [] });
});

describe('siteTracks', () => {
  it('takes thermal passes and hot-spot classes as hot spots', () => {
    expect(isHotspot({ pass: 'thermal-th1.json', classId: '' })).toBe(true);
    expect(isHotspot({ pass: 'ai-x.json', classId: 'hot-spot' })).toBe(true);
    expect(isHotspot({ pass: 'ai-x.json', classId: 'corrosion' })).toBe(false);
    expect(hotspotsOf([det('h1', 'th1', 60)])[0]).toMatchObject({
      id: 'h1',
      layer: 'th1',
      photo: 'p',
      point: [0, 0, 0],
      widthPx: 640,
    });
  });

  it('links hot spots and antennas over the two dates', () => {
    const t = siteTracks({
      manifest: MANIFEST,
      live: inventory('c2', 12),
      history: [inventory('c1', 2)],
      detections: [det('h1', 'th1', 60), det('h2', 'th2', 66, 0.2)],
      sets: [],
    });
    expect(t.hotspots.map((x) => x.sightings.map((s) => s.ref))).toEqual([['h1', 'h2']]);
    expect(t.antennas[0]?.trends[0]).toMatchObject({ metric: 'azimuthDeg', lastChange: 10 });
    expect(t.regions).toEqual([]);
  });

  it('reads the copies once per project and live run', async () => {
    calls.files = [inventory('c1', 2)];
    await loadAntennaHistory('p', 'run-c2');
    await loadAntennaHistory('p', 'run-c2');
    expect(calls.n).toBe(1);
    expect(antennaHistory.getState().files).toHaveLength(1);
    await loadAntennaHistory('p', 'run-c3');
    expect(calls.n).toBe(2);
  });
});
