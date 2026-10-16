import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitWalk, walkPoseSamples } from '@aio/geo';
import {
  ProjectManifest,
  readWalkOrientationData,
  WalkOrientation,
  WalkRawPath,
  type PoseSample,
  type WalkLayer,
  type WalkPin,
} from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { DrawingLookup, PlaceSurface } from './placeModel';
import { canRemovePin, createPlaceStore, DRAWING_NOT_READY, wrapDeg } from './placeStore';

const raw = WalkRawPath.parse(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../../../packages/schema/src/__fixtures__/walk/raw-path.synthetic.json',
      ),
      'utf8',
    ),
  ) as unknown,
);
const fixtures = join(import.meta.dirname, '../../../../../packages/schema/src/__fixtures__/walk');
const orientHeader = WalkOrientation.parse(
  JSON.parse(readFileSync(join(fixtures, 'orientation.synthetic.json'), 'utf8')) as unknown,
);
const rows = readWalkOrientationData(
  orientHeader,
  new Uint8Array(readFileSync(join(fixtures, orientHeader.data))),
);
const lastT = raw.stills[raw.stills.length - 1]?.t ?? 0;

/** The synthetic walk's ground truth (tools/fixtures/walk-truth.mjs): raw = s * Ry(rot) * p + shift. */
const TRUTH = { rotDeg: 37, scale: 0.23, shift: [3, -1, 7] } as const;

/** The true model [x, z] at t, from the fixture's own registered stills. */
function truthXZ(t: number): [number, number] {
  const reg = raw.stills.filter((s) => s.pos);
  let i = 0;
  while (i + 1 < reg.length && (reg[i + 1]?.t ?? Infinity) <= t) i++;
  const a = reg[i];
  const b = reg[i + 1] ?? a;
  if (!a?.pos || !b?.pos) throw new Error('no registered still');
  const toModel = (p: readonly number[]): [number, number] => {
    const r = (TRUTH.rotDeg * Math.PI) / 180;
    const x = ((p[0] ?? 0) - TRUTH.shift[0]) / TRUTH.scale;
    const z = ((p[2] ?? 0) - TRUTH.shift[2]) / TRUTH.scale;
    return [Math.cos(r) * x - Math.sin(r) * z, Math.sin(r) * x + Math.cos(r) * z];
  };
  const pa = toModel(a.pos);
  const pb = toModel(b.pos);
  const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  return [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f];
}

// A drawing at 0.1 m per pixel, top-left at model (10, 2, 20).
const drawings: DrawingLookup = (id) =>
  id === 'sheet-a' ? { provisional: false, size: { width: 1000, height: 1000 } } : undefined;

const m = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [{ id: 'c1', label: 'First', date: '2026-01-01' }],
  layers: [
    {
      kind: 'raster',
      id: 'sheet-a',
      name: 'Plan',
      capture: 'c1',
      src: { path: 'drawings/a/plan.png' },
      role: 'plan',
      format: 'image',
      corners: { tl: [10, 2, 20], tr: [110, 2, 20], bl: [10, 2, 120] },
    },
  ],
  severityModels: [],
  classCatalogues: [],
});

function walk(extra: Partial<WalkLayer> = {}): WalkLayer {
  return {
    kind: 'walk',
    id: 'walk-a',
    name: 'Walk A',
    visible: true,
    capture: 'c1',
    record: { path: 'walks/a/walk.json' },
    src: { path: 'walks/a/playback.mp4' },
    durationS: 62,
    ...extra,
  };
}

const MAP: PlaceSurface = { kind: 'map' };
const SHEET: PlaceSurface = { kind: 'drawing', id: 'sheet-a', name: 'Plan', dated: true };

function setup(w: WalkLayer = walk()) {
  const seek = vi.fn<(t: number) => void>();
  const store = createPlaceStore({ fit: fitWalk, seek });
  store.getState().start(w, m, { raw, drawings });
  return { store, seek, s: () => store.getState() };
}

/** A session on the map with the start and end pins at their true spots: placed. */
function placedOnMap() {
  const k = setup();
  k.s().chooseSurface(MAP);
  k.s().click(truthXZ(4));
  k.s().click(truthXZ(lastT));
  return k;
}

