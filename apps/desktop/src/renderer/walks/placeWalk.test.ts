// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitWalk } from '@aio/geo';
import { ProjectManifest, WalkRawPath, type JobRecord, type WalkLayer } from '@aio/schema';
import { t } from '@aio/ui';
import type { MapOverlay } from '@aio/maps';
import type { OpenProject } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  shell: { getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn() }) },
  jobs: { getState: () => ({ jobs: [], start: vi.fn() }), subscribe: () => () => undefined },
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ saveLayers: vi.fn() }), subscribe: () => () => undefined },
}));

import {
  createPlaceSession,
  createPlaceUi,
  createInputsCache,
  createPlaceWalk,
  followMap,
  inputsKey,
  loadWalkInputs,
  orientationDataRef,
  placedMapOverlays,
  placedNowMapOverlay,
  placedNowOnSheet,
  placedWalkFits,
  sessionHandles,
  surfaceLayout,
  walkBeingEdited,
  viewHeading,
  walkColour,
  walksOnSheet,
  wantsSurfaceClick,
  type PlaceWalkDeps,
} from './placeWalk';
import { setWalkMapOverlays, setWalkMapPointer, walkMap } from './walkMapStore';
import { clearWalkPlayback, setWalkPlayback, watchWalkPlayback } from './walkPlayback';
import { localToLonLat } from '../change/draw';

const fixtures = join(import.meta.dirname, '../../../../../packages/schema/src/__fixtures__/walk');
const file = (name: string) => readFileSync(join(fixtures, name));
const raw = WalkRawPath.parse(JSON.parse(file('raw-path.synthetic.json').toString('utf8')));

const walkLayer = (extra: Partial<WalkLayer> = {}): WalkLayer => ({
  kind: 'walk',
  id: 'walk-a',
  name: 'Walk A',
  visible: true,
  capture: 'c1',
  record: { path: 'walks/a/walk.json' },
  src: { path: 'walks/a/playback.mp4' },
  durationS: 62,
  ...extra,
});

const plan = {
  kind: 'raster' as const,
  id: 'sheet-own',
  name: 'Ground floor',
  src: { path: 'drawings/own/plan.png' },
  role: 'plan' as const,
  format: 'image' as const,
  corners: {
    tl: [10, 2, 20] as [number, number, number],
    tr: [110, 2, 20] as [number, number, number],
    bl: [10, 2, 70] as [number, number, number],
  },
};

function projectWith(layers: unknown[]): OpenProject {
  return {
    id: 'p',
    root: 'C:/p',
    manifest: ProjectManifest.parse({
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: { epsg: 32633 },
      origin: [500000, 4500000, 0],
      captures: [{ id: 'c1', label: 'First', date: '2026-01-01' }],
      layers,
      severityModels: [],
      classCatalogues: [],
    }),
  };
}

