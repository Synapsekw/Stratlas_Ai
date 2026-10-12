// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitWalk } from '@aio/geo';
import { ProjectManifest, WalkRawPath, type WalkLayer } from '@aio/schema';
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
  placedWalkFits,
  viewHeading,
  walkColour,
  walksOnSheet,
  type PlaceWalkDeps,
} from './placeWalk';
import { setWalkMapOverlays, setWalkMapPick, walkMap } from './walkMapStore';

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
    ...over,
  };
  return { ui, session, openSurface, save, flow: createPlaceWalk(deps, session, ui) };
}

describe('createPlaceWalk', () => {
  it('opens the split on the surface it was last placed on and starts the session', async () => {
    const project = {
      current: projectWith([
        plan,
        walkLayer({
          place: {
            pins: [],
            yawOffsetDeg: 0,
            heightM: 1.7,
            quality: 'unplaced',
            placedOn: '@model',
          },
        }),
      ]),
    };
    const { flow, openSurface, session, ui } = flowFor(project);
    await flow.begin('walk-a');
    expect(openSurface).toHaveBeenCalledWith('walk-a', { kind: 'map' });
    expect(ui.getState().host).toEqual({ kind: 'map' });
    expect(session.getState().layerId).toBe('walk-a');
    // the remembered surface is chosen: the strip opens on Start with the select showing it
    expect(session.getState().surface).toEqual({ kind: 'map' });
    expect(session.getState().step).toBe('start');
  });

  it('Place walk on another walk with unsaved pins asks first, then places it after Discard', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    const { flow, session, ui, openSurface } = flowFor(project);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'map' });
    session.getState().click([0, 0], 0);
    expect(session.getState().dirty).toBe(true);
    openSurface.mockClear();
    await flow.begin('walk-b');
    expect(ui.getState()).toMatchObject({ layerId: 'walk-a', asking: true, pending: 'walk-b' });
    expect(session.getState().layerId).toBe('walk-a');
    // the question is shown where the strip sits
    expect(openSurface).toHaveBeenCalledWith('walk-a', { kind: 'map' });
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

describe('the walk on the map while it is placed there', () => {
  afterEach(() => {
    setWalkMapOverlays([]);
    setWalkMapPick(null);
  });

  it('draws the path, the position and pins, picks the armed pin, and clears on close', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'map' });
    // waiting for the start click: the map picks a point
    const pick = walkMap.getState().pick;
    expect(pick).not.toBeNull();
    pick?.onPick([2, 0.5, 3]);
    expect(session.getState().pins[0]).toMatchObject({ surface: '@model', at: [2, 3], y: 0.5 });
    // the end is asked next: armed again
    expect(walkMap.getState().pick).not.toBeNull();
    walkMap.getState().pick?.onPick([40, 0, 3]);
    expect(session.getState().step).toBe('correct');
    expect(walkMap.getState().pick).toBeNull();
    const ids = walkMap.getState().overlays.map((o) => o.id);
    expect(ids).toEqual(['walk-walk-a', 'walk-walk-a-now']);
    const path = walkMap.getState().overlays[0];
    expect(path?.tooltip?.({ kind: 'pin', active: false })).toBe('The drawing it was on is gone');
    expect(path?.tooltip?.({ kind: 'pin', active: true })).toBeNull();
    // a time tick moves the position only: the path overlay is the same object
    session.getState().setTime(10);
    expect(walkMap.getState().overlays[0]).toBe(path);
    flow.discard();
    expect(walkMap.getState().overlays).toHaveLength(0);
    expect(walkMap.getState().pick).toBeNull();
    stop();
  });

  it('a walk removed while it is placed leaves the map, and the next walk is placed at once', async () => {
    const project = { current: projectWith([plan, walkLayer(), walkLayer({ id: 'walk-b' })]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'map' });
    walkMap.getState().pick?.onPick([2, 0.5, 3]);
    expect(walkMap.getState().overlays.length).toBeGreaterThan(0);
    // removed from the project (any way: the sidebar, an undo, a reload)
    project.current = projectWith([plan, walkLayer({ id: 'walk-b' })]);
    flow.dropIfGone();
    expect(session.getState().layerId).toBeNull();
    expect(ui.getState().layerId).toBeNull();
    expect(walkMap.getState().overlays).toHaveLength(0);
    expect(walkMap.getState().pick).toBeNull();
    // no hidden "Keep these pins?" holds the next walk back
    await flow.begin('walk-b');
    expect(ui.getState().asking).toBe(false);
    expect(session.getState().layerId).toBe('walk-b');
    // a walk still there is left alone
    flow.dropIfGone();
    expect(session.getState().layerId).toBe('walk-b');
    stop();
  });

  it('a pin armed to move takes the next map click', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'map' });
    walkMap.getState().pick?.onPick([2, 0.5, 3]);
    walkMap.getState().pick?.onPick([40, 0, 3]);
    expect(walkMap.getState().pick).toBeNull();
    session.getState().armMove(0);
    walkMap.getState().pick?.onPick([5, 0.2, 6]);
    expect(session.getState().pins[0]).toMatchObject({ at: [5, 6], y: 0.2 });
    expect(session.getState().pins[1]).toMatchObject({ at: [40, 3] });
    expect(walkMap.getState().pick).toBeNull();
    flow.discard();
    stop();
  });

  it('does nothing while the walk is placed on a drawing', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session, ui } = flowFor(project);
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'drawing', id: 'sheet-own', name: 'Ground floor', dated: false });
    expect(walkMap.getState().pick).toBeNull();
    expect(walkMap.getState().overlays).toHaveLength(0);
    stop();
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
    expect(placedMapOverlays(m, fits, new Set(['walk-a']), null)).toEqual([]);
    const local = { ...m, crs: { wkt: 'LOCAL_CS["local"]' } };
    expect(placedMapOverlays(local, fits, new Set(), null)).toEqual([]);
  });
});