/** Placed on the map, then Fine-tune on. */
function fineTuning() {
  const k = placedOnMap();
  k.s().setFineTune(true);
  return k;
}

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

const DEG = Math.PI / 180;
/** Model x/z of the synthetic walk at t, from its own raw stills through the inverse truth. */
function modelAt(t: number): [number, number] {
  const reg = raw.stills.filter((s) => s.pos);
  let i = 0;
  while (i + 1 < reg.length && (reg[i + 1]?.t ?? Infinity) <= t) i++;
  const p = reg[i]?.pos ?? [0, 0, 0];
  const a = TRUTH.rotDeg * DEG;
  const x = (p[0] - TRUTH.shift[0]) / TRUTH.scale;
  const z = (p[2] - TRUTH.shift[2]) / TRUTH.scale;
  return [Math.cos(a) * x - Math.sin(a) * z, Math.sin(a) * x + Math.cos(a) * z];
}

function session(
  opts: { raw?: WalkRawPath | null; ready?: boolean; layer?: Partial<WalkLayer> } = {},
) {
  const store = createPlaceStore({ fit: fitWalk, seek: vi.fn() });
  const w = walk(opts.layer);
  store.getState().start(w, m, {
    raw: opts.raw === undefined ? raw : opts.raw,
    drawings,
    ...(opts.ready === undefined ? {} : { ready: opts.ready }),
  });
  return store;
}

/** Start and end clicked on the 3D view at the truth: the walk is placed. */
function placeTwo() {
  const s = session();
  s.getState().chooseSurface({ kind: '3d' });
  s.getState().click(modelAt(4), 0);
  s.getState().click(modelAt(62), 0);
  return s;
}