/** A fake fetch over the fixture folder: `aio://project/p/walks/a/<name>`. */
const fixtureGet = (over: Record<string, string> = {}) =>
  vi.fn((url: string) => {
    const name = decodeURIComponent(url.split('/').pop() ?? '');
    const mapped = over[name] ?? name;
    try {
      const bytes = file(mapped);
      return Promise.resolve(new Response(new Uint8Array(bytes)));
    } catch {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
  });

const refs = {
  raw: { path: 'walks/a/raw-path.synthetic.json' },
  orientation: { path: 'walks/a/orientation.synthetic.json' },
  orientationData: { path: 'walks/a/orientation.synthetic.bin' },
};

describe('loadWalkInputs', () => {
  it('reads nothing for a walk with no path files', async () => {
    const get = fixtureGet();
    expect(await loadWalkInputs('p', walkLayer(), get)).toEqual({ raw: null, orientation: null });
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the raw path and the orientation rows through the asset URLs', async () => {
    const get = fixtureGet();
    const got = await loadWalkInputs('p', walkLayer({ path: refs }), get);
    expect(got.raw?.stills.length).toBe(raw.stills.length);
    expect(got.orientation?.length).toBeGreaterThan(1000);
    expect(get.mock.calls[0]?.[0]).toBe('aio://project/p/walks/a/raw-path.synthetic.json');
  });

  it('a newer, unreadable or missing file reads as absent (pins-only)', async () => {
    const answer = (body: string) => vi.fn(() => Promise.resolve(new Response(body)));
    const withRaw = walkLayer({ path: { raw: { path: 'walks/a/raw-path.json' } } });
    const newer = JSON.stringify({ ...raw, schema: 'aio.walkpath/2' });
    expect(await loadWalkInputs('p', withRaw, answer(newer))).toEqual({
      raw: null,
      orientation: null,
    });
    expect((await loadWalkInputs('p', withRaw, answer('{ not json'))).raw).toBeNull();
    const gone = await loadWalkInputs(
      'p',
      walkLayer({ path: { raw: { path: 'walks/a/nothing.json' } } }),
      fixtureGet(),
    );
    expect(gone.raw).toBeNull();
  });

  it('reads the orientation data the header names, next to the header, as main does', async () => {
    // the layer's orientationData names another file (or none): the header's `data` wins
    for (const path of [
      { ...refs, orientationData: { path: 'walks/a/elsewhere.bin' } },
      { raw: refs.raw, orientation: refs.orientation },
    ]) {
      const get = fixtureGet();
      const got = await loadWalkInputs('p', walkLayer({ path }), get);
      expect(got.orientation?.length).toBeGreaterThan(1000);
      expect(get.mock.calls.map((c) => c[0])).toContain(
        'aio://project/p/walks/a/orientation.synthetic.bin',
      );
    }
    expect(orientationDataRef({ path: 'walks/a/orientation.json' }, 'o.bin')).toEqual({
      path: 'walks/a/o.bin',
    });
    expect(orientationDataRef({ hash: 'a'.repeat(64) }, 'o.bin')).toBeUndefined();
  });

  it('an orientation file of the wrong length is refused, the path still read', async () => {
    const got = await loadWalkInputs(
      'p',
      walkLayer({ path: refs }),
      fixtureGet({ 'orientation.synthetic.bin': 'raw-path.synthetic.json' }),
    );
    expect(got.raw).not.toBeNull();
    expect(got.orientation).toBeNull();
  });
});

describe('placed walk inputs cache', () => {
  const placed = walkLayer({
    path: { raw: refs.raw },
    flight: { src: { path: 'walks/a/pose.json' }, startUtcMs: 0 },
    place: {
      pins: [
        { t: 0, surface: 'sheet-own', at: [0, 0] },
        { t: 9, surface: 'sheet-own', at: [5, 5] },
      ],
      yawOffsetDeg: 0,
      heightM: 1.7,
      quality: 'good',
    },
  });

  it('reads once per key, again after a new pose, new pins or a clear', async () => {
    const load = vi.fn(() => Promise.resolve({ raw: null, orientation: null }));
    const cache = createInputsCache(load);
    await cache.get('p', placed);
    await cache.get('p', placed);
    expect(load).toHaveBeenCalledTimes(1);
    // a reprocess: main rewrote the pose
    await cache.get('p', {
      ...placed,
      flight: { src: { path: 'walks/a/pose.json' }, startUtcMs: 5 },
    });
    expect(load).toHaveBeenCalledTimes(2);
    const moved = placed.place && {
      ...placed.place,
      pins: placed.place.pins.map((p) => ({ ...p, t: p.t + 1 })),
    };
    await cache.get('p', { ...placed, place: moved });
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get('p', { ...placed, place: moved });
    expect(load).toHaveBeenCalledTimes(3);
    cache.clear();
    await cache.get('p', { ...placed, place: moved });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('the key names the pose and the pins', () => {
    expect(inputsKey('p', placed)).not.toBe(inputsKey('p', { ...placed, flight: undefined }));
    expect(inputsKey('p', placed)).not.toBe(inputsKey('q', placed));
  });
});

function flowFor(project: { current: OpenProject }, over: Partial<PlaceWalkDeps> = {}) {
  const ui = createPlaceUi();
  const session = createPlaceSession(ui);
  const openSurface = vi.fn();
  const save = vi.fn(() => Promise.resolve(null));
  const deps: PlaceWalkDeps = {
    project: () => project.current,
    drawings: () => ({ provisional: false, size: { width: 1000, height: 500 } }),
    loadInputs: () => Promise.resolve({ raw: null, orientation: null }),
    openSurface,
    save,
    ensureCapture: vi.fn(),
    setCapture: vi.fn(() => Promise.resolve(null)),
    capturedAt: () => undefined,
    job: () => undefined,
    modelSurface: () => '3d',
    process: vi.fn(() => Promise.resolve(null)),
    ...over,
  };
  return { ui, session, openSurface, save, flow: createPlaceWalk(deps, session, ui) };
}

describe('createPlaceWalk', () => {
  it('Place walk on another walk with unsaved pins asks first, then places it after Discard', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    const { flow, session, ui, openSurface } = flowFor(project);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    session.getState().click([0, 0], 0);
    expect(session.getState().dirty).toBe(true);
    openSurface.mockClear();
    await flow.begin('walk-b');
    expect(ui.getState()).toMatchObject({ layerId: 'walk-a', asking: true, pending: 'walk-b' });
    expect(session.getState().layerId).toBe('walk-a');
    // the question is shown where the strip sits
    expect(openSurface).toHaveBeenCalledWith('walk-a', { kind: 'map' }, false);
    flow.discard();
    await vi.waitFor(() => {
      expect(session.getState().layerId).toBe('walk-b');
    });
    expect(ui.getState().pending).toBeNull();
  });

  it('Save on the question saves the first walk, then places the waiting one', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    const { flow, session, ui, save } = flowFor(project);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    session.getState().click([0, 0], 0);
    session.getState().click([40, 0], 0);
    await flow.begin('walk-b');
    await flow.save();
    expect(save).toHaveBeenCalledWith('walk-a', expect.anything());
    await vi.waitFor(() => {
      expect(session.getState().layerId).toBe('walk-b');
    });
    expect(ui.getState().asking).toBe(false);
  });

  it('Keep placing drops the waiting walk', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    const { flow, session, ui } = flowFor(project);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    session.getState().click([0, 0], 0);
    await flow.begin('walk-b');
    flow.keepPlacing();
    expect(ui.getState()).toMatchObject({ layerId: 'walk-a', asking: false, pending: null });
  });

  it("a new session does not replay the last one's seek", async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, ui } = flowFor(project);
    await flow.begin('walk-a');
    flow.placeAnyway();
    expect(ui.getState().seek).not.toBeNull();
    flow.discard();
    expect(ui.getState().seek).toBeNull();
  });

  it('a second Place walk while the first reads its files wins', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const { flow, session } = flowFor(project, {
      loadInputs: (_p, layer) =>
        layer.id === 'walk-a'
          ? slow.then(() => ({ raw: null, orientation: null }))
          : Promise.resolve({ raw: null, orientation: null }),
    });
    const first = flow.begin('walk-a');
    await flow.begin('walk-b');
    release();
    await first;
    expect(session.getState().layerId).toBe('walk-b');
  });

  it('Save lets go of a pin being moved, so no move is made while it saves', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const held: { answer: ((v: string | null) => void) | null } = { answer: null };
    const { flow, session } = flowFor(project, {
      save: () =>
        new Promise<string | null>((r) => {
          held.answer = r;
        }),
    });
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    session.getState().click([0, 0], 0);
    session.getState().click([40, 0], 0);
    flow.fineTune(true);
    session.getState().armMove(0);
    const saving = flow.save();
    expect(session.getState().armed).toBeNull();
    expect(session.getState().moving).toBeNull();
    // the date field is applied first, so the save goes out a moment later
    await vi.waitFor(() => {
      expect(held.answer).not.toBeNull();
    });
    held.answer?.('Disk full');
    await saving;
  });

  it('discard closes the session and leaves the walk untouched', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, save, session, ui } = flowFor(project);
    await flow.begin('walk-a');
    flow.discard();
    expect(session.getState().layerId).toBeNull();
    expect(ui.getState().layerId).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('createPlaceWalk, start and end', () => {
  const withPath = (extra: Partial<WalkLayer> = {}) => walkLayer({ path: refs, ...extra });
  const loadFixture = () => Promise.resolve({ raw, orientation: null });
  const undatedWithPath = (): WalkLayer => {
    const w = withPath();
    delete w.capture;
    return w;
  };

  it('a walk with a path opens on Start on the first surface', async () => {
    const project = { current: projectWith([plan, withPath()]) };
    const { flow, openSurface, session } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    expect(openSurface).toHaveBeenCalledWith(
      'walk-a',
      expect.objectContaining({ kind: 'drawing' }),
      false,
    );
    expect(session.getState().step).toBe('start');
  });

  it('a walk with no path opens on the check, with the job state', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session } = flowFor(project, {
      job: () => ({ status: 'interrupted', progress: 0.31 }),
    });
    await flow.begin('walk-a');
    expect(session.getState().step).toBe('check');
    expect(flow.pathState()).toBe('interrupted');
    flow.placeAnyway();
    expect(session.getState().step).toBe('start');
  });

  it('Process walk from the check answers why not in the note', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const process = vi.fn(() => Promise.resolve('Needs a newer pipeline pack'));
    const { flow, ui } = flowFor(project, { process });
    await flow.begin('walk-a');
    await flow.process();
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ id: 'walk-a' }));
    expect(ui.getState().note).toBe('Needs a newer pipeline pack');
  });

  it('a walk placed on @model reopens on the map when the stage shows the map, else 3D', async () => {
    const placed = withPath({
      place: {
        pins: [
          { t: 4, surface: '@model', at: [0, 0] },
          { t: 62, surface: '@model', at: [40, -30] },
        ],
        yawOffsetDeg: 0,
        heightM: 1.7,
        quality: 'good',
        placedOn: '@model',
      },
    });
    const project = { current: projectWith([placed]) };
    const onMap = flowFor(project, { loadInputs: loadFixture, modelSurface: () => 'map' });
    await onMap.flow.begin('walk-a');
    expect(onMap.ui.getState().host).toEqual({ kind: 'map' });
    expect(onMap.session.getState().step).toBe('placed');
    const in3d = flowFor(project, { loadInputs: loadFixture, modelSurface: () => '3d' });
    await in3d.flow.begin('walk-a');
    expect(in3d.ui.getState().host).toEqual({ kind: '3d' });
  });

  it('a walk placed on a drawing that is gone opens on the first surface', async () => {
    const placed = withPath({
      place: {
        pins: [
          { t: 4, surface: 'sheet-gone', at: [0, 0] },
          { t: 62, surface: 'sheet-gone', at: [400, 300] },
        ],
        yawOffsetDeg: 0,
        heightM: 1.7,
        quality: 'good',
        placedOn: 'sheet-gone',
      },
    });
    const project = { current: projectWith([plan, placed]) };
    const { flow, ui } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    expect(ui.getState().host).toMatchObject({ kind: 'drawing', id: 'sheet-own' });
  });

  it('the date field preselects the walk capture, else the first choice, else the day to add', async () => {
    const undated = undatedWithPath();
    const dated = flowFor(
      { current: projectWith([plan, withPath()]) },
      { loadInputs: loadFixture },
    );
    await dated.flow.begin('walk-a');
    expect(dated.ui.getState().date).toBe('c1');
    const first = flowFor({ current: projectWith([plan, undated]) }, { loadInputs: loadFixture });
    await first.flow.begin('walk-a');
    expect(first.ui.getState().date).toBe('c1');
  });

  it('Save applies the date field first, then saves the placement', async () => {
    const undated = undatedWithPath();
    const project = { current: projectWith([plan, undated]) };
    const setCapture = vi.fn(() => Promise.resolve(null));
    const { flow, session, save } = flowFor(project, { loadInputs: loadFixture, setCapture });
    await flow.begin('walk-a');
    flow.setDate('c1');
    session.getState().chooseSurface({ kind: '3d' });
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
    await flow.save();
    expect(setCapture).toHaveBeenCalledWith('walk-a', 'c1');
    expect(save).toHaveBeenCalledWith('walk-a', {
      walk: expect.objectContaining({ placedOn: '@model' }) as unknown,
    });
  });

  it('Save adds a new survey date for an add: field, and stops on its error', async () => {
    const undated = undatedWithPath();
    const project = { current: projectWith([plan, undated]) };
    const ensureCapture = vi.fn(() => Promise.resolve({ error: 'No room' }));
    const { flow, session, save, ui } = flowFor(project, {
      loadInputs: loadFixture,
      ensureCapture,
    });
    await flow.begin('walk-a');
    flow.setDate('add:2026-10-01');
    session.getState().chooseSurface({ kind: '3d' });
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
    await flow.save();
    expect(ensureCapture).toHaveBeenCalledWith('2026-10-01');
    expect(save).not.toHaveBeenCalled();
    expect(ui.getState()).toMatchObject({ note: 'No room', saving: false });
  });

  it('Fine-tune opens the 360 beside the surface and turns the session to fine-tune', async () => {
    const project = { current: projectWith([withPath()]) };
    const { flow, openSurface, session, ui } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
    flow.fineTune(true);
    expect(session.getState().step).toBe('fine-tune');
    expect(ui.getState().fineTune).toBe(true);
    // a project with a CRS and no drawing: the map comes first
    expect(openSurface).toHaveBeenLastCalledWith('walk-a', { kind: 'map' }, true);
    flow.fineTune(false);
    expect(session.getState().step).toBe('placed');
    expect(openSurface).toHaveBeenLastCalledWith('walk-a', { kind: 'map' }, false);
  });

  it('Remove placement sends walk null and closes the session', async () => {
    const project = {
      current: projectWith([
        withPath({
          place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
        }),
      ]),
    };
    const { flow, save, ui } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    expect(await flow.removePlacement()).toBeNull();
    expect(save).toHaveBeenCalledWith('walk-a', { walk: null });
    expect(ui.getState().layerId).toBeNull();
  });

  it('Remove placement of another walk leaves the open session alone', async () => {
    const project = { current: projectWith([withPath(), walkLayer({ id: 'walk-b' })]) };
    const { flow, save, ui } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    expect(await flow.removePlacement('walk-b')).toBeNull();
    expect(save).toHaveBeenCalledWith('walk-b', { walk: null });
    expect(ui.getState().layerId).toBe('walk-a');
  });

  it('a path that appears while on the check moves on to Start; one that goes drops the draft', async () => {
    const project = { current: projectWith([walkLayer()]) };
    const { flow, session } = flowFor(project, {
      loadInputs: (_p, l) =>
        Promise.resolve(l.path ? { raw, orientation: null } : { raw: null, orientation: null }),
    });
    await flow.begin('walk-a');
    expect(session.getState().step).toBe('check');
    project.current = projectWith([withPath()]);
    await flow.pathChanged();
    expect(session.getState().step).toBe('start');
    project.current = projectWith([walkLayer()]);
    await flow.pathChanged();
    expect(session.getState().step).toBe('check');
  });

  it('Process again rewrites the same files: the finished job reads them again, on to Start', async () => {
    // an unusable raw path under the layer's refs: the check says failed
    const project = { current: projectWith([withPath()]) };
    let job: { id: string; status: JobRecord['status']; progress: number } | undefined;
    let fresh = false;
    const loadInputs = vi.fn(() =>
      Promise.resolve(fresh ? { raw, orientation: null } : { raw: null, orientation: null }),
    );
    const { flow, session, ui } = flowFor(project, { loadInputs, job: () => job });
    await flow.begin('walk-a');
    expect(session.getState().step).toBe('check');
    expect(flow.pathState()).toBe('failed');
    expect(loadInputs).toHaveBeenCalledTimes(1);
    // nothing changed: nothing is read again
    await flow.pathChanged();
    expect(loadInputs).toHaveBeenCalledTimes(1);
    job = { id: 'j2', status: 'running', progress: 0.2 };
    await flow.pathChanged();
    expect(flow.pathState()).toBe('running');
    expect(session.getState().step).toBe('check');
    // the run ends: the same refs, new contents
    fresh = true;
    job = { id: 'j2', status: 'done', progress: 1 };
    await flow.pathChanged();
    expect(ui.getState().inputs.raw).toBe(raw);
    expect(flow.pathState()).toBe('ready');
    expect(session.getState().step).toBe('start');
  });

  it('Remove placement waits for no Save: a Save on its way refuses it, and the other way round', async () => {
    const project = { current: projectWith([withPath()]) };
    const held: { answer: ((v: string | null) => void) | null } = { answer: null };
    const save = vi.fn(
      () =>
        new Promise<string | null>((r) => {
          held.answer = r;
        }),
    );
    const { flow, session, ui } = flowFor(project, { loadInputs: loadFixture, save });
    await flow.begin('walk-a');
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
    const saving = flow.save();
    await vi.waitFor(() => {
      expect(held.answer).not.toBeNull();
    });
    expect(await flow.removePlacement('walk-a')).toBe(t('walk.place.busy'));
    expect(save).toHaveBeenCalledTimes(1);
    held.answer?.('Disk full');
    await saving;
    // a Remove placement on its way: Save says so and sends nothing
    Object.assign(held, { answer: null });
    const removing = flow.removePlacement('walk-a');
    expect(save).toHaveBeenCalledTimes(2);
    await flow.save();
    expect(save).toHaveBeenCalledTimes(2);
    expect(ui.getState().note).toBe(t('walk.place.busy'));
    held.answer?.(null);
    expect(await removing).toBeNull();
    expect(save).toHaveBeenLastCalledWith('walk-a', { walk: null });
  });
});

