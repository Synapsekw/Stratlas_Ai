import { describe, expect, it } from 'vitest';
import {
  drawReducer,
  findSnap,
  initialDraw,
  lockAngle,
  lockBearings,
  measurementSnaps,
  parseBearing,
  parseTyped,
  type DrawEnv,
  type DrawEvent,
  type DrawState,
  type SnapProvider,
  type ToScreen,
} from './draw';
import { editReducer, hitMidpoint, hitVertex, initialEdit } from './edit';
import { bearingDeg, horizontalDistance, type Pt } from './geometry';

const E0 = 512_340;
const N0 = 2_710_250;
const at = (dx: number, dy: number, z = 0): Pt => [E0 + dx, N0 + dy, z];
/** A plan view at 10 px per metre, y down. */
const toScreen: ToScreen = (p) => ({ x: (p[0] - E0) * 10, y: -(p[1] - N0) * 10 });
const scr = (p: Pt) => toScreen(p) ?? { x: 0, y: 0 };

const run = (s: DrawState, events: DrawEvent[], env: DrawEnv = {}) =>
  events.reduce((acc, e) => drawReducer(acc, e, env), s);
const click = (p: Pt, shift = false): DrawEvent => ({
  type: 'click',
  raw: p,
  screen: scr(p),
  shift,
});
const move = (p: Pt, shift = false): DrawEvent => ({ type: 'move', raw: p, screen: scr(p), shift });
const keys = (text: string): DrawEvent[] => text.split('').map((key) => ({ type: 'key', key }));
const key = (k: string): DrawEvent => ({ type: 'key', key: k });

describe('snapping', () => {
  const design: SnapProvider = {
    source: 'design',
    vertices: () => [at(10, 10, 5)],
    segments: () => [[at(0, 20, 1), at(20, 20, 3)]],
  };

  it('snaps to a vertex within the pixel tolerance, before a nearer edge', () => {
    const hit = findSnap({ x: 105, y: -95 }, [design], toScreen);
    expect(hit).toMatchObject({ source: 'design', kind: 'vertex', point: at(10, 10, 5) });
    expect(findSnap({ x: 130, y: -130 }, [design], toScreen)).toBeNull();
  });

  it('snaps to the nearest point on an edge with its height interpolated', () => {
    const hit = findSnap({ x: 50, y: -196 }, [design], toScreen);
    expect(hit?.kind).toBe('edge');
    expect(hit?.point[0]).toBeCloseTo(E0 + 5, 9);
    expect(hit?.point[1]).toBeCloseTo(N0 + 20, 9);
    expect(hit?.point[2]).toBeCloseTo(1.5, 9);
  });

  it('honours the source, vertex and edge toggles and the tolerance', () => {
    const off = { ...DEFAULTS, sources: { ...DEFAULTS.sources, design: false } };
    expect(findSnap({ x: 100, y: -100 }, [design], toScreen, off)).toBeNull();
    const edgesOnly = { ...DEFAULTS, vertices: false };
    expect(findSnap({ x: 100, y: -100 }, [design], toScreen, edgesOnly)).toBeNull();
    const wide = { ...DEFAULTS, tolerancePx: 50 };
    expect(findSnap({ x: 130, y: -130 }, [design], toScreen, wide)?.kind).toBe('vertex');
  });

  it('offers saved measurements as vertices and edges, polygons closed', () => {
    const p = measurementSnaps([
      { points: [at(0, 0), at(10, 0), at(10, 10)], closed: true },
      { points: [at(50, 50), at(60, 50)], closed: false },
    ]);
    expect(p.vertices()).toHaveLength(5);
    expect(p.segments()).toHaveLength(4);
  });
});

const DEFAULTS = {
  sources: { measurement: true, design: true, alignment: true, guide: true },
  vertices: true,
  edges: true,
  tolerancePx: 10,
};

