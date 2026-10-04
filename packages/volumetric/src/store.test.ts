import type {
  AioBridge,
  BoundaryEdit,
  IpcChannel,
  IpcRequest,
  Layer,
  ProjectManifest,
  VolumesFile,
} from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { EditResponse } from './model/compute';
import { createVolumetricStore, type VolumetricDeps } from './store';
import type { VolumeService } from './worker/client';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fc = (net: number) => ({ fill: net + 1, cut: 1, net });
const v4 = (n: number) => ({ tin: fc(n), plane: fc(n + 1), avg: fc(n + 2), low: fc(n + 3) });
const origin: [number, number, number] = [1000, 2000, 50];
// a dense 20 x 20 m square toe line (local x, z): the editor simplifies it to its corners
const dense: [number, number][] = [];
for (let i = 0; i < 20; i++) dense.push([i, 0]);
for (let i = 0; i < 20; i++) dense.push([20, -i]);
for (let i = 0; i < 20; i++) dense.push([20 - i, -20]);
for (let i = 0; i < 20; i++) dense.push([0, -20 + i]);

function volumes(): VolumesFile {
  const ep = (captureId: string, node: string, n: number) => ({
    captureId,
    areaM2: 400,
    topM: 60,
    heightM: 8,
    node,
    ring: dense,
    volumes: v4(n),
  });
  return {
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
        zoneRing: dense,
        change: fc(-5),
        epochs: { e1: ep('s1', 'P01_e1', 100), e2: ep('s2', 'P01_e2', 95) },
      },
      {
        id: 'P02',
        name: 'Pile 02',
        zoneRing: dense,
        change: fc(10),
        epochs: { e2: ep('s2', 'P02_e2', 10) },
      },
    ],
    totals: {},
    pileChange: fc(5),
    siteChange: fc(5),
  };
}

const layers: Layer[] = [
  {
    kind: 'mesh',
    id: 'terrain-2',
    name: 'Terrain 10 Jan 2021',
    visible: true,
    src: { path: 'a.glb' },
    transform: I,
    tags: [{ node: 'P01_e2', tag: 'P01' }],
  },
  {
    kind: 'mesh',
    id: 'terrain-1',
    name: 'Terrain 31 Dec 2020',
    visible: false,
    src: { path: 'b.glb' },
    transform: I,
    tags: [{ node: 'P01_e1', tag: 'P01' }],
  },
  {
    kind: 'raster',
    id: 'ortho-1',
    name: 'Ortho 31 Dec 2020',
    visible: false,
    src: { path: 'r.json' },
    role: 'ortho',
    format: 'kit-pyramid',
  },
];

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'masafi',
  name: 'Masafi',
  crs: { epsg: 32639 },
  origin,
  captures: [],
  layers,
  severityModels: [],
  classCatalogues: [],
};

function editResponse(net: number): EditResponse {
  const body = {
    nx: 1,
    ny: 1,
    cell: 1,
    e0: 0,
    n0: 0,
    ins: new Uint8Array(1),
    top: new Float32Array(1),
    bot: new Float32Array(1),
    tmax: 1,
    bmin: 0,
  };
  return {
    result: { volumes: v4(net), areaM2: 400, topM: 60, heightM: 8 },
    body,
    toe: new Float64Array(0),
    vertices: [],
  };
}

function setup(opts: { edits?: BoundaryEdit[]; noVolumes?: boolean } = {}) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'masafi', root: 'E:/m', manifest });
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: AioBridge = {
    invoke: (<C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      calls.push({ channel, req });
      if (channel === 'dialog:saveFile') return Promise.resolve({ path: 'C:/out.csv' });
      return Promise.resolve({ ok: true });
    }) as AioBridge['invoke'],
    on: () => () => undefined,
  };
  const service = {
    recompute: vi.fn(() => Promise.resolve({ e1: v4(100), e2: v4(95) })),
    scene: vi.fn(() => Promise.resolve({ piles: [] })),
    edit: vi.fn(() => Promise.resolve(editResponse(80))),
    section: vi.fn(() =>
      Promise.resolve({ lengthM: 10, s: [0, 10], z1: [1, 1], z2: [2, 2], cutM2: 0, fillM2: 10 }),
    ),
    pileSection: vi.fn(() => Promise.resolve({ s: [], z1: [], z2: [], base: [] })),
    changeRaster: vi.fn(),
    reliefRaster: vi.fn(),
    grid: vi.fn(),
    heights: vi.fn(),
    dispose: vi.fn(),
  } as unknown as VolumeService;
  const started: unknown[] = [];
  const reads: string[] = [];
  const deps: VolumetricDeps = {
    workspace: ws,
    readVolumes: (projectId) => {
      reads.push(projectId);
      return Promise.resolve({
        ok: true,
        volumes: opts.noVolumes ? null : volumes(),
        edits: opts.edits ? { schema: 'aio.boundaries/1', edits: opts.edits } : null,
      });
    },
    startService: (init) => {
      started.push(init);
      return service;
    },
    bridge: () => bridge,
    now: () => '2026-10-04T12:00:00.000Z',
  };
  const store = createVolumetricStore(deps);
  return { store, ws, calls, service, started, reads };
}