describe('surfaceLayout', () => {
  it('the map and 3D fill the stage; a drawing sits beside the 3D view, never the 360', () => {
    expect(surfaceLayout(undefined, { kind: 'map' }, false)).toEqual({ mode: 'map' });
    expect(surfaceLayout(undefined, { kind: '3d' }, false)).toEqual({ mode: '3d' });
    const d = surfaceLayout(
      { left: '3d', right: 'walk360' },
      { kind: 'drawing', id: 's', name: 'S', dated: false },
      false,
    );
    expect(d.mode).toBe('split');
    expect([d.split?.left, d.split?.right].sort()).toEqual(['3d', 'raster']);
    expect(d.split?.raster).toBe('s');
  });

  it('a drawing always pairs with the 3D view, also when the split showed the map', () => {
    const drawing = { kind: 'drawing', id: 's', name: 'S', dated: false } as const;
    for (const saved of [
      { left: 'map', right: '3d' },
      { left: '3d', right: 'map' },
      { left: 'raster', right: 'map' },
    ] as const) {
      const d = surfaceLayout(saved, drawing, false);
      expect([d.split?.left, d.split?.right].sort()).toEqual(['3d', 'raster']);
    }
  });

  it('fine-tune puts the 360 video beside the surface', () => {
    const f = surfaceLayout(undefined, { kind: 'map' }, true);
    expect(f.mode).toBe('split');
    expect([f.split?.left, f.split?.right].sort()).toEqual(['map', 'walk360']);
  });
});