describe('angle lock', () => {
  it('locks to 15 degree steps and keeps the distance along the locked bearing', () => {
    const prev = at(0, 0);
    const l = lockAngle(prev, at(10, 1.2)); // bearing ~83.2 degrees
    expect(l.bearing).toBe(90);
    expect(l.point[0]).toBeCloseTo(E0 + 10, 9);
    expect(l.point[1]).toBeCloseTo(N0, 9);
    const l2 = lockAngle(prev, at(7, 7.5)); // ~43 degrees: 45
    expect(l2.bearing).toBe(45);
  });

  it('offers the last segment bearing, its reverse and perpendiculars', () => {
    expect(lockBearings(15, 37)).toEqual(expect.arrayContaining([37, 127, 217, 307]));
    const l = lockAngle(at(0, 0), at(6, 8.2), 15, 37);
    expect(l.bearing).toBe(37);
  });
});

describe('typed values', () => {
  it('parses distances and bearings, decimal or DMS', () => {
    expect(parseTyped('25')).toBe(25);
    expect(parseTyped('12.5')).toBe(12.5);
    expect(parseTyped('1e3')).toBeNull();
    expect(parseBearing('45')).toBe(45);
    expect(parseBearing("45 30'")).toBeCloseTo(45.5, 12);
    expect(parseBearing('360')).toBeNull();
    expect(parseBearing('10 75')).toBeNull();
  });
});

describe('drawing a polyline', () => {
  const flat: DrawEnv = { clampZ: () => 100 };

  it('adds a 25 m segment with a typed distance along the cursor direction', () => {
    let s = run(initialDraw('line'), [click(at(0, 0, 100)), move(at(3, 4, 100))], flat);
    s = run(s, [...keys('25'), key('Enter')], flat);
    expect(s.points).toHaveLength(2);
    const [a, b] = s.points as [Pt, Pt];
    expect(horizontalDistance(a, b)).toBeCloseTo(25, 9);
    expect(bearingDeg(a, b)).toBeCloseTo(bearingDeg(at(0, 0), at(3, 4)), 9);
    expect(b[2]).toBe(100);
  });

  it('takes a typed distance in the display unit (US survey feet)', () => {
    const env = { ...flat, distanceUnit: 'us-ft' as const };
    const s = run(
      initialDraw('line'),
      [click(at(0, 0)), move(at(0, 9)), ...keys('100'), key('Enter')],
      env,
    );
    const [a, b] = s.points as [Pt, Pt];
    expect(horizontalDistance(a, b)).toBeCloseTo((100 * 1200) / 3937, 9);
  });

  it('holds Shift to lock the angle, then types a bearing and distance', () => {
    let s = run(initialDraw('line'), [click(at(0, 0)), move(at(20, 2), true)], flat);
    expect(s.lockedBearing).toBe(90);
    s = run(s, [click(at(20, 2), true)], flat);
    expect(s.points[1]?.[0]).toBeCloseTo(E0 + 20, 9);
    expect(s.points[1]?.[1]).toBeCloseTo(N0, 9);
    // Tab to the bearing, type 180, Tab back, type 10, Enter
    s = run(s, [key('Tab'), ...keys('180'), key('Tab'), ...keys('10'), key('Enter')], flat);
    expect(s.points[2]?.[0]).toBeCloseTo(E0 + 20, 9);
    expect(s.points[2]?.[1]).toBeCloseTo(N0 - 10, 9);
    s = run(s, [key('Enter')], flat);
    expect(s.done).toBe(true);
  });

  it('snaps a click to a design vertex unless Shift locks the angle', () => {
    const design: SnapProvider = {
      source: 'design',
      vertices: () => [at(10, 10, 7)],
      segments: () => [],
    };
    const env: DrawEnv = { ...flat, snap: (screen) => findSnap(screen, [design], toScreen) };
    const s = run(initialDraw('line'), [click(at(0, 0)), click(at(10.4, 9.7))], env);
    expect(s.points[1]).toEqual(at(10, 10, 7));
    const locked = run(initialDraw('line'), [click(at(0, 0)), click(at(10.4, 9.7), true)], env);
    expect(locked.points[1]?.[2]).toBe(100);
  });

  it('clears typed text with Esc, then cancels the drawing with a second Esc', () => {
    let s = run(initialDraw('polygon'), [click(at(0, 0)), click(at(5, 0)), ...keys('12')], flat);
    expect(s.typing.distance).toBe('12');
    s = drawReducer(s, key('Escape'), flat);
    expect(s.typing.distance).toBe('');
    expect(s.points).toHaveLength(2);
    s = drawReducer(s, key('Escape'), flat);
    expect(s.cancelled).toBe(true);
    expect(s.points).toEqual([]);
  });

  it('finishes only with enough vertices; Backspace on an empty field undoes', () => {
    let s = run(initialDraw('polygon'), [click(at(0, 0)), click(at(5, 0))]);
    s = drawReducer(s, { type: 'finish' });
    expect(s.done).toBe(false);
    s = drawReducer(s, key('Backspace'));
    expect(s.points).toHaveLength(1);
    const point = run(initialDraw('point'), [click(at(1, 1, 3))]);
    expect(point.done).toBe(true);
  });

  it('thins a freehand stroke by spacing', () => {
    const s = run(
      initialDraw('markup'),
      [0, 0.01, 0.2, 0.25, 0.5].map((x) => ({ type: 'stroke', raw: at(x, 0) })),
      { strokeSpacingM: 0.1 },
    );
    expect(s.points).toHaveLength(3);
  });
});