describe('start and end', () => {
  it('opens on Start for a walk with a usable path', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    expect(s.getState().step).toBe('start');
  });

  it('seeks to walking.startT, then walking.endT after the start click', () => {
    const { s, seek } = setup();
    s().chooseSurface(MAP);
    expect(seek).toHaveBeenLastCalledWith(4);
    s().click(truthXZ(4));
    expect(seek).toHaveBeenLastCalledWith(lastT);
  });

  it('opens on the path check without a usable path; Place anyway goes on to Start', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: 'map' });
    expect(s.getState().step).toBe('check');
    s.getState().click([0, 0]);
    expect(s.getState().pins).toHaveLength(0);
    s.getState().placeAnyway();
    expect(s.getState().step).toBe('start');
  });

  it('before the start a ghost of the whole shape follows the cursor, its first point under it', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().hover([10, 20], 1.5);
    const p = s.getState().preview;
    expect(p?.ghost).toBe(true);
    expect(p?.xz[0]).toEqual([10, 20]);
    expect(p?.y).toEqual([1.5, 1.5]);
    s.getState().hover(null);
    expect(s.getState().preview).toBeNull();
  });

  it('the start click sets a pin at walking.startT; the shape then runs from it to the cursor', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().click(modelAt(4), 2);
    expect(s.getState().step).toBe('end');
    expect(s.getState().pins[0]).toMatchObject({ t: 4, surface: '@model', y: 2 });
    s.getState().hover(modelAt(62), 3);
    const p = s.getState().preview;
    expect(p?.ghost).toBe(false);
    expect(p?.tooClose).toBe(false);
    expect(p?.y).toEqual([2, 3]);
    const last = p?.xz.at(-1);
    const end = modelAt(62);
    expect(Math.hypot((last?.[0] ?? 0) - end[0], (last?.[1] ?? 0) - end[1])).toBeLessThan(0.5);
  });

  it('an end in the same area as the start is placed', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    const a = modelAt(4);
    s.getState().click(a);
    s.getState().hover([a[0] + 3, a[1]]);
    expect(s.getState().preview?.tooClose).toBe(false);
    s.getState().click([a[0] + 3, a[1]]);
    expect(s.getState().step).toBe('placed');
    expect(s.getState().pins).toHaveLength(2);
    expect(s.getState().error).toBeNull();
  });

  it('an end refused for another reason than the 5 m span says why', () => {
    const fit = vi.fn<typeof fitWalk>((...args) => {
      const f = fitWalk(...args);
      return args[1].pins.length >= 2 ? { ...f, error: 'Those pins cannot be fitted' } : f;
    });
    const store = createPlaceStore({ fit, seek: vi.fn() });
    const s = () => store.getState();
    s().start(walk(), m, { raw, drawings });
    s().chooseSurface(MAP);
    s().click(truthXZ(4));
    s().click(truthXZ(lastT));
    expect(s().step).toBe('end');
    expect(s().pins).toHaveLength(1);
    expect(s().error).toBe('Those pins cannot be fitted');
  });

  it('the end click places the walk: pins at 4 s and 62 s, the corner where the walk turned', () => {
    const s = placeTwo();
    expect(s.getState().step).toBe('placed');
    expect(s.getState().pins.map((p) => p.t)).toEqual([4, 62]);
    expect(s.getState().preview).toBeNull();
    expect(s.getState().dirty).toBe(true);
    const c = s.getState().fit?.at(37.5)?.xz;
    const truth = modelAt(37.5);
    expect(Math.hypot((c?.[0] ?? 0) - truth[0], (c?.[1] ?? 0) - truth[1])).toBeLessThan(0.5);
  });

  it('without walking times the pins sit at 0 and the walk length', () => {
    const rest = structuredClone(raw);
    delete rest.walking;
    const s = session({ raw: rest });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().click([0, 0]);
    s.getState().click([40, -30]);
    expect(s.getState().pins.map((p) => p.t)).toEqual([0, walk().durationS]);
  });

  it('placed anyway without a path: no ghost, a straight two point preview', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().placeAnyway();
    s.getState().hover([1, 1]);
    expect(s.getState().preview).toBeNull();
    s.getState().click([0, 0]);
    s.getState().hover([20, 0]);
    expect(s.getState().preview?.xz).toEqual([
      [0, 0],
      [20, 0],
    ]);
  });

  it('a walk placed anyway without a path is fitted pins-only and reads check', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface(MAP);
    s.getState().placeAnyway();
    s.getState().click([0, 0]);
    s.getState().click([20, 0]);
    expect(s.getState().fit?.pinsOnly).toBe(true);
    expect(s.getState().calibration().quality).toBe('check');
  });

  it('the hover is ignored while a handle is dragged', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().click(modelAt(4), 0);
    s.getState().hover(modelAt(62), 0);
    s.getState().click(modelAt(62), 0);
    s.getState().dragHandle('end', [45, -30], 0);
    s.getState().hover([1, 1]);
    expect(s.getState().preview).toBeNull();
    expect(s.getState().dragging).toEqual({ handle: 'end', refused: false });
  });
});

