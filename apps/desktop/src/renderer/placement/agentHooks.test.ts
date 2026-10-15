import { ToolError } from '@aio/ai';
import type { EditorState } from '@aio/annotate';
import { ok, type Issue, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createPlacementHooks, type PlacementHookDeps } from './agentHooks';
import type { PlaceSummary } from './store';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'mesh',
      id: 'model',
      name: 'Site model',
      visible: true,
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud',
      name: 'Cloud',
      visible: true,
      src: { path: 'c.json' },
      format: 'png-packed',
    },
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'P7', src: { path: 'p/P7.jpg' } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;
const F01 = {
  id: 'i1',
  code: 'F01',
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P7', geom: { type: 'box', x: 0, y: 0, w: 5, h: 5 } },
  ],
} as unknown as Issue;

function setup() {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'r', manifest }, [F01]);
  const summary = (ids: readonly string[]): PlaceSummary => ({
    layerId: 'model',
    layerName: 'Site model',
    total: ids.length,
    placed: 1,
    missed: ids.length - 1,
    noPhoto: 0,
    notLoaded: 0,
    changed: 0,
    selectionFailed: 0,
    label: 'Place 1 issue on Site model',
    outcomes: ids.map((id, k) =>
      k === 0
        ? {
            id,
            code: 'F01',
            ok: true,
            sightings: [
              {
                on: 'mesh',
                layer: 'model',
                geom: {
                  type: 'spolygon',
                  points: [
                    [0, 0, 0],
                    [1, 0, 0],
                    [1, 0, 1],
                  ],
                },
                from: { sighting: 0 },
              },
            ],
          }
        : { id, code: 'F02', ok: false, reason: 'missed' as const },
    ),
  });
  const state: EditorState = {
    canUndo: true,
    canRedo: false,
    undoLabel: 'Place 1 issue on Site model',
    redoLabel: null,
    save: { state: 'saved' },
    lastError: null,
  };
  const m = {
    placeIds: vi.fn<PlacementHookDeps['placeIds']>((ids) => Promise.resolve(summary(ids))),
    acceptByIds: vi.fn(() => ({
      accepted: [{ id: 'det-1', issueId: 'i2' }],
      skipped: [{ id: 'det-9', problem: 'no-class' }],
    })),
    addSighting: vi.fn(() => ok(F01)),
    undo: vi.fn(() => true),
  };
  const deps: PlacementHookDeps = {
    workspace: ws,
    placeIds: m.placeIds,
    acceptByIds: m.acceptByIds,
    editor: { state, addSighting: m.addSighting, undo: m.undo },
  };
  return { ws, m, hooks: createPlacementHooks(deps) };
}

