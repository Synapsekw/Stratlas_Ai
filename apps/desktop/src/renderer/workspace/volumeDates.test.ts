import type { Layer, ProjectManifest, VolumesFile } from '@aio/schema';
import { createVolumetricStore, type VolumetricDeps } from '@aio/volumetric';
import { captureIndex, createWorkspace, type DatePref } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { volumeHints } from './compare';
import { createTimelineStore, TIMELINE_KEY } from './timeline';
import { connectVolumeDates } from './volumeDates';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const terrain = (id: string, capture: string, epoch: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  capture,
  src: { path: `${id}.glb` },
  transform: I,
  tags: [{ node: `P01_${epoch}`, tag: 'P01' }],
});
const ortho = (id: string, capture: string, name: string): Layer => ({
  kind: 'raster',
  id,
  name,
  visible: true,
  capture,
  role: 'ortho',
  format: 'kit-pyramid',
  src: { path: `${id}.json` },
});
const clip = (id: string, capture: string, startUtcMs: number): Layer =>
  ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    capture,
    src: { path: `${id}.mp4` },
    flight: { src: { path: `${id}.json` }, startUtcMs },
    offsetMs: 0,
  }) as unknown as Layer;

/** Two stockpile surveys (31 Dec, 10 Jan), terrain, ortho and a clip each, and a site layer. */
const stockpile = {
  schema: 'aio.project/1',
  id: 'm',
  name: 'M',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [
    { id: 's1', label: '31 Dec 2020', date: '2020-12-31' },
    { id: 's2', label: '10 Jan 2021', date: '2021-01-10' },
  ],
  layers: [
    clip('clip-1', 's1', 1_000_000),
    terrain('terrain-1', 's1', 'e1'),
    ortho('ortho-1', 's1', 'Ortho 31 Dec 2020'),
    terrain('terrain-2', 's2', 'e2'),
    ortho('ortho-2', 's2', 'Ortho 10 Jan 2021'),
    clip('clip-2', 's2', 2_000_000),
    { kind: 'mesh', id: 'site', name: 'site', visible: true, src: { path: 's.glb' }, transform: I },
  ],
} as unknown as ProjectManifest;

const ring: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, -1],
];
const fc = { fill: 1, cut: 0, net: 1 };
const v4 = { tin: fc, plane: fc, avg: fc, low: fc };
const ep = (captureId: string, node: string) => ({
  captureId,
  areaM2: 1,
  topM: 1,
  heightM: 1,
  node,
  ring,
  volumes: v4,
});
const volumesFile = {
  schema: 'aio.volumes/1',
  densityTPerM3: 1.6,
  deadbandM: 0.1,
  defaultBase: 'tin',
  bases: [{ id: 'tin', label: 'Triangulated toe' }],
  captures: [
    { epoch: 'e1', captureId: 's1', date: '2020-12-31', label: '31 Dec 2020' },
    { epoch: 'e2', captureId: 's2', date: '2021-01-10', label: '10 Jan 2021' },
  ],
  piles: [
    {
      id: 'P01',
      name: 'Pile 01',
      zoneRing: ring,
      change: fc,
      epochs: { e1: ep('s1', 'P01_e1'), e2: ep('s2', 'P01_e2') },
    },
  ],
  totals: {},
  pileChange: fc,
  siteChange: fc,
} as unknown as VolumesFile;

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
  key() {
    return null;
  }
  get length() {
    return this.data.size;
  }
}