describe('on a drawing', () => {
  // A drawing whose image y runs towards model -z (bottom-left below top-left in z): a preview
  // worked out in image px instead of the model frame would come out mirrored.
  const flipped = ProjectManifest.parse({
    ...m,
    layers: [
      {
        kind: 'raster',
        id: 'sheet-f',
        name: 'Flipped',
        capture: 'c1',
        src: { path: 'drawings/f/plan.png' },
        role: 'plan',
        format: 'image',
        corners: { tl: [-60, 2, 60], tr: [60, 2, 60], bl: [-60, 2, -60] },
      },
    ],
  });
  const FLIP: PlaceSurface = { kind: 'drawing', id: 'sheet-f', name: 'Flipped', dated: true };
  /** Model x/z to the flipped drawing's px (0.1 m a px, image y down is model -z). */
  const px = (xz: readonly number[]): [number, number] => [
    ((xz[0] ?? 0) + 60) * 10,
    (60 - (xz[1] ?? 0)) * 10,
  ];

  function onFlipped(provisional = false) {
    const store = createPlaceStore({ fit: fitWalk, seek: vi.fn() });
    const lookup: DrawingLookup = (id) =>
      id === 'sheet-f' ? { provisional, size: { width: 1200, height: 1200 } } : undefined;
    store.getState().start(walk(), flipped, { raw, drawings: lookup });
    store.getState().chooseSurface(FLIP);
    return store;
  }

  it('the preview is laid in the model frame, not mirrored, and drawn back in px', () => {
    const s = onFlipped();
    s.getState().click(px(modelAt(4)));
    expect(s.getState().pins[0]).toEqual({ t: 4, surface: 'sheet-f', at: px(modelAt(4)) });
    s.getState().hover(px(modelAt(62)));
    const p = s.getState().preview;
    if (!p) throw new Error('no preview');
    // the corner of the L lies where the walk turned, in the model
    const corner = modelAt(37.5);
    const near = Math.min(...p.xz.map((q) => Math.hypot(q[0] - corner[0], q[1] - corner[1])));
    expect(near).toBeLessThan(0.5);
    // the same shape on the drawing, in px
    expect(p.at).toHaveLength(p.xz.length);
    p.xz.forEach((q, i) => {
      const want = px(q);
      expect(p.at[i]?.[0]).toBeCloseTo(want[0], 6);
      expect(p.at[i]?.[1]).toBeCloseTo(want[1], 6);
    });
  });

  it('the ghost on a drawing starts under the cursor in px, at the base height', () => {
    const s = onFlipped();
    s.getState().hover([300, 400]);
    const p = s.getState().preview;
    expect(p?.ghost).toBe(true);
    expect(p?.at[0]?.[0]).toBeCloseTo(300, 6);
    expect(p?.at[0]?.[1]).toBeCloseTo(400, 6);
  });

  it('on a provisional drawing the ghost is 30 % of its width long', () => {
    const s = onFlipped(true);
    s.getState().hover([300, 400]);
    const xz = s.getState().preview?.xz ?? [];
    let len = 0;
    for (let i = 1; i < xz.length; i++) {
      const a = xz[i - 1];
      const b = xz[i];
      if (a && b) len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    expect(len).toBeCloseTo(0.3 * 120, 6);
  });

  it('the start and end are pins on the drawing in px', () => {
    const { s } = setup();
    s().chooseSurface(SHEET);
    s().click([100, 200]);
    expect(s().pins[0]).toEqual({ t: 4, surface: 'sheet-a', at: [100, 200] });
    s().click([400, 200]);
    expect(s().step).toBe('placed');
    expect(s().calibration().placedOn).toBe('sheet-a');
  });

  it('refuses a pin on a drawing that is not ready', () => {
    const seek = vi.fn<(t: number) => void>();
    const store = createPlaceStore({ fit: fitWalk, seek });
    const s = () => store.getState();
    s().start(walk(), m, { raw, drawings: () => undefined });
    s().chooseSurface(SHEET);
    s().click([100, 100]);
    expect(s().pins).toEqual([]);
    expect(s().error).toBe(DRAWING_NOT_READY);
    expect(s().step).toBe('start');
  });
});

describe('handles', () => {
  it('dragging End refits live, including a spot in the same area as Start', () => {
    const s = placeTwo();
    const before = s.getState().pins[1]?.at;
    s.getState().dragHandle('end', [45, -30], 0);
    expect(s.getState().pins[1]?.at).toEqual([45, -30]);
    expect(s.getState().pins[1]?.t).toBe(62);
    expect(s.getState().dragging).toEqual({ handle: 'end', refused: false });
    const start = s.getState().pins[0]?.at ?? [0, 0];
    s.getState().dragHandle('end', [start[0] + 1, start[1]], 0);
    expect(s.getState().pins[1]?.at).toEqual([start[0] + 1, start[1]]);
    expect(s.getState().dragging?.refused).toBe(false);
    s.getState().endDrag();
    expect(s.getState().dragging).toBeNull();
    expect(before).not.toEqual([45, -30]);
  });

  it('dragging Start moves the first pin and keeps its time', () => {
    const s = placeTwo();
    s.getState().dragHandle('start', [-5, 3], 1);
    expect(s.getState().pins[0]).toEqual({ t: 4, surface: '@model', at: [-5, 3], y: 1 });
  });

  it('Start moves the pin its handle shows: the first active one', () => {
    const pins = [
      { t: 2, surface: 'gone-sheet', at: [5, 5] },
      { t: 4, surface: '@model', at: [0, 0] },
      { t: 62, surface: '@model', at: [40, -30] },
    ] as WalkPin[];
    const s = session({
      layer: {
        place: { pins, yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
      },
    });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().dragHandle('start', [-5, 3], 1);
    expect(s.getState().pins[0]).toEqual(pins[0]);
    expect(s.getState().pins[1]).toEqual({ t: 4, surface: '@model', at: [-5, 3], y: 1 });
  });

  it('handles do nothing before the walk is placed', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().dragHandle('start', [1, 1]);
    expect(s.getState().pins).toHaveLength(0);
    expect(s.getState().dragging).toBeNull();
  });
});

describe('fine-tune', () => {
  it('turns on and off from placed; Pin here works only while on', () => {
    const s = placeTwo();
    s.getState().pinHere();
    expect(s.getState().armed).toBeNull();
    s.getState().setFineTune(true);
    expect(s.getState().step).toBe('fine-tune');
    s.getState().setTime(30);
    s.getState().pinHere();
    expect(s.getState().armed).toBe('pin');
    s.getState().click(modelAt(30), 0);
    expect(s.getState().pins.map((p) => p.t)).toEqual([4, 30, 62]);
    s.getState().setFineTune(false);
    expect(s.getState().step).toBe('placed');
    expect(s.getState().armed).toBeNull();
  });

  it('a Pin here pin keeps the time it was armed at', () => {
    const { s } = fineTuning();
    s().setTime(30);
    s().pinHere();
    s().setTime(40); // the video plays on
    s().click(truthXZ(30));
    expect(s().armed).toBeNull();
    expect(s().pins.map((p) => p.t)).toEqual([4, 30, lastT]);
    expect(s().fit?.pins.find((p) => p.t === 30)?.residualM).not.toBeNull();
  });

  it('a click in fine-tune with nothing armed drops no pin', () => {
    const { s } = fineTuning();
    s().click([1, 1]);
    expect(s().pins).toHaveLength(2);
  });

  it('switching the surface in fine-tune stays in fine-tune and lets go of a move', () => {
    const { s } = fineTuning();
    s().armMove(1);
    s().chooseSurface(SHEET);
    expect(s().step).toBe('fine-tune');
    expect(s().armed).toBeNull();
    expect(s().moving).toBeNull();
  });
});

describe('the path appears or goes', () => {
  it('a path read while on the check moves on to Start', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().setInputs(raw, null, true);
    expect(s.getState().step).toBe('start');
  });

  it('a path that goes drops the draft and shows the check', () => {
    const s = placeTwo();
    s.getState().setInputs(null, null, false);
    expect(s.getState().step).toBe('check');
    expect(s.getState().pins).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
  });

  it('a walk placed anyway keeps its pins when the job changes (it never had a path)', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().placeAnyway();
    s.getState().click([0, 0], 0);
    s.getState().click([40, -30], 0);
    s.getState().setInputs(null, null, false);
    expect(s.getState().step).toBe('placed');
    expect(s.getState().pins).toHaveLength(2);
    expect(s.getState().dirty).toBe(true);
    // a path that becomes ready later refits with it, the pins stay
    s.getState().setInputs(raw, null, true);
    expect(s.getState().pins).toHaveLength(2);
    expect(s.getState().fit?.pinsOnly).toBe(false);
    // and once on a ready path, the path going drops the draft again
    s.getState().setInputs(null, null, false);
    expect(s.getState().step).toBe('check');
  });

  it('a saved placement survives its path going', () => {
    const pins = [
      { t: 4, surface: '@model', at: [0, 0] },
      { t: 62, surface: '@model', at: [40, -30] },
    ] as WalkPin[];
    const s = session({
      layer: {
        place: { pins, yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
      },
    });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().setInputs(null, null, false);
    expect(s.getState().step).toBe('placed');
    expect(s.getState().pins).toEqual(pins);
    expect(s.getState().fit?.pinsOnly).toBe(true);
  });

  it('a walk placed before (two saved pins) opens on placed, whatever the path', () => {
    const pins = [
      { t: 4, surface: '@model', at: [0, 0] },
      { t: 62, surface: '@model', at: [40, -30] },
    ] as WalkPin[];
    const s = session({
      raw: null,
      ready: false,
      layer: {
        place: { pins, yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
      },
    });
    s.getState().chooseSurface({ kind: '3d' });
    expect(s.getState().step).toBe('placed');
    expect(s.getState().dirty).toBe(false);
  });
});

describe('createPlaceStore', () => {
  it('movePin marks dirty and changes the live fit', () => {
    const pins: WalkPin[] = [
      { t: 4, surface: '@model', at: truthXZ(4) },
      { t: lastT, surface: '@model', at: truthXZ(lastT) },
    ];
    const { s } = setup(
      walk({ place: { pins, yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' } }),
    );
    s().chooseSurface(MAP);
    expect(s().step).toBe('placed');
    expect(s().dirty).toBe(false);
    const before = s().fit?.at(30)?.xz ?? [NaN, NaN];
    const end = truthXZ(lastT);
    s().movePin(1, [end[0] + 10, end[1] - 4]);
    expect(s().dirty).toBe(true);
    expect(s().pins[1]?.at).toEqual([end[0] + 10, end[1] - 4]);
    const after = s().fit?.at(30)?.xz ?? [NaN, NaN];
    expect(dist(before, after)).toBeGreaterThan(1);
  });

  it('armMove: the next click moves that pin only, at the moment it was set', () => {
    const { s, seek } = fineTuning();
    const end = s().pins[1];
    s().armMove(0);
    expect(s().armed).toBe('move');
    expect(s().moving).toBe(0);
    expect(seek).toHaveBeenLastCalledWith(4);
    const to = truthXZ(4);
    s().click([to[0] + 3, to[1] - 2], 0.4);
    expect(s().pins[0]).toEqual({ t: 4, surface: '@model', at: [to[0] + 3, to[1] - 2], y: 0.4 });
    expect(s().pins[1]).toEqual(end);
    expect(s().armed).toBeNull();
    expect(s().moving).toBeNull();
    expect(s().step).toBe('fine-tune');
    expect(s().dirty).toBe(true);
  });

  it('armMove works only in fine-tune', () => {
    const { s } = placedOnMap();
    s().armMove(0);
    expect(s().armed).toBeNull();
  });

  it('armMove again lets go; an incompatible finish on the start preserves the last valid pin', () => {
    const { s } = fineTuning();
    s().armMove(1);
    s().armMove(1);
    expect(s().armed).toBeNull();
    expect(s().moving).toBeNull();
    s().armMove(1);
    const start = truthXZ(4);
    const previous = s().pins[1];
    s().click(start);
    expect(s().error).toMatch(/raw path does not return/);
    expect(s().pins[1]).toEqual(previous);
    expect(s().armed).toBe('move');
    s().click(truthXZ(lastT));
    expect(s().error).toBeNull();
    expect(s().armed).toBeNull();
    // a pin that is not there cannot be armed
    s().armMove(5);
    expect(s().armed).toBeNull();
  });

  it('a pin moved on another surface takes that surface', () => {
    const { s } = setup();
    s().chooseSurface(SHEET);
    s().click([100, 100]);
    s().click([400, 100]);
    s().setFineTune(true);
    s().chooseSurface(MAP);
    s().armMove(0);
    s().click([20, 25], 0.2);
    expect(s().pins[0]).toEqual({ t: 4, surface: '@model', at: [20, 25], y: 0.2 });
  });

  it('the start and end of a two pin placement cannot be removed', () => {
    const { s } = fineTuning();
    const before = s();
    expect(canRemovePin(before, 0)).toBe(false);
    expect(canRemovePin(before, 1)).toBe(false);
    s().removePin(0);
    expect(s()).toBe(before);
    s().removePin(1);
    expect(s()).toBe(before);
    expect(s().pins.map((p) => p.t)).toEqual([4, lastT]);
    expect(s().step).toBe('fine-tune');
  });

  it('an inner fine-tune pin can be removed; with three pins any can', () => {
    const { s } = fineTuning();
    s().setTime(30);
    s().pinHere();
    s().click(truthXZ(30));
    expect(s().pins.map((p) => p.t)).toEqual([4, 30, lastT]);
    expect([0, 1, 2, 3].map((i) => canRemovePin(s(), i))).toEqual([true, true, true, false]);
    s().removePin(1);
    expect(s().pins.map((p) => p.t)).toEqual([4, lastT]);
    expect(s().step).toBe('fine-tune');
    expect(s().dirty).toBe(true);
  });

  it('the start pin alone (End waiting) cannot be removed', () => {
    const { s } = setup();
    s().chooseSurface(MAP);
    s().click(truthXZ(4));
    expect(canRemovePin(s(), 0)).toBe(false);
    s().removePin(0);
    expect(s().pins).toHaveLength(1);
    expect(s().step).toBe('end');
  });

  it('align sets the yaw offset so the landmark bearing matches', () => {
    const { s } = fineTuning();
    s().setTime(30);
    s().armAlign();
    expect(s().armed).toBe('align-360');
    const yawRad = 0.7; // the landmark, turned left of the camera's forward
    s().align360(yawRad);
    expect(s().armed).toBe('align-surface');
    expect(s().align).toEqual({ yawRad, t: 30 });
    const cam = s().fit?.at(30);
    if (!cam) throw new Error('no fit');
    const landmark: [number, number] = [cam.xz[0] + 12, cam.xz[1] + 5];
    s().click(landmark);
    expect(s().armed).toBeNull();
    expect(s().pins).toHaveLength(2); // no pin dropped
    // Ry(heading + offset) turns the camera-frame direction (-sin a, -cos a) onto the landmark
    const th = cam.headingRad + (s().yawOffsetDeg * Math.PI) / 180 + yawRad;
    const dir = [-Math.sin(th), -Math.cos(th)];
    const want = [12 / 13, 5 / 13];
    expect(dir[0]).toBeCloseTo(want[0] ?? NaN, 6);
    expect(dir[1]).toBeCloseTo(want[1] ?? NaN, 6);
    const expected = wrapDeg(((Math.atan2(-12, -5) - cam.headingRad - yawRad) * 180) / Math.PI);
    expect(Math.abs(s().yawOffsetDeg - expected)).toBeLessThan(0.01);
    expect(s().calibration().yawOffsetDeg).toBe(s().yawOffsetDeg);
  });

  it('align works only in fine-tune', () => {
    const { s } = placedOnMap();
    s().armAlign();
    expect(s().armed).toBeNull();
  });

  it('removing a pin mid-align drops the align', () => {
    const { s } = fineTuning();
    s().setTime(30);
    s().pinHere();
    s().click(truthXZ(30));
    s().armAlign();
    s().align360(0.3);
    s().removePin(1);
    expect(s().pins).toHaveLength(2);
    expect(s().armed).toBeNull();
    expect(s().align).toBeNull();
  });

  it('align with orientation rows: the saved pose looks at the landmark', () => {
    if (!rows) throw new Error('orientation fixture refused');
    // The fixture's rows head like the stills; sway them (a turn about up of 0.3 sin(2 pi t)) so
    // the rows' heading differs from the fit's between stills.
    const swayed = rows.map((row) => {
      const h = 0.15 * Math.sin(2 * Math.PI * (row[0] ?? 0));
      const [sy, cw] = [Math.sin(h), Math.cos(h)];
      const [x, y, z, w] = [row[1] ?? 0, row[2] ?? 0, row[3] ?? 0, row[4] ?? 1];
      // Ry(2h) * q, Hamilton product with [0, sy, 0, cw]
      return Float64Array.of(
        row[0] ?? 0,
        cw * x + sy * z,
        cw * y + sy * w,
        cw * z - sy * x,
        cw * w - sy * y,
      );
    });
    const seek = vi.fn<(t: number) => void>();
    const store = createPlaceStore({ fit: fitWalk, seek });
    const s = () => store.getState();
    s().start(walk(), m, { raw, drawings, orientation: swayed });
    s().chooseSurface(MAP);
    s().click(truthXZ(4));
    s().click(truthXZ(lastT));
    s().setFineTune(true);
    s().setTime(30.2);
    s().armAlign();
    const yawRad = -0.4;
    s().align360(yawRad);
    const cam = s().fit?.at(30.2);
    if (!cam) throw new Error('no fit');
    s().click([cam.xz[0] - 7, cam.xz[1] + 9]);
    const cal = s().calibration();
    const fit = fitWalk(raw, cal, { drawing: () => null }, 62);
    const sample: PoseSample | undefined = walkPoseSamples(fit, raw, swayed, cal, 62)[906];
    if (!sample) throw new Error('no sample');
    // the pose's forward (q applied to -Z), turned by the landmark's angle in the camera frame
    const [x, y, z, w] = sample.q;
    const fx = -(2 * (x * z + w * y));
    const fz = -(1 - 2 * (x * x + y * y));
    const th = Math.atan2(-fx, -fz) + yawRad;
    const want = Math.atan2(7, -9); // Ry angle of the direction (-7, +9)
    const diff = Math.atan2(Math.sin(th - want), Math.cos(th - want));
    expect(Math.abs(diff)).toBeLessThan(1e-3);
  });

  it('setYaw wraps to -180..180', () => {
    const { s } = placedOnMap();
    s().setYaw(190);
    expect(s().yawOffsetDeg).toBeCloseTo(-170, 9);
    s().setYaw(-190);
    expect(s().yawOffsetDeg).toBeCloseTo(170, 9);
    s().setYaw(540);
    expect(s().yawOffsetDeg).toBe(180);
    s().setYaw(45);
    expect(s().yawOffsetDeg).toBe(45);
    expect(s().dirty).toBe(true);
  });

  it('setDate gives the session walk the capture; the session opens on Start', () => {
    const { s } = setup(walk({ capture: undefined }));
    s().setDate('c1');
    s().chooseSurface(MAP);
    expect(s().step).toBe('start');
  });

  it('cancel restores nothing and clears the session', () => {
    const w = walk();
    const copy = structuredClone(w);
    const seek = vi.fn<(t: number) => void>();
    const fit = vi.fn(fitWalk);
    const store = createPlaceStore({ fit, seek });
    const s = () => store.getState();
    s().start(w, m, { raw, drawings });
    s().chooseSurface(MAP);
    s().click(truthXZ(4));
    s().hover(truthXZ(lastT));
    const seeks = seek.mock.calls.length;
    const fits = fit.mock.calls.length;
    s().cancel();
    expect(seek.mock.calls.length).toBe(seeks);
    expect(fit.mock.calls.length).toBe(fits);
    expect(w).toEqual(copy);
    expect(s()).toMatchObject({
      layerId: null,
      surface: null,
      pins: [],
      armed: null,
      dirty: false,
      error: null,
      align: null,
      fit: null,
      preview: null,
      dragging: null,
    });
    s().hover([1, 1]);
    expect(s().preview).toBeNull();
  });

  it('pins on the map store model x/z with surface @model and their height', () => {
    const { s } = setup();
    s().chooseSurface(MAP);
    s().click([50, 60], 1.5);
    expect(s().pins[0]).toEqual({ t: 4, surface: '@model', at: [50, 60], y: 1.5 });
    const cal = s().calibration();
    expect(cal.placedOn).toBe('@model');
    expect(cal.heightM).toBe(1.7);
    expect(cal.pins).toEqual(s().pins);
  });
});

it('a 3D pin keeps its height and saves on @model', () => {
  const s = placeTwo();
  expect(s.getState().calibration()).toMatchObject({
    placedOn: '@model',
    pins: [{ y: 0 }, { y: 0 }],
  });
});

describe('back', () => {
  it('on End drops the lone start pin and goes back to Start', () => {
    const k = setup();
    k.s().chooseSurface(MAP);
    k.s().click(truthXZ(4));
    k.s().hover(truthXZ(30));
    expect(k.s().step).toBe('end');
    expect(k.s().preview).not.toBeNull();
    k.store.setState({ error: 'something' });
    k.s().back();
    expect(k.s()).toMatchObject({
      step: 'start',
      pins: [],
      preview: null,
      error: null,
      dirty: false,
    });
    expect(k.seek).toHaveBeenLastCalledWith(raw.walking?.startT ?? 0);
  });

  it('does nothing on any other step', () => {
    const k = setup();
    k.s().chooseSurface(MAP);
    k.s().back();
    expect(k.s().step).toBe('start');
    k.s().click(truthXZ(4));
    k.s().click(truthXZ(lastT));
    const placed = k.s();
    k.s().back();
    expect(k.s()).toBe(placed);
  });
});