describe('the walk on the map while it is placed there', () => {
  afterEach(() => {
    setWalkMapOverlays([]);
    setWalkMapPointer(null);
  });

  it('hover shows the preview, clicks place, handles drag, and close clears', async () => {
    const project = { current: projectWith([walkLayer({ path: refs })]) };
    const { flow, session, ui } = flowFor(project, {
      loadInputs: () => Promise.resolve({ raw, orientation: null }),
    });
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'map' });
    const pointer = walkMap.getState().pointer;
    expect(pointer).not.toBeNull();
    pointer?.onMove?.([5, 0, 6]);
    expect(walkMap.getState().overlays.map((o) => o.id)).toContain('walk-walk-a-preview');
    // the session object stays the same while placing goes on (a new one would cancel a drag)
    expect(walkMap.getState().pointer).toBe(pointer);
    pointer?.onMove?.(null);
    expect(walkMap.getState().overlays.map((o) => o.id)).not.toContain('walk-walk-a-preview');
    pointer?.onClick?.([0, 0.5, 0]);
    // one pin and the cursor off the map: the start stays drawn
    pointer?.onMove?.(null);
    const path = walkMap.getState().overlays.find((o) => o.id === 'walk-walk-a');
    const data = path?.data as { features: { properties: { kind?: string } | null }[] } | undefined;
    const kinds = data?.features.map((f) => f.properties?.kind);
    expect(kinds).toContain('pin');
    pointer?.onClick?.([40, 0, -30]);
    expect(session.getState().step).toBe('placed');
    expect(walkMap.getState().overlays.map((o) => o.id)).not.toContain('walk-walk-a-preview');
    expect(walkMap.getState().pointer).toBe(pointer);
    expect(pointer?.handles?.().map((h) => h.id)).toEqual(['start', 'end']);
    pointer?.onDrag?.('end', [45, 0, -30]);
    expect(session.getState().pins[1]?.at).toEqual([45, -30]);
    pointer?.onDragEnd?.('end', [45, 0, -30]);
    expect(session.getState().dragging).toBeNull();
    // a placed walk ignores plain clicks
    pointer?.onClick?.([90, 0, 90]);
    expect(session.getState().pins).toHaveLength(2);
    flow.discard();
    expect(walkMap.getState().overlays).toHaveLength(0);
    expect(walkMap.getState().pointer).toBeNull();
    stop();
  });

  const lined = (): { current: OpenProject } => {
    const p = projectWith([plan, walkLayer()]);
    return {
      current: {
        ...p,
        manifest: {
          ...p.manifest,
          captures: [
            {
              id: 'c1',
              label: 'First',
              date: '2026-01-01',
              lineUp: { eastM: 2, northM: -1, with: 'c0', at: '2026-10-16T08:00:00.000Z' },
            },
          ],
        },
      },
    };
  };

  it('saves a walk placement without the shift', async () => {
    const project = lined();
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    const pointer = walkMap.getState().pointer;
    // picked on the lined-up map at x 12, z 7: the walk's own frame is 2 m west, 1 m north of it
    pointer?.onClick?.([12, 0.5, 7]);
    pointer?.onClick?.([42, 0, 7]);
    expect(session.getState().pins.map((p) => p.at)).toEqual([
      [10, 6],
      [40, 6],
    ]);
    // the handles and the drawn path sit where they were picked
    expect(pointer?.handles?.().map((h) => h.local)).toEqual([
      [12, 0.5, 7],
      [42, 0, 7],
    ]);
    pointer?.onDrag?.('end', [45, 0, 9]);
    expect(session.getState().pins[1]?.at).toEqual([43, 8]);
    pointer?.onDragEnd?.('end', [45, 0, 9]);
    flow.discard();
    stop();
  });

  it('draws the path once placed; a time tick keeps the same path overlay', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    const pointer = walkMap.getState().pointer;
    pointer?.onClick?.([2, 0.5, 3]);
    expect(session.getState().pins[0]).toMatchObject({ surface: '@model', at: [2, 3], y: 0.5 });
    pointer?.onClick?.([40, 0, 3]);
    expect(session.getState().step).toBe('placed');
    const ids = walkMap.getState().overlays.map((o) => o.id);
    expect(ids).toEqual(['walk-walk-a', 'walk-walk-a-now']);
    const path = walkMap.getState().overlays[0];
    expect(path?.tooltip?.({ kind: 'pin', active: false })).toBe('The drawing it was on is gone');
    session.getState().setTime(10);
    expect(walkMap.getState().overlays[0]).toBe(path);
    flow.discard();
    stop();
  });

  it('a walk removed while it is placed leaves the map, and the next walk is placed at once', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    walkMap.getState().pointer?.onClick?.([2, 0.5, 3]);
    walkMap.getState().pointer?.onClick?.([40, 0.5, 3]);
    expect(walkMap.getState().overlays.length).toBeGreaterThan(0);
    // removed from the project (any way: the sidebar, an undo, a reload)
    project.current = projectWith([plan, walkLayer({ id: 'walk-b' })]);
    flow.dropIfGone();
    expect(session.getState().layerId).toBeNull();
    expect(ui.getState().layerId).toBeNull();
    expect(walkMap.getState().overlays).toHaveLength(0);
    expect(walkMap.getState().pointer).toBeNull();
    // no hidden "Keep these pins?" holds the next walk back
    await flow.begin('walk-b');
    expect(ui.getState().asking).toBe(false);
    expect(session.getState().layerId).toBe('walk-b');
    // a walk still there is left alone
    flow.dropIfGone();
    expect(session.getState().layerId).toBe('walk-b');
    stop();
  });

  it('in fine-tune, a pin armed to move takes the next map click; Escape lets it go', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.placeAnyway();
    flow.chooseSurface({ kind: 'map' });
    const pointer = walkMap.getState().pointer;
    pointer?.onClick?.([2, 0.5, 3]);
    pointer?.onClick?.([40, 0, 3]);
    flow.fineTune(true);
    session.getState().armMove(0);
    pointer?.onClick?.([5, 0.2, 6]);
    expect(session.getState().pins[0]).toMatchObject({ at: [5, 6], y: 0.2 });
    expect(session.getState().pins[1]).toMatchObject({ at: [40, 3] });
    session.getState().armMove(0);
    pointer?.onCancel?.();
    expect(session.getState().armed).toBeNull();
    flow.discard();
    stop();
  });

  it('does nothing while the walk is placed on a drawing', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'drawing', id: 'sheet-own', name: 'Ground floor', dated: false });
    expect(session.getState().surface?.kind).toBe('drawing');
    expect(walkMap.getState().pointer).toBeNull();
    expect(walkMap.getState().overlays).toHaveLength(0);
    stop();
  });
});

