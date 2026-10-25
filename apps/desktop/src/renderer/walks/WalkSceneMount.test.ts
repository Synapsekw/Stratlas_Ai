// @vitest-environment jsdom
import { fitWalk } from '@aio/geo';
import type { WalkLayer, WalkPin } from '@aio/schema';
import type { SheetWalk } from './walkOverlay';
import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

// the mount's module graph reaches the shell and the builder: stub them as placeWalk.test.ts does
vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  shell: { getState: () => ({ screen: 'scene', stageMode: '3d', go: vi.fn() }) },
  jobs: { getState: () => ({ jobs: [], start: vi.fn() }), subscribe: () => () => undefined },
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ saveLayers: vi.fn() }), subscribe: () => () => undefined },
}));

const {
  drapePlaced,
  LOADED_SETTLE_MS,
  pickedHeight,
  placedReach,
  resampleWhenSettled,
  sceneMarkers,
  scenePlacedWalks,
  scenePlacing,
  SETTLE_MS,
  walkReach,
} = await import('./WalkSceneMount');
const { DRAPE_LIFT_M } = await import('./walkScene');

describe('scenePlacing', () => {
  const pins: WalkPin[] = [
    { t: 0, surface: '@model', at: [0, 0], y: 1 },
    { t: 10, surface: '@model', at: [10, 0], y: 1 },
  ];
  const fit = fitWalk(null, { pins, yawOffsetDeg: 0 }, { drawing: () => null }, 10);
  const base = {
    layerId: 'walk-a',
    surface: { kind: '3d' } as const,
    fit,
    pins,
    preview: null,
    armed: null,
  };

  it('nothing unless the session places on the 3D view', () => {
    expect(
      scenePlacing({ ...base, surface: { kind: 'map' }, step: 'placed' }, '#fff', 10),
    ).toBeNull();
    expect(scenePlacing({ ...base, layerId: null, step: 'placed' }, '#fff', 10)).toBeNull();
  });

  it('placed: the path and two handles at the pins, no clicks wanted', () => {
    const p = scenePlacing({ ...base, step: 'placed' }, '#fff', 10);
    expect(p?.handles.map((h) => h.id)).toEqual(['start', 'end']);
    expect(p?.handles[0]?.at).toEqual([0, 1, 0]);
    expect(p?.walk?.runs.length).toBeGreaterThan(0);
    expect(p?.clicks).toBe(false);
  });

  it('start: a click is wanted and the ghost is drawn at its height', () => {
    const p = scenePlacing(
      {
        ...base,
        pins: [],
        step: 'start',
        preview: {
          xz: [
            [0, 0],
            [1, 0],
          ],
          at: [
            [0, 0],
            [1, 0],
          ],
          ghost: true,
          tooClose: false,
          y: [2, 2],
        },
      },
      '#fff',
      10,
    );
    expect(p?.clicks).toBe(true);
    expect(p?.walk).toBeNull();
    expect(p?.preview?.pts[0]?.[1]).toBeCloseTo(2.1);
  });
});

