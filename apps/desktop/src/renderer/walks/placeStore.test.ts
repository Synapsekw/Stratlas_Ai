import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitWalk, PIN_SPAN_ERROR, walkPoseSamples } from '@aio/geo';
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
import { createPlaceStore, DRAWING_NOT_READY, wrapDeg } from './placeStore';

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

/** A session on the map with the start and end pins at their true spots. */
function placedOnMap() {
  const k = setup();
  k.s().chooseSurface(MAP);
  k.s().click(truthXZ(4));
  k.s().click(truthXZ(lastT));
  return k;
}

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

describe('createPlaceStore', () => {
  it('starts at the date step without a capture, then the surface', () => {
    const { s } = setup(walk({ capture: undefined }));
    expect(s().step).toBe('date');
    s().chooseSurface(MAP);
    expect(s().surface).toBeNull();
    s().setDate('c1');
    expect(s().step).toBe('surface');
  });

  it('start then end then correct; seeks to walking.startT and endT', () => {
    const { s, seek } = setup();
    expect(s().layerId).toBe('walk-a');
    expect(s().step).toBe('surface');
    s().chooseSurface(MAP);
    expect(s().step).toBe('start');
    expect(s().armed).toBe('start');
    expect(seek).toHaveBeenLastCalledWith(4);
    s().click(truthXZ(4));
    expect(s().step).toBe('end');
    expect(seek).toHaveBeenLastCalledWith(lastT);
    s().click(truthXZ(lastT));
    expect(s().step).toBe('correct');
    expect(s().armed).toBeNull();
    expect(seek.mock.calls.map((c) => c[0])).toEqual([4, lastT]);
    expect(s().pins.map((p) => p.t)).toEqual([4, lastT]);
    expect(s().dirty).toBe(true);
    expect(s().error).toBeNull();
    const at = s().fit?.at(30);
    expect(at).toBeTruthy();
    expect(dist(at?.xz ?? [NaN, NaN], truthXZ(30))).toBeLessThan(0.05);
    expect(s().calibration().quality).toBe('good');
  });

  it('keeps the start pin when the end is under 5 m and shows the error', () => {
    const { s } = setup();
    s().chooseSurface(SHEET);
    s().click([100, 100]);
    s().click([120, 110]); // about 2.2 m on the sheet
    expect(s().pins).toEqual([{ t: 4, surface: 'sheet-a', at: [100, 100] }]);
    expect(s().error).toBe(PIN_SPAN_ERROR);
    expect(s().step).toBe('end');
    expect(s().armed).toBe('end');
    s().click([400, 100]); // 30 m away
    expect(s().error).toBeNull();
    expect(s().pins).toHaveLength(2);
    expect(s().step).toBe('correct');
  });

  it('pinHere arms a pin at the current time; a click drops it; pins stay sorted by t', () => {
    const { s } = placedOnMap();
    s().setTime(30);
    s().pinHere();
    expect(s().armed).toBe('pin');
    s().setTime(40); // the video plays on: the pin keeps the time it was armed at
    s().click(truthXZ(30));
    expect(s().armed).toBeNull();
    expect(s().pins.map((p) => p.t)).toEqual([4, 30, lastT]);
    expect(s().fit?.pins.find((p) => p.t === 30)?.residualM).not.toBeNull();
  });

  it('pinHere does nothing before the correct step', () => {
    const { s } = setup();
    s().chooseSurface(MAP);
    s().pinHere();
    expect(s().armed).toBe('start');
  });

  it('movePin marks dirty and changes the live fit', () => {
    const pins: WalkPin[] = [
      { t: 4, surface: '@model', at: truthXZ(4) },
      { t: lastT, surface: '@model', at: truthXZ(lastT) },
    ];
    const { s } = setup(
      walk({ place: { pins, yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' } }),
    );
    s().chooseSurface(MAP);
    expect(s().step).toBe('correct');
    expect(s().dirty).toBe(false);
    const before = s().fit?.at(30)?.xz ?? [NaN, NaN];
    const end = truthXZ(lastT);
    s().movePin(1, [end[0] + 10, end[1] - 4]);
    expect(s().dirty).toBe(true);
    expect(s().pins[1]?.at).toEqual([end[0] + 10, end[1] - 4]);
    const after = s().fit?.at(30)?.xz ?? [NaN, NaN];
    expect(dist(before, after)).toBeGreaterThan(1);
  });

  it('removing a pin below two goes back to the end step', () => {
    const { s, seek } = placedOnMap();
    s().removePin(1);
    expect(s().pins.map((p) => p.t)).toEqual([4]);
    expect(s().step).toBe('end');
    expect(s().armed).toBe('end');
    expect(seek).toHaveBeenLastCalledWith(lastT);
    expect(s().calibration().quality).toBe('unplaced');
  });

  it('align sets the yaw offset so the landmark bearing matches', () => {
    const { s } = placedOnMap();
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

  it('start and end pins take the time shown when the spot is clicked', () => {
    const { s } = setup();
    s().chooseSurface(MAP);
    s().setTime(6); // scrubbed after the jump to the start
    s().click(truthXZ(6));
    expect(s().pins[0]?.t).toBe(6);
    s().setTime(58);
    s().click(truthXZ(58));
    expect(s().pins.map((p) => p.t)).toEqual([6, 58]);
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

  it('removing a pin mid-align drops the align', () => {
    const { s } = placedOnMap();
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
    });
  });

  it('pins on a drawing store image px; pins on the map store model x/z with surface @model', () => {
    const { s } = setup();
    s().chooseSurface(SHEET);
    s().click([100, 200]);
    expect(s().pins[0]).toEqual({ t: 4, surface: 'sheet-a', at: [100, 200] });
    s().chooseSurface(MAP);
    s().click([50, 60], 1.5);
    expect(s().pins[1]).toEqual({ t: lastT, surface: '@model', at: [50, 60], y: 1.5 });
    const cal = s().calibration();
    expect(cal.placedOn).toBe('@model');
    expect(cal.heightM).toBe(1.7);
    expect(cal.pins).toEqual(s().pins);
  });

  it('a walk without a path is placed pins-only and reads check', () => {
    const seek = vi.fn<(t: number) => void>();
    const store = createPlaceStore({ fit: fitWalk, seek });
    const s = () => store.getState();
    s().start(walk(), m, { drawings });
    s().chooseSurface(MAP);
    expect(seek).toHaveBeenLastCalledWith(0);
    s().click([0, 0]);
    expect(seek).toHaveBeenLastCalledWith(62);
    s().click([20, 0]);
    expect(s().fit?.pinsOnly).toBe(true);
    expect(s().calibration().quality).toBe('check');
  });
});
