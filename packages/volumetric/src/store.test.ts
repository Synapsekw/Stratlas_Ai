import type { BoundaryEdit, Layer, ProjectManifest, VolumesFile } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import {
  createVolumetricStore,
  parseVolumePrefs,
  type VolumePrefs,
  type VolumePrefStore,
  type VolumetricDeps,
} from './store';
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

/** The volumes with a third survey date, e3 (the piles as on e2). */
function withThird(f: VolumesFile): VolumesFile {
  return {
    ...f,
    captures: [
      ...f.captures,
      { epoch: 'e3', captureId: 's3', date: '2021-01-20', label: '20 Jan 2021' },
    ],
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

function memoryPrefs(): VolumePrefStore {
  const all = new Map<string, VolumePrefs>();
  return {
    read: (id) => structuredClone(all.get(id) ?? {}),
    write: (id, p) => {
      all.set(id, structuredClone(p));
    },
  };
}

function setup(
  opts: {
    edits?: BoundaryEdit[];
    noVolumes?: boolean;
    prefs?: VolumePrefStore;
    /** The survey date `s2` lined up by this much. */
    s2Shift?: { eastM: number; northM: number };
    /** A third survey date, e3. */
    third?: boolean;
  } = {},
) {
  const ws = createWorkspace();
  const opened: ProjectManifest = opts.s2Shift
    ? {
        ...manifest,
        captures: [
          {
            id: 's2',
            label: '10 Jan 2021',
            date: '2021-01-10',
            lineUp: { ...opts.s2Shift, with: 's1', at: '2026-10-16T08:00:00.000Z' },
          },
        ],
      }
    : manifest;
  ws.getState().openProject({ id: 'masafi', root: 'E:/m', manifest: opened });
  const service = {
    scene: vi.fn(() => Promise.resolve({ piles: [] })),
    section: vi.fn(() =>
      Promise.resolve({ lengthM: 10, s: [0, 10], z1: [1, 1], z2: [2, 2], cutM2: 0, fillM2: 10 }),
    ),
    changeRaster: vi.fn(),
    reliefRaster: vi.fn(),
    grid: vi.fn(() =>
      Promise.resolve({ w: 1, h: 1, res: 1, x0: 0, y1: 0, relief: [48, 62], extent: [45, 70] }),
    ),
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
        volumes: opts.noVolumes ? null : opts.third ? withThird(volumes()) : volumes(),
        edits: opts.edits ? { schema: 'aio.boundaries/1', edits: opts.edits } : null,
      });
    },
    startService: (init) => {
      started.push(init);
      return service;
    },
    ...(opts.prefs ? { prefs: opts.prefs } : {}),
  };
  const store = createVolumetricStore(deps);
  return { store, ws, service, started, reads };
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
  it('opens volumes.json and the saved edits on the last survey', async () => {
    const { store, started, reads } = setup({ edits: [savedEdit] });
    await store.getState().load();
    expect(reads).toEqual(['masafi']);
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.epoch).toBe('e2');
    expect(s.pileFigures).toEqual({});
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

describe('volumetric store: pile visibility', () => {
  it('shows no pile until one is selected; the selected pile always shows', async () => {
    const { store } = setup();
    await store.getState().load();
    const s = () => store.getState();
    expect(s().shown).toEqual([]);
    expect(s().isPileShown('P01')).toBe(false);
    expect(s().isPileShown('P02')).toBe(false);
    s().select('P02');
    expect(s().isPileShown('P02')).toBe(true);
    expect(s().isPileShown('P01')).toBe(false);
    s().select(null);
    expect(s().isPileShown('P02')).toBe(false);
  });

  it('shows piles one by one or all at once on purpose', async () => {
    const { store } = setup();
    await store.getState().load();
    const s = () => store.getState();
    s().setPileVisible('P01', true);
    expect(s().shown).toEqual(['P01']);
    expect(s().isPileShown('P01')).toBe(true);
    expect(s().isPileShown('P02')).toBe(false);
    s().setPileVisible('P01', false);
    expect(s().shown).toEqual([]);
    s().setAllPilesVisible(true);
    expect([...s().shown].sort()).toEqual(['P01', 'P02']);
    s().setAllPilesVisible(false);
    expect(s().shown).toEqual([]);
  });

  it('remembers "show all" per project, not single piles', async () => {
    const prefs = memoryPrefs();
    const { store } = setup({ prefs });
    await store.getState().load();
    store.getState().setAllPilesVisible(true);
    await store.getState().load();
    expect([...store.getState().shown].sort()).toEqual(['P01', 'P02']);
    // hiding one pile ends "all"; the next opening starts with none again
    store.getState().setPileVisible('P02', false);
    await store.getState().load();
    expect(store.getState().shown).toEqual([]);
    store.getState().setPileVisible('P01', true);
    await store.getState().load();
    expect(store.getState().shown).toEqual([]);
    // another project keeps its own choice
    expect(prefs.read('other')).toEqual({});
  });
});

describe('volumetric store: click to reveal', () => {
  it('flies to a pile picked on the terrain and hides it again on empty ground', async () => {
    const { store, ws } = setup();
    await store.getState().load();
    ws.getState().select({ kind: 'asset', id: 'P02_e2', layer: 'terrain-2' });
    expect(store.getState().selected).toBe('P02');
    expect(store.getState().isPileShown('P02')).toBe(true);
    expect(ws.getState().camera?.target).toEqual({
      kind: 'selection',
      selection: { kind: 'asset', id: 'P02_e2', layer: 'terrain-2' },
    });
    ws.getState().select(null);
    expect(store.getState().selected).toBeNull();
    expect(store.getState().isPileShown('P02')).toBe(false);
  });

  it('switches the survey when a layer of the other date is turned on by hand', async () => {
    const { store, ws } = setup();
    await store.getState().load();
    expect(store.getState().epoch).toBe('e2');
    ws.getState().setLayerVisible('ortho-1', true);
    expect(store.getState().epoch).toBe('e1');
    expect(ws.getState().isLayerVisible('terrain-2')).toBe(false);
    expect(ws.getState().isLayerVisible('terrain-1')).toBe(true);
    // swiping shows both terrains without switching
    store.getState().setSwipe(true);
    expect(store.getState().epoch).toBe('e1');
    expect(ws.getState().isLayerVisible('terrain-2')).toBe(true);
  });
});

describe('volumetric store: elevation colours', () => {
  it('starts vivid with hillshade, resolves the automatic range from the worker', async () => {
    const { store, service } = setup();
    await store.getState().load();
    expect(store.getState().elevation).toEqual({ ramp: 'turbo', range: null, hillshade: true });
    expect(store.getState().reliefStyle()).toBeNull();
    store.getState().setSurface('elev');
    await vi.waitFor(() => {
      expect(store.getState().relief).not.toBeNull();
    });
    expect(service.grid).toHaveBeenCalledTimes(1);
    expect(store.getState().reliefStyle()).toEqual({
      ramp: 'turbo',
      lo: 48,
      hi: 62,
      hillshade: true,
    });
    store.getState().setElevation({ ramp: 'viridis', range: [50, 55], hillshade: false });
    expect(store.getState().reliefStyle()).toEqual({
      ramp: 'viridis',
      lo: 50,
      hi: 55,
      hillshade: false,
    });
    // an empty range is refused
    store.getState().setElevation({ range: [55, 55] });
    expect(store.getState().elevation.range).toEqual([50, 55]);
  });

  it('remembers the ramp, range and hillshade per project', async () => {
    const prefs = memoryPrefs();
    const { store } = setup({ prefs });
    await store.getState().load();
    store.getState().setElevation({ ramp: 'inferno', range: [49, 60], hillshade: false });
    await store.getState().load();
    expect(store.getState().elevation).toEqual({
      ramp: 'inferno',
      range: [49, 60],
      hillshade: false,
    });
  });

  it('reads stored prefs defensively', () => {
    expect(parseVolumePrefs(null)).toEqual({});
    expect(parseVolumePrefs({ showAll: 'yes', elevation: { ramp: 'rainbow' } })).toEqual({});
    expect(parseVolumePrefs({ showAll: true, elevation: { ramp: 'grey', range: [5, 1] } })).toEqual(
      { showAll: true, elevation: { ramp: 'grey', range: null, hillshade: true } },
    );
  });
});

describe('volumetric store: cut / fill dates', () => {
  it('default pick is previous to current', async () => {
    const { store, ws } = setup({ third: true });
    await store.getState().load();
    store.getState().setEpoch('e2');
    store.getState().setSurface('change');
    expect(store.getState().change).toEqual({ from: 'e1', to: 'e2' });
    // the colours drape on the "to" survey
    expect(store.getState().shownEpoch()).toBe('e2');
    expect(ws.getState().isLayerVisible('terrain-2')).toBe(true);
    // the first survey has no previous one: it compares with the next
    store.getState().setSurface('photo');
    store.getState().setEpoch('e1');
    store.getState().setSurface('change');
    expect(store.getState().change).toEqual({ from: 'e1', to: 'e2' });
  });

  it('cut/fill compares the picked surveys, not first and last', async () => {
    const { store, service } = setup({ third: true });
    await store.getState().load();
    expect(store.getState().epoch).toBe('e3');
    store.getState().setSurface('change');
    expect(store.getState().change).toEqual({ from: 'e2', to: 'e3' });
    store.getState().setChange({ from: 'e1', to: 'e2' });
    expect(store.getState().change).toEqual({ from: 'e1', to: 'e2' });
    expect(store.getState().shownEpoch()).toBe('e2');
    // the same date on both sides, or a date the volumes do not have, is refused
    store.getState().setChange({ from: 'e2', to: 'e2' });
    store.getState().setChange({ from: 'e1', to: 'e9' });
    expect(store.getState().change).toEqual({ from: 'e1', to: 'e2' });
    // a From later than To swaps them: the earlier survey is always From
    store.getState().setChange({ from: 'e3', to: 'e1' });
    expect(store.getState().change).toEqual({ from: 'e1', to: 'e3' });
    store.getState().setChange({ from: 'e1', to: 'e2' });
    // the section line profiles the picked dates too
    store.getState().startSection();
    await store.getState().addSectionPoint([1000, 2000]);
    await store.getState().addSectionPoint([1010, 2000]);
    expect(service.section).toHaveBeenCalledWith([1000, 2000], [1010, 2000], 'e1', 'e2');
  });

  it('keeps the engine grid only for the dates it was computed for', async () => {
    const { store } = setup({ third: true });
    await store.getState().load();
    store.getState().setSurface('change');
    const grid = { dz: new Float32Array(1), nx: 1, ny: 1, x0: 0, y0: 0, cellM: 1 };
    store.getState().setChangeGrid({ from: 'e2', to: 'e3', grid });
    expect(store.getState().changeGrid?.grid).toBe(grid);
    store.getState().setChange({ from: 'e1', to: 'e3' });
    expect(store.getState().changeGrid).toBeNull();
    // a late answer for other dates is dropped
    store.getState().setChangeGrid({ from: 'e2', to: 'e3', grid });
    expect(store.getState().changeGrid).toBeNull();
  });

  it('has no base, register or boundary editor of its own', async () => {
    const { store } = setup();
    await store.getState().load();
    const keys = Object.keys(store.getState());
    const gone = ['base', 'setBase', 'sort', 'exportCsv', 'recomputed', 'pileProfile', 'startEdit'];
    for (const k of [...gone, 'saveEdit', 'edit']) expect(keys).not.toContain(k);
  });
});

describe('volumetric store: section', () => {
  it('profiles a section from two picked points', async () => {
    const { store, service } = setup();
    await store.getState().load();
    store.getState().startSection();
    expect(store.getState().section.mode).toBe('picking');
    await store.getState().addSectionPoint([1000, 2000]);
    await store.getState().addSectionPoint([1010, 2000]);
    expect(service.section).toHaveBeenCalledWith([1000, 2000], [1010, 2000], 'e1', 'e2');
    expect(store.getState().section).toMatchObject({ mode: 'done', profile: { fillM2: 10 } });
  });
});