describe('scenePlacedWalks', () => {
  const pins: WalkPin[] = [
    { t: 0, surface: '@model', at: [0, 0], y: 0 },
    { t: 10, surface: '@model', at: [10, 0], y: 0 },
  ];
  const fit = fitWalk(null, { pins, yawOffsetDeg: 0 }, { drawing: () => null }, 10);
  const walk = (id: string, visible = true): SheetWalk => ({
    layer: { id, visible, durationS: 10 } as unknown as WalkLayer,
    fit,
    raw: null,
  });
  const fits = [walk('walk-a'), walk('walk-b'), walk('walk-c', false), walk('walk-d')];

  it('visible placed walks, not switched off ones, and never the walk being edited', () => {
    const out = scenePlacedWalks(fits, new Set(['walk-d']), 'walk-a', () => '#123456');
    expect(out.map((w) => w.id)).toEqual(['walk-b']);
    expect(out[0]?.colour).toBe('#123456');
    expect(out[0]?.runs.length).toBeGreaterThan(0);
  });

  it('a walk of a lined-up date is drawn shifted', () => {
    const moved = { ...walk('walk-a'), shift: { eastM: 2, northM: -1 } };
    const [still, shifted] = [walk('walk-a'), moved].map(
      (w) => scenePlacedWalks([w], new Set(), null, () => '#fff')[0]?.runs[0]?.pts[0],
    );
    expect(shifted?.[0]).toBeCloseTo((still?.[0] ?? NaN) + 2, 9);
    expect(shifted?.[1]).toBeCloseTo(still?.[1] ?? NaN, 9);
    expect(shifted?.[2]).toBeCloseTo((still?.[2] ?? NaN) + 1, 9);
  });

  it('points sit at the stored ground, unlifted (the drape lifts them)', () => {
    const out = scenePlacedWalks([walk('walk-a')], new Set(), null, () => '#fff');
    expect(out[0]?.runs.flatMap((r) => r.pts).every((p) => p[1] === 0)).toBe(true);
  });

  it('nothing edited: every visible walk', () => {
    expect(scenePlacedWalks(fits, new Set(), null, () => '#fff').map((w) => w.id)).toEqual([
      'walk-a',
      'walk-b',
      'walk-d',
    ]);
  });
});

describe('sceneMarkers', () => {
  const pins: WalkPin[] = [
    { t: 0, surface: '@model', at: [0, 0], y: 0 },
    { t: 10, surface: '@model', at: [10, 0], y: 0 },
  ];
  const fit = fitWalk(null, { pins, yawOffsetDeg: 0 }, { drawing: () => null }, 10);
  const walk = (id: string, visible = true): SheetWalk => ({
    layer: { id, visible, durationS: 10 } as unknown as WalkLayer,
    fit,
    raw: null,
  });
  const view = (t: number, lookDeg: number | null) => ({
    t,
    lookDeg,
    pitchDeg: 0,
    fovDeg: 60,
    hfovDeg: 90,
  });
  // the ortho sits 3 m below the stored pins
  const ground = () => -3;

  it('one Beam per walk a pane shows, on the ground the view draws, turned to the look', () => {
    const out = sceneMarkers(
      [walk('walk-a'), walk('walk-b')],
      { 'walk-a': view(5, 90), 'walk-b': view(2, null) },
      new Set(),
      null,
      () => '#abcdef',
      ground,
    );
    expect(out.map((m) => m.id)).toEqual(['walk-a', 'walk-b']);
    const [a, b] = out;
    expect(a?.at[0]).toBeCloseTo(5, 6);
    expect(a?.at[1]).toBe(-3);
    expect(a?.lookHeadingRad).toBeCloseTo(-Math.PI / 2, 9);
    expect(a?.halfRad).toBeCloseTo(Math.PI / 4, 9);
    expect(a?.colour).toBe('#abcdef');
    expect(b?.lookHeadingRad).toBeNull();
    // nothing drawn below: the stored pin height
    const bare = sceneMarkers(
      [walk('walk-a')],
      { 'walk-a': view(5, 0) },
      new Set(),
      null,
      () => '#fff',
      () => null,
    );
    expect(bare[0]?.at[1]).toBeCloseTo(0, 9);
  });

  it("asks the ground near the walk's stored height, under the spot and under its cone", () => {
    const asked = vi.fn<(x: number, z: number, near?: number) => number | null>(() => 1);
    const [m] = sceneMarkers(
      [walk('walk-a')],
      { 'walk-a': view(5, 90) },
      new Set(),
      null,
      () => '#fff',
      asked,
    );
    expect(m?.at[1]).toBe(1);
    expect(asked).toHaveBeenLastCalledWith(expect.closeTo(5, 6), expect.closeTo(0, 6), 0);
    expect(m?.ground?.(6, 1)).toBe(1);
    expect(asked).toHaveBeenLastCalledWith(6, 1, 0);
  });

  it('a walk of a turned date turns its look and its way with its track', () => {
    const turned = {
      eastM: 0,
      northM: 0,
      turn: { rotationDeg: 90, scale: 1, pivotE: 0, pivotN: 0, pivotX: 0, pivotZ: 0 },
    };
    const [plain] = sceneMarkers(
      [walk('walk-a')],
      { 'walk-a': view(5, 90) },
      new Set(),
      null,
      () => '#fff',
      ground,
    );
    const [m] = sceneMarkers(
      [{ ...walk('walk-a'), shift: turned }],
      { 'walk-a': view(5, 90) },
      new Set(),
      null,
      () => '#fff',
      ground,
    );
    // a quarter turn anticlockwise: a look east now looks north, the track east now runs north
    expect(m?.lookHeadingRad).toBeCloseTo(0, 9);
    expect(m?.walkHeadingRad).toBeCloseTo((plain?.walkHeadingRad ?? NaN) + Math.PI / 2, 9);
    expect(m?.at[2]).toBeCloseTo(-5, 6);
  });

  it('none for a hidden walk, a switched off one, the walk being edited or one without a pane', () => {
    const fits = [walk('walk-a'), walk('walk-c', false)];
    const views = { 'walk-a': view(5, 0), 'walk-c': view(5, 0), 'walk-z': view(5, 0) };
    expect(sceneMarkers(fits, views, new Set(['walk-a']), null, () => '#fff', ground)).toEqual([]);
    expect(sceneMarkers(fits, views, new Set(), 'walk-a', () => '#fff', ground)).toEqual([]);
  });
});

