import type { EditorState, PlaceResult } from '@aio/annotate';
import {
  decodeSelection,
  err,
  ok,
  type Issue,
  type ProjectManifest,
  type Sighting,
  type Vec3,
} from '@aio/schema';
import { captureIndex, createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import {
  createPlacementStore,
  followProject,
  stepSelectionName,
  type PlacementDeps,
  type SelectionWrite,
} from './store';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'd1', label: 'First', date: '2026-03-03' },
    { id: 'd2', label: 'Second', date: '2026-09-01' },
  ],
  layers: [
    {
      kind: 'mesh',
      id: 'model-d1',
      name: 'Model 3 Mar',
      visible: false,
      capture: 'd1',
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'mesh',
      id: 'model-d2',
      name: 'Model 1 Sep',
      visible: true,
      capture: 'd2',
      src: { path: 'b.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud-d2',
      name: 'Cloud 1 Sep',
      visible: false,
      capture: 'd2',
      src: { path: 'c.json' },
      format: 'png-packed',
    },
    { kind: 'photos', id: 'photos-d1', name: 'Photos 1', visible: true, capture: 'd1', items: [] },
    { kind: 'photos', id: 'photos-d2', name: 'Photos 2', visible: true, capture: 'd2', items: [] },
  ],
  severityModels: [
    { id: 'sev', name: 'Sev', levels: [{ value: 1, label: 'L', color: '#888888', criteria: '' }] },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'C',
      assetType: 'site',
      classes: [{ id: 'marker', label: 'Marker', color: '#aa00aa', severityModel: 'sev' }],
    },
  ],
};
const square = (x: number): Vec3[] => [
  [x, 0, 0],
  [x + 1, 0, 0],
  [x + 1, 0, 1],
  [x, 0, 1],
];
const photo = (layer: string): Sighting => ({
  on: 'image',
  layer,
  photo: 'P1',
  geom: { type: 'box', x: 1, y: 1, w: 20, h: 20 },
});
const autoPin: Sighting = {
  on: 'mesh',
  layer: 'model-d2',
  geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
  from: { sighting: 0 },
};
const issue = (id: string, code: string, sightings: Sighting[]): Issue => ({
  id,
  code,
  classId: 'marker',
  severityModelId: 'sev',
  severity: 1,
  status: 'draft',
  title: code,
  note: '',
  author: 'Demo',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  sightings,
  source: 'agent',
});
const A = issue('a', 'F01', [photo('photos-d2'), autoPin]);
const B = issue('b', 'F02', [photo('photos-d2')]);
const PIN = issue('c', 'F03', [autoPin]);
const OLD = issue('e', 'F04', [
  photo('photos-d1'),
  {
    on: 'mesh',
    layer: 'model-d1',
    geom: { type: 'spolygon', points: square(0.1) },
    from: { sighting: 0 },
  },
]);

function setup(over: Partial<PlacementDeps> = {}, results: Record<string, PlaceResult> = {}) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'r', manifest }, [A, B, PIN, OLD]);
  ws.getState().setDates(captureIndex(manifest));
  const state: EditorState = {
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    save: { state: 'saved' },
    lastError: null,
  };
  const editor = {
    state,
    commitIssues: vi.fn((list: readonly Issue[], label: string) => {
      for (const i of list) ws.getState().upsertIssue(i);
      editor.state = { ...editor.state, canUndo: true, undoLabel: label };
      return ok(null);
    }),
    undo: vi.fn(() => true),
  };
  const placed: PlaceResult = {
    ok: true,
    sightings: [
      {
        on: 'mesh',
        layer: 'model-d2',
        geom: { type: 'spolygon', points: square(0) },
        from: { sighting: 0 },
      },
    ],
    from: 0,
    hitRate: 1,
  };
  const deps: PlacementDeps = {
    workspace: ws,
    editor,
    place: vi.fn((i: Issue) =>
      Promise.resolve<PlaceResult>(
        results[i.id] ?? (i.id === 'a' ? placed : { ok: false, reason: 'missed' }),
      ),
    ),
    prepare: vi.fn(() => Promise.resolve()),
    writeSelection: vi.fn(() => Promise.resolve<SelectionWrite>({ path: 'selections/x.sel' })),
    ready: vi.fn(() => Promise.resolve(true)),
    now: () => '2026-10-15T12:00:00.000Z',
    newId: () => 'track-1',
    ...over,
  };
  return { ws, editor, deps, store: createPlacementStore(deps) };
}