describe('handles and clicks', () => {
  it('wantsSurfaceClick: start and end, or an armed fine-tune click', () => {
    expect(wantsSurfaceClick({ step: 'start', armed: null })).toBe(true);
    expect(wantsSurfaceClick({ step: 'end', armed: null })).toBe(true);
    expect(wantsSurfaceClick({ step: 'placed', armed: null })).toBe(false);
    expect(wantsSurfaceClick({ step: 'check', armed: null })).toBe(false);
    expect(wantsSurfaceClick({ step: 'fine-tune', armed: null })).toBe(false);
    expect(wantsSurfaceClick({ step: 'fine-tune', armed: 'pin' })).toBe(true);
    expect(wantsSurfaceClick({ step: 'fine-tune', armed: 'align-360' })).toBe(false);
    expect(wantsSurfaceClick({ step: 'fine-tune', armed: 'align-surface' })).toBe(true);
  });

  it('sessionHandles: the first and last active pin by time, with their heights', () => {
    const pins = [
      { t: 0, surface: '@model', at: [0, 0] as [number, number], y: 1 },
      { t: 30, surface: '@model', at: [40, 0] as [number, number] },
      { t: 62, surface: '@model', at: [40, -30] as [number, number], y: 2 },
    ];
    const fit = fitWalk(null, { pins, yawOffsetDeg: 0 }, { drawing: () => null }, 62);
    expect(sessionHandles({ step: 'end', fit, pins })).toEqual([]);
    expect(sessionHandles({ step: 'placed', fit, pins })).toEqual([
      { handle: 'start', xz: [0, 0], y: 1 },
      { handle: 'end', xz: [40, -30], y: 2 },
    ]);
    expect(sessionHandles({ step: 'fine-tune', fit: null, pins })).toEqual([]);
  });
});