describe('pickedHeight', () => {
  it('a pin picked in 3D stands on the ground the walks drape onto near the pick', () => {
    // picked on the ortho plane at 0; the floor in the cloud 1.25 m up
    const ground = vi.fn(() => 1.25);
    expect(pickedHeight([3, 4], 0, ground)).toBe(1.25);
    expect(ground).toHaveBeenCalledWith(3, 4, 0);
  });

  it('keeps the picked height where the ground answers nothing', () => {
    expect(pickedHeight([3, 4], 2, () => null)).toBe(2);
  });
});

describe('walkReach', () => {
  it('nothing without points or a reach', () => {
    expect(walkReach([], null, 0)).toBeNull();
    expect(walkReach([], new Vector3(), 0)).toBeNull();
  });

  it('the points, and a cube of the walk length about the centre while placing', () => {
    const pts = walkReach(
      [
        [0, 0, 0],
        [40, 1, 30],
      ],
      null,
      0,
    );
    expect(pts?.max.toArray()).toEqual([40, 1, 30]);
    const placing = walkReach([[1, 0, 1]], new Vector3(0, 0, 0), 75);
    expect(placing?.min.toArray()).toEqual([-75, -75, -75]);
    expect(placing?.max.toArray()).toEqual([75, 75, 75]);
  });
});

describe('placedReach', () => {
  const placed = [
    {
      id: 'walk-a',
      colour: '#fff',
      runs: [
        {
          pts: [
            [0, 0, 0],
            [400, 1, 300],
          ] as [number, number, number][],
          dashed: false,
        },
      ],
    },
  ];

  it('the placed walks widen the reach only while a walk is placed on the 3D view', () => {
    expect(placedReach(placed, false)).toBeNull();
    expect(placedReach(placed, true)?.max.toArray()).toEqual([400, 1, 300]);
  });
});