describe('the placement offer', () => {
  it('offers the issues with a photo shape, on a layer of their date first, and merges offers', () => {
    const { store } = setup();
    store.getState().offerIds(['a', 'c'], 'detections');
    expect(store.getState().offer).toEqual({ ids: ['a'], source: 'detections' });
    expect(store.getState().layerId).toBe('model-d2');
    store.getState().offerIds(['b'], 'detections');
    expect(store.getState().offer?.ids).toEqual(['a', 'b']);
    store.getState().notNow();
    expect(store.getState().offer).toBeNull();
    store.getState().offerIds(['c'], 'menu');
    expect(store.getState().offer).toBeNull();
  });
});

describe('placing', () => {
  it('places in one editor step, replaces the automatic pin and counts the misses', async () => {
    const { store, ws, editor } = setup();
    store.getState().offerIds(['a', 'b'], 'detections');
    const r = await store.getState().place();
    expect(r).toMatchObject({
      placed: 1,
      missed: 1,
      total: 2,
      layerName: 'Model 1 Sep',
      label: 'Place 1 issue on Model 1 Sep',
    });
    expect(editor.commitIssues).toHaveBeenCalledTimes(1);
    const a = ws.getState().issues.find((i) => i.id === 'a');
    expect(a?.sightings.map((s) => (s.on === 'mesh' ? s.geom.type : s.on))).toEqual([
      'image',
      'spolygon',
    ]);
    expect(store.getState().offer).toBeNull();
    expect(store.getState().result?.placed).toBe(1);
  });

  it('writes the selection file of a cloud finding and adds its sighting', async () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const cloudResult: PlaceResult = {
      ok: true,
      sightings: [
        {
          on: 'pointcloud',
          layer: 'cloud-d2',
          geom: { type: 'polygon3', points: square(0), height: 0.2 },
          from: { sighting: 0 },
        },
      ],
      from: 0,
      hitRate: 1,
      selection: { positions, count: 2, lod: 3 },
    };
    const { store, ws, deps } = setup({}, { a: cloudResult });
    await store.getState().placeIds(['a'], 'cloud-d2');
    const [projectId, name, bytes] = vi.mocked(deps.writeSelection).mock.calls[0] ?? [];
    // a name of its own per write: Undo puts back a sighting whose file still holds its points
    expect([projectId, name]).toEqual(['p', 'a-cloud-d2-20261015120000000']);
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,120}$/);
    expect(decodeSelection(bytes ?? new Uint8Array())?.lod).toBe(3);
    const a = ws.getState().issues.find((i) => i.id === 'a');
    expect(a?.sightings.at(-1)).toEqual({
      on: 'pointcloud',
      layer: 'cloud-d2',
      geom: { type: 'selection', src: { path: 'selections/x.sel' }, count: 2, lod: 3 },
      from: { sighting: 0 },
    });
  });

  it('places an issue whose photo size was unknown: prepare learns it before projecting', async () => {
    const order: string[] = [];
    // the projector finds no photo outline until the photo's pixel size is known
    const known = new Set<string>();
    const placedB: PlaceResult = {
      ok: true,
      sightings: [
        {
          on: 'mesh',
          layer: 'model-d2',
          geom: { type: 'spolygon', points: square(5) },
          from: { sighting: 0 },
        },
      ],
      from: 0,
      hitRate: 1,
    };
    const { store, ws } = setup({
      prepare: vi.fn((i: Issue) => {
        order.push(`prepare ${i.id}`);
        known.add(i.id);
        return Promise.resolve();
      }),
      place: vi.fn((i: Issue) => {
        order.push(`place ${i.id}`);
        return Promise.resolve<PlaceResult>(
          known.has(i.id) ? placedB : { ok: false, reason: 'no-photo-shape' },
        );
      }),
    });
    const r = await store.getState().placeIds(['b'], 'model-d2');
    expect(order).toEqual(['prepare b', 'place b']);
    expect(r).toMatchObject({ placed: 1, noPhoto: 0 });
    const b = ws.getState().issues.find((i) => i.id === 'b');
    expect(b?.sightings.at(-1)?.on).toBe('mesh');
  });

  it('reports every issue as not loaded when the layer never becomes ready', async () => {
    const { store, deps, editor } = setup({ ready: vi.fn(() => Promise.resolve(false)) });
    const r = await store.getState().placeIds(['a', 'b'], 'model-d1');
    expect(r).toMatchObject({ placed: 0, notLoaded: 2 });
    expect(deps.place).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(editor.commitIssues).not.toHaveBeenCalled();
  });

  it('shows the editor refusal and writes nothing', async () => {
    const { store, editor } = setup();
    editor.commitIssues.mockImplementation(() =>
      err<null>('This project is a read-only package. Issues cannot be changed.'),
    );
    expect(await store.getState().placeIds(['a'], 'model-d2')).toBeNull();
    expect(store.getState().error).toContain('read-only package');
    expect(store.getState().busy).toBe(false);
  });

  it('ends busy and shows the error when placing throws', async () => {
    const { store, editor } = setup({ place: vi.fn(() => Promise.reject(new Error('boom'))) });
    expect(await store.getState().placeIds(['a'], 'model-d2')).toBeNull();
    expect(store.getState()).toMatchObject({ busy: false, error: 'boom' });
    expect(editor.commitIssues).not.toHaveBeenCalled();
  });

  it('undo only undoes its own step', async () => {
    const { store, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    store.getState().undo();
    expect(editor.undo).toHaveBeenCalledTimes(1);
    await store.getState().placeIds(['a'], 'model-d2');
    editor.state = { ...editor.state, undoLabel: 'Edit F09' };
    store.getState().undo();
    expect(editor.undo).toHaveBeenCalledTimes(1);
    expect(store.getState().result).toBeNull();
    // the bar can say why nothing was undone
    expect(store.getState().undoStale).toBe(true);
    store.getState().dismiss();
    expect(store.getState().undoStale).toBe(false);
  });

  it('builds on the issue as it is at commit: edits made while placing stay', async () => {
    const { store, ws } = setup({
      place: vi.fn((i: Issue) => {
        // someone retitles the issue while the projection runs
        const now = ws.getState().issues.find((x) => x.id === i.id);
        if (now) ws.getState().upsertIssue({ ...now, title: 'Renamed meanwhile' });
        return Promise.resolve<PlaceResult>({
          ok: true,
          sightings: [
            {
              on: 'mesh',
              layer: 'model-d2',
              geom: { type: 'spolygon', points: square(0) },
              from: { sighting: 0 },
            },
          ],
          from: 0,
          hitRate: 1,
        });
      }),
    });
    const r = await store.getState().placeIds(['a'], 'model-d2');
    expect(r?.placed).toBe(1);
    const a = ws.getState().issues.find((i) => i.id === 'a');
    expect(a?.title).toBe('Renamed meanwhile');
    expect(a?.sightings.at(-1)?.on).toBe('mesh');
  });

  it('leaves an issue whose photo sighting went while placing, and says so', async () => {
    const { store, ws, editor } = setup({
      place: vi.fn((i: Issue) => {
        const now = ws.getState().issues.find((x) => x.id === i.id);
        if (now) ws.getState().upsertIssue({ ...now, sightings: now.sightings.slice(1) });
        return Promise.resolve<PlaceResult>({
          ok: true,
          sightings: [
            {
              on: 'mesh',
              layer: 'model-d2',
              geom: { type: 'spolygon', points: square(0) },
              from: { sighting: 0 },
            },
          ],
          from: 0,
          hitRate: 1,
        });
      }),
    });
    const r = await store.getState().placeIds(['a'], 'model-d2');
    expect(r).toMatchObject({ placed: 0, missed: 0, changed: 1 });
    expect(r?.outcomes[0]).toMatchObject({ id: 'a', ok: false, reason: 'missed', changed: true });
    expect(editor.commitIssues).not.toHaveBeenCalled();
  });

  it('writes nothing when another project opened while placing, and resets', async () => {
    const { store, ws, editor } = setup({
      place: vi.fn(() => {
        ws.getState().openProject({ id: 'q', root: 'r2', manifest: { ...manifest, id: 'q' } }, [A]);
        return Promise.resolve<PlaceResult>({ ok: false, reason: 'missed' });
      }),
    });
    const stop = followProject(store, ws);
    store.getState().offerIds(['a', 'b'], 'detections');
    const r = await store.getState().placeIds(['a', 'b'], 'model-d2');
    expect(r).toBeNull();
    expect(editor.commitIssues).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      offer: null,
      layerId: null,
      result: null,
      matches: [],
      error: null,
      busy: false,
    });
    stop();
  });

  it('runs one placement at a time and keeps every call', async () => {
    let active = 0;
    let most = 0;
    const { store } = setup({
      place: vi.fn(async (i: Issue) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return i.id === 'a'
          ? ({
              ok: true,
              sightings: [
                {
                  on: 'mesh',
                  layer: 'model-d2',
                  geom: { type: 'spolygon', points: square(0) },
                  from: { sighting: 0 },
                },
              ],
              from: 0,
              hitRate: 1,
            } satisfies PlaceResult)
          : ({ ok: false, reason: 'missed' } satisfies PlaceResult);
      }),
    });
    const first = store.getState().placeIds(['a'], 'model-d2');
    const second = store.getState().placeIds(['b'], 'model-d2');
    expect(store.getState().busy).toBe(true);
    const [r1, r2] = await Promise.all([first, second]);
    expect(most).toBe(1);
    expect(r1?.placed).toBe(1);
    expect(r2).toMatchObject({ placed: 0, missed: 1 });
    expect(store.getState().busy).toBe(false);
  });

  it('says when a selection file could not be written; the prism still lands', async () => {
    const cloudResult: PlaceResult = {
      ok: true,
      sightings: [
        {
          on: 'pointcloud',
          layer: 'cloud-d2',
          geom: { type: 'polygon3', points: square(0), height: 0.2 },
          from: { sighting: 0 },
        },
      ],
      from: 0,
      hitRate: 1,
      selection: { positions: new Float32Array([1, 2, 3]), count: 1, lod: 2 },
    };
    const { store, ws } = setup(
      { writeSelection: vi.fn(() => Promise.resolve<SelectionWrite>({ error: 'Disk full' })) },
      { a: cloudResult },
    );
    const r = await store.getState().placeIds(['a'], 'cloud-d2');
    expect(r).toMatchObject({ placed: 1, selectionFailed: 1 });
    expect(r?.outcomes[0]?.selectionError).toBe('Disk full');
    expect(store.getState().error).toBe('Disk full');
    const a = ws.getState().issues.find((i) => i.id === 'a');
    // the prism without a selection sighting (the mesh pin is of another layer and stays)
    expect(a?.sightings.map((s) => ('geom' in s ? s.geom.type : s.on))).toEqual([
      'box',
      'spoint',
      'polygon3',
    ]);
  });

  it('offers again, with what was offered meanwhile, when the commit is refused', async () => {
    const { store, editor } = setup();
    editor.commitIssues.mockImplementation(() => err<null>('Refused'));
    store.getState().offerIds(['a'], 'detections');
    const run = store.getState().place();
    store.getState().offerIds(['b'], 'change');
    await run;
    expect(store.getState().offer).toEqual({ ids: ['a', 'b'], source: 'change' });
  });

  it('names each selection write apart, within the file name rule', () => {
    const long = 'x'.repeat(200);
    const name = stepSelectionName(long, 'cloud', '2026-10-15T12:00:00.000Z');
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,120}$/);
    expect(name.endsWith('-20261015120000000')).toBe(true);
    expect(stepSelectionName('a', 'c', '2026-10-15T12:00:00.001Z')).not.toBe(
      stepSelectionName('a', 'c', '2026-10-15T12:00:00.000Z'),
    );
  });
});