const savedEdit: BoundaryEdit = {
  pile: 'P01',
  epoch: 'e2',
  ring: [
    [0, 0],
    [5, 0],
    [5, -5],
    [0, -5],
  ],
  volumes: v4(70),
  areaM2: 25,
  topM: 59,
  heightM: 7,
  autoNet: 95,
  updatedAt: '2026-10-03T10:00:00.000Z',
};

describe('volumetric store: loading', () => {
  it('opens volumes.json and the saved edits on the last survey and default base', async () => {
    const { store, started, reads } = setup({ edits: [savedEdit] });
    await store.getState().load();
    expect(reads).toEqual(['masafi']);
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.epoch).toBe('e2');
    expect(s.base).toBe('tin');
    expect(s.density).toBe(1.6);
    expect(s.piles.find((p) => p.id === 'P01')?.epochs.e2?.volumes.tin.net).toBe(70);
    expect(started[0]).toMatchObject({
      patterns: {
        pile: 'aio://project/masafi/legacy/data/piles/{id}.js',
        dsm: 'aio://project/masafi/legacy/data/dsm_{epoch}.js',
        coarse: 'aio://project/masafi/legacy/data/vol.js',
      },
      epochs: ['e1', 'e2'],
      deadband: 0.1,
    });
  });

  it('stays out of the way on projects without volumes', async () => {
    const { store, started } = setup({ noVolumes: true });
    await store.getState().load();
    expect(store.getState().status).toBe('none');
    expect(started).toHaveLength(0);
  });
});

describe('volumetric store: dates and selection', () => {
  it('shows the layers of the chosen survey only', async () => {
    const { store, ws } = setup();
    await store.getState().load();
    store.getState().setEpoch('e1');
    expect(ws.getState().isLayerVisible('terrain-1')).toBe(true);
    expect(ws.getState().isLayerVisible('ortho-1')).toBe(true);
    expect(ws.getState().isLayerVisible('terrain-2')).toBe(false);
    store.getState().setSwipe(true);
    expect(ws.getState().isLayerVisible('terrain-1')).toBe(true);
    expect(ws.getState().isLayerVisible('terrain-2')).toBe(true);
  });

  it('shows the last survey under the change colours, and one ortho while swiping', async () => {
    const { store, ws } = setup();
    await store.getState().load();
    store.getState().setEpoch('e1');
    store.getState().setSurface('change');
    expect(store.getState().shownEpoch()).toBe('e2');
    expect(ws.getState().isLayerVisible('terrain-2')).toBe(true);
    expect(ws.getState().isLayerVisible('terrain-1')).toBe(false);
    store.getState().setSurface('photo');
    store.getState().setSwipe(true);
    expect(ws.getState().isLayerVisible('ortho-1')).toBe(true);
    store.getState().setEpoch('e2');
    store.getState().setSwipe(true);
    expect(ws.getState().isLayerVisible('ortho-1')).toBe(false);
    expect(ws.getState().isLayerVisible('terrain-1')).toBe(true);
  });

  it('selects the pile node in the scene and flies to it', async () => {
    const { store, ws } = setup();
    await store.getState().load();
    store.getState().select('P01');
    expect(ws.getState().selection).toEqual({ kind: 'asset', id: 'P01_e2', layer: 'terrain-2' });
    expect(ws.getState().camera?.target).toEqual({
      kind: 'selection',
      selection: { kind: 'asset', id: 'P01_e2', layer: 'terrain-2' },
    });
  });

  it('follows a pile picked in the scene', async () => {
    const { store, ws } = setup();
    await store.getState().load();
    ws.getState().select({ kind: 'asset', id: 'P02_e2', layer: 'terrain-2' });
    expect(store.getState().selected).toBe('P02');
    ws.getState().select(null);
    expect(store.getState().selected).toBeNull();
  });
});

