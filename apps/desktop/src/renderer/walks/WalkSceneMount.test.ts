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

const { placedReach, scenePlacedWalks, scenePlacing, walkReach } = await import('./WalkSceneMount');

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

  it('nothing edited: every visible walk', () => {
    expect(scenePlacedWalks(fits, new Set(), null, () => '#fff').map((w) => w.id)).toEqual([
      'walk-a',
      'walk-b',
      'walk-d',
    ]);
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