describe('match suggestions', () => {
  it('suggests the earlier finding with an overlapping footprint, and Same gives both one track', async () => {
    const { store, ws, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    expect(store.getState().matches).toEqual([
      { issueId: 'a', code: 'F01', otherId: 'e', otherCode: 'F04', date: '3 Mar 2026' },
    ]);
    store.getState().same();
    expect(editor.commitIssues).toHaveBeenLastCalledWith(expect.any(Array), 'Match F04 and F01');
    const tracks = ws
      .getState()
      .issues.filter((i) => i.id === 'a' || i.id === 'e')
      .map((i) => i.track);
    expect(tracks).toEqual(['track-1', 'track-1']);
    expect(store.getState().matches).toEqual([]);
  });

  it('Different and Skip all drop suggestions without changing issues', async () => {
    const { store, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    store.getState().different();
    expect(store.getState().matches).toEqual([]);
    await store.getState().placeIds(['a'], 'model-d2');
    store.getState().skipAll();
    expect(store.getState().matches).toEqual([]);
    expect(editor.commitIssues).toHaveBeenCalledTimes(2);
  });

  it('Same writes nothing when the two are already tracked as one', async () => {
    const { store, ws, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    expect(store.getState().matches).toHaveLength(1);
    // matched elsewhere before Same was pressed
    for (const [id, capture] of [
      ['a', 'd2'],
      ['e', 'd1'],
    ] as const) {
      const i = ws.getState().issues.find((x) => x.id === id);
      if (i) ws.getState().upsertIssue({ ...i, track: 'T', capture });
    }
    store.getState().same();
    expect(editor.commitIssues).toHaveBeenCalledTimes(1);
    expect(store.getState().matches).toEqual([]);
  });
});