describe('helpers', () => {
  it('the walk is drawn in its survey date colour', () => {
    const m = projectWith([plan, walkLayer()]).manifest;
    expect(walkColour(m, walkLayer())).toBe('var(--date-1)');
    const undated = walkLayer();
    delete undated.capture;
    expect(walkColour(projectWith([plan, undated]).manifest, undated)).toBe('var(--acc)');
  });

  it('the view heading adds the yaw offset to the fit heading', () => {
    const fit = fitWalk(
      null,
      {
        pins: [
          { t: 0, surface: '@model', at: [0, 0] },
          { t: 62, surface: '@model', at: [0, -50] },
        ],
        yawOffsetDeg: 0,
      },
      { drawing: () => null },
      62,
    );
    const h0 = viewHeading(fit, null, 0, 30);
    expect(h0).not.toBeNull();
    expect(viewHeading(fit, null, 90, 30)).toBeCloseTo((h0 ?? 0) + Math.PI / 2, 9);
    expect(viewHeading(null, null, 0, 30)).toBeNull();
  });
});

describe('placed walks on every surface', () => {
  const placedOnOwn = (quality: 'good' | 'unplaced' = 'good') =>
    walkLayer({
      place: {
        pins: [
          { t: 0, surface: 'sheet-own', at: [100, 100] },
          { t: 62, surface: 'sheet-own', at: [600, 100] },
        ],
        yawOffsetDeg: 0,
        heightM: 1.7,
        quality,
        placedOn: 'sheet-own',
      },
    });
  // another drawing over the same ground, larger scale
  const other = {
    ...plan,
    id: 'sheet-loose',
    name: 'Site plan',
    corners: {
      tl: [0, 2, 0] as [number, number, number],
      tr: [200, 2, 0] as [number, number, number],
      bl: [0, 2, 100] as [number, number, number],
    },
  };
  const lookup = () => ({ provisional: false, size: { width: 1000, height: 500 } });
  const pinsOnly = () => ({ raw: null, orientation: null });

  it('a placed walk shows on an unrelated drawing, dimmed', () => {
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    expect(fits).toHaveLength(1);
    const drawn = walksOnSheet(m, 'sheet-loose', fits, lookup);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.placing).toBe(false);
    expect(drawn[0]?.pins).toHaveLength(0);
    expect(drawn[0]?.line.flatMap((r) => r.pts).length).toBeGreaterThan(1);
  });

  it('an unplaced or switched off walk does not show', () => {
    const unplaced = projectWith([plan, other, placedOnOwn('unplaced')]).manifest;
    expect(placedWalkFits(unplaced, pinsOnly, lookup)).toHaveLength(0);
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    expect(walksOnSheet(m, 'sheet-loose', fits, lookup, { hidden: new Set(['walk-a']) })).toEqual(
      [],
    );
    // not read yet: nothing drawn rather than a guess
    expect(placedWalkFits(m, () => undefined, lookup)).toHaveLength(0);
  });

  it('the walk being placed on the drawing replaces its saved entry, even when switched off', () => {
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    const live = fits[0];
    if (!live) throw new Error('no fit');
    const drawn = walksOnSheet(m, 'sheet-own', fits, lookup, {
      placing: live,
      hidden: new Set(['walk-a']),
    });
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.placing).toBe(true);
    expect(drawn[0]?.pins).toHaveLength(2);
  });

  it('moving the drawing the pins are on moves the drawn path', () => {
    const before = projectWith([plan, other, placedOnOwn()]).manifest;
    const moved = projectWith([
      { ...plan, corners: { tl: [30, 2, 20], tr: [130, 2, 20], bl: [30, 2, 70] } },
      other,
      placedOnOwn(),
    ]).manifest;
    const first = (m: typeof before) =>
      walksOnSheet(m, 'sheet-loose', placedWalkFits(m, pinsOnly, lookup), lookup)[0]?.line[0]
        ?.pts[0];
    const a = first(before);
    const b = first(moved);
    expect(a).toBeDefined();
    // 20 m east on a sheet of 5 px per metre
    expect((b?.[0] ?? 0) - (a?.[0] ?? 0)).toBeCloseTo(100, 6);
    expect(b?.[1]).toBeCloseTo(a?.[1] ?? NaN, 6);
  });

  it('on the map: one overlay per placed walk, none without a coordinate system', () => {
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    expect(placedMapOverlays(m, fits, new Set(), null).map((o) => o.id)).toEqual(['walk-walk-a']);
    expect(placedMapOverlays(m, fits, new Set(), 'walk-a')).toEqual([]);
    // the walk being edited is left out whatever surface it is placed on
    expect(walkBeingEdited({ layerId: 'walk-a' })).toBe('walk-a');
    expect(walkBeingEdited({ layerId: null })).toBeNull();
    expect(placedMapOverlays(m, fits, new Set(['walk-a']), null)).toEqual([]);
    const local = { ...m, crs: { wkt: 'LOCAL_CS["local"]' } };
    expect(placedMapOverlays(local, fits, new Set(), null)).toEqual([]);
  });

  it('on the map: the walk the 360 pane plays gets a dot at its time, apart from its path', () => {
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    const fit = fits[0]?.fit;
    const toLonLat = localToLonLat(m);
    if (!fit || !toLonLat) throw new Error('fixture');
    const dotAt = (t: number) => {
      const ov = placedNowMapOverlay(m, fits, new Set(), null, { layerId: 'walk-a', t });
      expect(ov?.id).toBe('walk-walk-a-now');
      if (!ov || typeof ov.data === 'string') throw new Error('no dot');
      const f = ov.data.features.find((x) => x.properties?.kind === 'now');
      return f?.geometry.type === 'Point' ? f.geometry.coordinates : null;
    };
    const want = (t: number) => {
      const a = fit.at(t);
      if (!a) throw new Error('fixture');
      return toLonLat([a.xz[0], 0, a.xz[1]]);
    };
    const early = dotAt(5);
    const late = dotAt(50);
    expect(early?.[0]).toBeCloseTo(want(5)[0], 9);
    expect(early?.[1]).toBeCloseTo(want(5)[1], 9);
    expect(late?.[0]).toBeCloseTo(want(50)[0], 9);
    expect(late).not.toEqual(early);
    // nothing plays, another walk plays, the walk is hidden or a session edits it: no dot
    expect(placedNowMapOverlay(m, fits, new Set(), null, { layerId: null, t: null })).toBeNull();
    expect(placedNowMapOverlay(m, fits, new Set(), null, { layerId: 'walk-z', t: 5 })).toBeNull();
    const playing = { layerId: 'walk-a', t: 5 };
    expect(placedNowMapOverlay(m, fits, new Set(['walk-a']), null, playing)).toBeNull();
    expect(placedNowMapOverlay(m, fits, new Set(), 'walk-a', playing)).toBeNull();
  });

  it('on the map: the dot follows the pane and goes when the pane clears', () => {
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    const drawn: (MapOverlay | null)[] = [];
    const stop = watchWalkPlayback(
      (id) => fits.some((w) => w.layer.id === id),
      (playing) => drawn.push(placedNowMapOverlay(m, fits, new Set(), null, playing)),
    );
    setWalkPlayback('walk-a', 5);
    expect(drawn.at(-1)?.id).toBe('walk-walk-a-now');
    clearWalkPlayback('walk-a');
    expect(drawn.at(-1)).toBeNull();
    stop();
  });

  it('on a drawing: the walk the 360 pane plays gets a dot at its time', () => {
    const m = projectWith([plan, other, placedOnOwn()]).manifest;
    const fits = placedWalkFits(m, pinsOnly, lookup);
    const at = (t: number) =>
      placedNowOnSheet(m, 'sheet-own', fits, lookup, { layerId: 'walk-a', t })?.at;
    expect(at(5)).toBeDefined();
    expect(at(50)).not.toEqual(at(5));
    expect(placedNowOnSheet(m, 'sheet-own', fits, lookup, { layerId: null, t: null })).toBeNull();
    expect(
      placedNowOnSheet(
        m,
        'sheet-own',
        fits,
        lookup,
        { layerId: 'walk-a', t: 5 },
        {
          hidden: new Set(['walk-a']),
        },
      ),
    ).toBeNull();
  });
});