describe('assistant placement hooks', () => {
  it('place_on_model accepts named detections first, places, and reports per id', async () => {
    const { m, hooks } = setup();
    const r = await hooks.placeOnModel({
      ids: ['F01', 'det-1', 'det-9', 'nothing'],
      layer: 'site MODEL',
    });
    expect(m.acceptByIds).toHaveBeenCalledWith(['det-1', 'det-9', 'nothing']);
    expect(m.placeIds).toHaveBeenCalledWith(['i1', 'i2'], 'model');
    expect(r.layer).toEqual({ id: 'model', name: 'Site model' });
    expect(r.outcomes).toEqual([
      { id: 'F01', code: 'F01', placed: [{ on: 'mesh', type: 'spolygon' }] },
      { id: 'det-1', code: 'F02', reason: 'missed' },
      { id: 'det-9', reason: 'no-class' },
      { id: 'nothing', reason: 'unknown' },
    ]);
    r.undo?.();
    expect(m.undo).toHaveBeenCalledTimes(1);
  });

  it('names the layers when the one asked for is not a mesh or cloud', async () => {
    const { hooks } = setup();
    await expect(hooks.placeOnModel({ ids: ['F01'], layer: 'Photos' })).rejects.toBeInstanceOf(
      ToolError,
    );
    await expect(hooks.placeOnModel({ ids: ['F01'], layer: 'x' })).rejects.toThrow(
      'Site model, Cloud',
    );
  });

  it('add_sighting puts a point of the layer kind on the issue', async () => {
    const { m, hooks } = setup();
    const r = await hooks.addSighting({
      issue: 'F01',
      layer: 'cloud',
      at: { kind: 'point', p: [1, 2, 3] },
    });
    expect(m.addSighting).toHaveBeenCalledWith('i1', {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'point3', p: [1, 2, 3] },
    });
    expect(r).toMatchObject({ code: 'F01', placed: [{ on: 'pointcloud', type: 'point3' }] });
  });

  it('add_sighting from a photo box adds the box, then projects it onto the layer', async () => {
    const { m, hooks } = setup();
    const r = await hooks.addSighting({
      issue: 'F01',
      layer: 'model',
      at: { kind: 'photo', photo: 'P7', box: [10, 20, 30, 40] },
    });
    expect(m.addSighting).toHaveBeenCalledWith('i1', {
      on: 'image',
      layer: 'photos',
      photo: 'P7',
      geom: { type: 'box', x: 10, y: 20, w: 30, h: 40 },
    });
    expect(m.placeIds).toHaveBeenCalledWith(['i1'], 'model');
    expect(r.placed).toEqual([{ on: 'mesh', type: 'spolygon' }]);
    await expect(
      hooks.addSighting({
        issue: 'F01',
        layer: 'model',
        at: { kind: 'photo', photo: 'nope', box: [0, 0, 1, 1] },
      }),
    ).rejects.toThrow('No photo "nope"');
    await expect(
      hooks.addSighting({ issue: 'F99', layer: 'model', at: { kind: 'point', p: [0, 0, 0] } }),
    ).rejects.toThrow('No issue "F99"');
  });

  it('add_sighting says why nothing was placed', async () => {
    const { m, hooks } = setup();
    const at = {
      kind: 'photo' as const,
      photo: 'P7',
      box: [1, 2, 3, 4] as [number, number, number, number],
    };
    const run = (o: object | null) => {
      vi.mocked(m.placeIds).mockResolvedValueOnce(
        o && {
          ...(o as PlaceSummary),
          placed: 0,
          outcomes: [{ id: 'i1', code: 'F01', ok: false, ...o }],
        },
      );
      return hooks.addSighting({ issue: 'F01', layer: 'model', at });
    };
    expect((await run({ reason: 'missed' })).reason).toMatch(/missed the model/);
    expect((await run({ reason: 'layer-not-loaded' })).reason).toMatch(/not loaded/);
    expect((await run({ reason: 'no-photo-shape' })).reason).toMatch(/photo/);
    expect((await run({ reason: 'missed', changed: true })).reason).toMatch(
      /the issue changed while placing/,
    );
    expect((await run(null)).reason).toMatch(/did not run/);
    const ok = await hooks.addSighting({ issue: 'F01', layer: 'model', at });
    expect(ok.reason).toBeUndefined();
  });

  it('place_on_model reports a changed issue and a run that did not happen', async () => {
    const { m, hooks } = setup();
    vi.mocked(m.placeIds).mockResolvedValueOnce({
      layerId: 'model',
      layerName: 'Site model',
      total: 1,
      placed: 0,
      missed: 0,
      noPhoto: 0,
      notLoaded: 0,
      changed: 1,
      selectionFailed: 0,
      label: 'x',
      outcomes: [{ id: 'i1', code: 'F01', ok: false, reason: 'missed', changed: true }],
    });
    const r = await hooks.placeOnModel({ ids: ['F01'], layer: 'model' });
    expect(r.outcomes).toEqual([{ id: 'F01', code: 'F01', reason: 'changed' }]);
    expect(r.undo).toBeUndefined();
    vi.mocked(m.placeIds).mockResolvedValueOnce(null);
    const n = await hooks.placeOnModel({ ids: ['F01'], layer: 'model' });
    expect(n.outcomes[0]?.reason).toMatch(/did not run/);
  });
});