describe('vertex editing', () => {
  const square = [at(0, 0), at(10, 0), at(10, 10), at(0, 10)];

  it('drags a vertex and Esc puts it back', () => {
    let s = initialEdit(square);
    s = editReducer(s, { type: 'down', vertex: 2 }, 'polygon');
    s = editReducer(s, { type: 'drag', p: at(12, 12) }, 'polygon');
    expect(s.points[2]).toEqual(at(12, 12));
    expect(s.dirty).toBe(true);
    s = editReducer(s, { type: 'escape' }, 'polygon');
    expect(s.points[2]).toEqual(at(10, 10));
  });

  it('inserts at the closing segment midpoint of a polygon and drags it', () => {
    let s = initialEdit(square);
    s = editReducer(s, { type: 'down-mid', seg: 3, z: 4 }, 'polygon');
    expect(s.points).toHaveLength(5);
    expect(s.points[4]).toEqual(at(0, 5, 4));
    expect(s.dragging).toBe(4);
  });

  it('deletes a vertex but never below the family minimum', () => {
    let s = initialEdit([at(0, 0), at(1, 0), at(1, 1)]);
    s = editReducer(s, { type: 'delete', vertex: 0 }, 'polygon');
    expect(s.points).toHaveLength(3);
    s = editReducer(initialEdit(square), { type: 'delete', vertex: 0 }, 'polygon');
    expect(s.points).toHaveLength(3);
  });

  it('types a vertex coordinate', () => {
    const s = editReducer(
      initialEdit(square),
      { type: 'set', vertex: 1, coords: { z: 9.5, n: N0 + 1 } },
      'polygon',
    );
    expect(s.points[1]).toEqual([E0 + 10, N0 + 1, 9.5]);
  });

  it('hit-tests vertices and midpoint handles on screen', () => {
    expect(hitVertex(square, { x: 98, y: -3 }, toScreen)).toBe(1);
    expect(hitVertex(square, { x: 50, y: -50 }, toScreen)).toBeNull();
    expect(hitMidpoint(square, true, { x: 2, y: -50 }, toScreen)).toBe(3);
    expect(hitMidpoint(square, false, { x: 2, y: -50 }, toScreen)).toBeNull();
  });
});
