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
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ saveLayers: vi.fn() }), subscribe: () => () => undefined },
}));

import {
  createPlaceSession,
  createPlaceUi,
  createPlaceWalk,
  followMap,
  loadWalkInputs,
  viewHeading,
  walkColour,
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
    expect(session.getState().step).toBe('surface');
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