async function setup() {
  const ws = createWorkspace();
  const storage = new MemoryStorage();
  const tl = createTimelineStore(ws, storage, () => undefined);
  const deps: VolumetricDeps = {
    workspace: ws,
    readVolumes: (projectId) =>
      Promise.resolve({ ok: true, volumes: projectId === 'm' ? volumesFile : null, edits: null }),
    startService: () =>
      ({ dispose: () => undefined }) as unknown as ReturnType<VolumetricDeps['startService']>,
    bridge: () => null,
    now: () => '2026-10-08T00:00:00.000Z',
  };
  const v = createVolumetricStore(deps);
  const off = connectVolumeDates(v, tl, ws);
  // what the app does on open: the timeline attaches, the volumes load
  ws.getState().openProject({ id: 'm', root: '/m', manifest: stockpile });
  tl.getState().attach('m', captureIndex(stockpile));
  await v.getState().load();
  tl.getState().attach('m', captureIndex(stockpile, volumeHints(v.getState())));
  const saved = () =>
    (JSON.parse(storage.getItem(TIMELINE_KEY) ?? '{}') as Record<string, DatePref>).m;
  return { ws, tl, v, off, saved };
}

describe('date bar and stockpile volumes', () => {
  it('hands the survey layers to the loaded volumes and mirrors their survey', async () => {
    const { tl, v } = await setup();
    expect(tl.getState().owner).toBe('volumetric');
    expect(v.getState().epoch).toBe('e2');
    expect(tl.getState().focus).toBe('s2');
  });

  it('a date bar jump asks the volumes for the survey and lets them switch the layers', async () => {
    const { ws, tl, v } = await setup();
    const hiddenBefore = ws.getState().hidden;
    const asked: string[] = [];
    const own = v.getState();
    v.setState({
      setEpoch: (e) => {
        asked.push(e);
        own.setEpoch(e);
      },
    });
    tl.getState().focusSurvey('s1');
    expect(asked).toEqual(['e1']);
    expect(tl.getState().focus).toBe('s1');
    // the volumes' own switch: their survey's layers on, the other survey's off
    const h = ws.getState().hidden;
    expect(h['terrain-1']).toBeUndefined();
    expect(h['ortho-1']).toBeUndefined();
    expect(h['terrain-2']).toBe(true);
    expect(h['ortho-2']).toBe(true);
    // the timeline swapped nothing itself: the clips of either date are as they were
    expect(h['clip-1']).toBe(hiddenBefore['clip-1']);
    expect(h['clip-2']).toBe(hiddenBefore['clip-2']);
  });

  it('a Volumes date button moves the date bar, with the video and clock', async () => {
    const { ws, tl, v } = await setup();
    expect(ws.getState().activeClip).toBe('clip-2');
    ws.getState().setTime(2_000_000 + 4_000);
    v.getState().setEpoch('e1');
    expect(tl.getState().focus).toBe('s1');
    expect(ws.getState().activeClip).toBe('clip-1');
    expect(ws.getState().nowMs).toBe(1_000_000 + 4_000);
  });

  it('keeps the date bar put while a boundary edit holds the survey', async () => {
    const { tl, v } = await setup();
    v.setState({ edit: { epoch: 'e2' } as unknown as ReturnType<typeof v.getState>['edit'] });
    tl.getState().focusSurvey('s1');
    expect(v.getState().epoch).toBe('e2');
    expect(tl.getState().focus).toBe('s2');
  });

  it('stepping away and back saves the date only, never hides of the volume dates', async () => {
    const { ws, tl, saved } = await setup();
    tl.getState().step(-1);
    tl.getState().step(1);
    expect(saved()).toEqual({ focus: 's2' });
    expect(ws.getState().hidden['terrain-2']).toBeUndefined();
    expect(ws.getState().hidden['ortho-2']).toBeUndefined();
  });

  it('a plain project opened after a stockpile one is the timeline again', async () => {
    const { ws, tl, v } = await setup();
    ws.getState().openProject({ id: 'p', root: '/p', manifest: threeDates });
    await v.getState().load();
    tl.getState().attach('p', captureIndex(threeDates));
    expect(v.getState().status).toBe('none');
    expect(tl.getState().owner).toBe('timeline');
    // the timeline swaps the plain project's dates itself
    tl.getState().focusSurvey('oct');
    expect(ws.getState().hidden['model-nov']).toBe(true);
    expect(ws.getState().hidden['model-oct']).toBeUndefined();
  });
});