describe('drapePlaced', () => {
  const pts = (y: number): [number, number, number][] => [
    [0, y, 0],
    [1, y, 0],
    [2, y, 0],
  ];
  const placed = [
    { id: 'walk-a', colour: '#f00', runs: [{ pts: pts(0), dashed: false }] },
    {
      id: 'walk-b',
      colour: '#0f0',
      runs: [
        { pts: pts(5), dashed: false },
        { pts: pts(5), dashed: true },
      ],
    },
  ];

  it('every walk on the drawn ground, lifted, its runs and colours kept', () => {
    const done = vi.fn();
    drapePlaced(placed, () => 7, done);
    const out = done.mock.calls[0]?.[0] as typeof placed;
    expect(out.map((w) => [w.id, w.colour, w.runs.length])).toEqual([
      ['walk-a', '#f00', 1],
      ['walk-b', '#0f0', 2],
    ]);
    expect(out[1]?.runs[1]?.dashed).toBe(true);
    for (const p of out.flatMap((w) => w.runs.flatMap((r) => r.pts)))
      expect(p[1]).toBeCloseTo(7 + DRAPE_LIFT_M, 9);
  });

  it('off the drawn ground a walk keeps its stored height', () => {
    const done = vi.fn();
    drapePlaced(placed, (x) => (x < 1 ? 7 : null), done, { stepM: 1 });
    const out = done.mock.calls[0]?.[0] as typeof placed;
    expect(out[1]?.runs[0]?.pts.map((p) => p[1] - DRAPE_LIFT_M)).toEqual(
      [7, 5, 5].map((y): unknown => expect.closeTo(y, 9)),
    );
  });

  it('a long walk is draped over frames, and can be called off', () => {
    const queue: (() => void)[] = [];
    const scheduler = {
      request: (cb: () => void) => queue.push(cb),
      cancel: vi.fn(),
    };
    const done = vi.fn();
    const ground = vi.fn(() => 1);
    const cancel = drapePlaced(placed, ground, done, { budget: 4, scheduler });
    expect(ground).toHaveBeenCalledTimes(4);
    expect(done).not.toHaveBeenCalled();
    cancel();
    expect(scheduler.cancel).toHaveBeenCalled();
  });
});

describe('resampleWhenSettled', () => {
  /** Timers stepped by hand. */
  function clock() {
    let now = 0;
    let next = 1;
    const due = new Map<number, { at: number; cb: () => void }>();
    return {
      timers: {
        set: (cb: () => void, ms: number) => {
          due.set(next, { at: now + ms, cb });
          return next++;
        },
        clear: (h: number) => {
          due.delete(h);
        },
      },
      run(ms: number) {
        now += ms;
        for (const [h, d] of [...due].sort((a, b) => a[1].at - b[1].at))
          if (d.at <= now) {
            due.delete(h);
            d.cb();
          }
      },
    };
  }

  it('asks the ground again once, when things settle: never at once and twice', () => {
    const c = clock();
    const resample = vi.fn();
    resampleWhenSettled(() => () => undefined, resample, c.timers);
    expect(resample).not.toHaveBeenCalled();
    c.run(SETTLE_MS);
    expect(resample).toHaveBeenCalledTimes(1);
    c.run(SETTLE_MS * 4);
    expect(resample).toHaveBeenCalledTimes(1);
  });

  it('layers that load close together are answered once, after the last', () => {
    const c = clock();
    const resample = vi.fn();
    let loaded: () => void = () => undefined;
    const stop = resampleWhenSettled(
      (cb) => {
        loaded = cb;
        return () => undefined;
      },
      resample,
      c.timers,
    );
    c.run(SETTLE_MS);
    resample.mockClear();
    loaded();
    c.run(LOADED_SETTLE_MS / 2);
    loaded();
    c.run(LOADED_SETTLE_MS / 2);
    expect(resample).not.toHaveBeenCalled();
    c.run(LOADED_SETTLE_MS);
    expect(resample).toHaveBeenCalledTimes(1);
    // stopped: nothing more
    loaded();
    stop();
    c.run(SETTLE_MS);
    expect(resample).toHaveBeenCalledTimes(1);
  });
});