describe('volumetric store: boundary editor', () => {
  it('starts from the simplified automatic line and recomputes in the worker', async () => {
    const { store, service } = setup();
    await store.getState().load();
    store.getState().select('P01');
    await store.getState().startEdit();
    const e = store.getState().edit;
    expect(e?.pile).toBe('P01');
    expect(e?.ring).toHaveLength(4);
    expect(e?.ring).toContainEqual([1020, 2020]);
    expect(e?.dirty).toBe(false);
    expect(service.edit).toHaveBeenCalled();
    expect(store.getState().edit?.live?.result.volumes.tin.net).toBe(80);
  });

  it('moves, inserts and deletes points with undo', async () => {
    const { store } = setup();
    await store.getState().load();
    store.getState().select('P01');
    await store.getState().startEdit();
    await store.getState().moveVertex(0, [999, 2001]);
    expect(store.getState().edit?.ring[0]).toEqual([999, 2001]);
    expect(store.getState().edit?.dirty).toBe(true);
    await store.getState().insertVertex(0, [1010, 2001]);
    expect(store.getState().edit?.ring).toHaveLength(5);
    await store.getState().deleteVertex(1);
    expect(store.getState().edit?.ring).toHaveLength(4);
    await store.getState().undo();
    await store.getState().undo();
    await store.getState().undo();
    expect(store.getState().edit?.ring[0]).toEqual([1000, 2000]);
    expect(store.getState().edit?.dirty).toBe(false);
  });

  it('keeps at least three points', async () => {
    const { store } = setup();
    await store.getState().load();
    store.getState().select('P01');
    await store.getState().startEdit();
    await store.getState().deleteVertex(0);
    expect(store.getState().edit?.ring).toHaveLength(3);
    await store.getState().deleteVertex(0);
    expect(store.getState().edit?.ring).toHaveLength(3);
    expect(store.getState().message).toMatch(/three points/);
  });

  it('saves the edit in the local frame through project:writeBoundaries', async () => {
    const { store, calls } = setup();
    await store.getState().load();
    store.getState().select('P01');
    await store.getState().startEdit();
    await store.getState().moveVertex(0, [999, 2001]);
    expect(await store.getState().saveEdit()).toBe(true);
    const call = calls.find((c) => c.channel === 'project:writeBoundaries');
    expect(call?.req).toMatchObject({
      projectId: 'masafi',
      file: {
        schema: 'aio.boundaries/1',
        edits: [
          {
            pile: 'P01',
            epoch: 'e2',
            volumes: v4(80),
            autoNet: 95,
            updatedAt: '2026-10-04T12:00:00.000Z',
          },
        ],
      },
    });
    const req = call?.req as { file: { edits: BoundaryEdit[] } };
    expect(req.file.edits[0]?.ring[0]).toEqual([-1, -1]);
    const s = store.getState();
    expect(s.edit).toBeNull();
    expect(s.piles.find((p) => p.id === 'P01')?.edited).toEqual(['e2']);
    expect(s.piles.find((p) => p.id === 'P01')?.epochs.e2?.volumes.tin.net).toBe(80);
  });

  it('never edits or saves boundaries in a read-only package', async () => {
    const { store, calls } = setup({ edits: [savedEdit] });
    store.getState().setReadOnly(true);
    await store.getState().load();
    expect(store.getState().readOnly).toBe(true);
    store.getState().select('P01');
    await store.getState().startEdit();
    expect(store.getState().edit).toBeNull();
    expect(await store.getState().revert('P01', 'e2')).toBe(false);
    expect(store.getState().message).toMatch(/read-only/);
    expect(calls.some((c) => c.channel === 'project:writeBoundaries')).toBe(false);
    expect(store.getState().piles.find((p) => p.id === 'P01')?.edited).toEqual(['e2']);
  });

  it('reverts to the automatic line by removing the saved edit', async () => {
    const { store, calls } = setup({ edits: [savedEdit] });
    await store.getState().load();
    store.getState().select('P01');
    expect(await store.getState().revert('P01', 'e2')).toBe(true);
    const req = calls.at(-1)?.req as { file: { edits: BoundaryEdit[] } };
    expect(req.file.edits).toEqual([]);
    expect(store.getState().piles.find((p) => p.id === 'P01')?.edited).toEqual([]);
  });

  it('continues a saved edit from its own line', async () => {
    const { store } = setup({ edits: [savedEdit] });
    await store.getState().load();
    store.getState().select('P01');
    await store.getState().startEdit();
    expect(store.getState().edit?.ring).toEqual([
      [1000, 2000],
      [1005, 2000],
      [1005, 2005],
      [1000, 2005],
    ]);
  });
});

describe('volumetric store: section and export', () => {
  it('profiles a section from two picked points', async () => {
    const { store, service } = setup();
    await store.getState().load();
    store.getState().startSection();
    expect(store.getState().section.mode).toBe('picking');
    await store.getState().addSectionPoint([1000, 2000]);
    await store.getState().addSectionPoint([1010, 2000]);
    expect(service.section).toHaveBeenCalledWith([1000, 2000], [1010, 2000]);
    expect(store.getState().section).toMatchObject({ mode: 'done', profile: { fillM2: 10 } });
  });

  it('exports the register as CSV through the save dialog', async () => {
    const { store, calls } = setup();
    await store.getState().load();
    await store.getState().exportCsv();
    const call = calls.find((c) => c.channel === 'dialog:saveFile');
    const req = call?.req as { defaultName: string; data: string };
    expect(req.defaultName).toBe('Masafi stockpile register.csv');
    expect(req.data.split('\n')[1]?.startsWith('P01,Pile 01,')).toBe(true);
  });
});
