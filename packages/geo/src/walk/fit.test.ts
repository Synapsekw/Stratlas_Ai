import type { WalkPin, WalkRawPath } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { dist, lastT, loadRaw, noDrawings, pinAtTruth, truthXZ } from '../__fixtures__/walk';
import { fitWalk, type SurfaceFrame, type WalkFit } from './fit';

const raw = loadRaw('synthetic');
const broken = loadRaw('broken');
const end = lastT(raw);
const dur = end;

const at = (fit: WalkFit, t: number) => {
  const a = fit.at(t);
  if (!a) throw new Error(`no fit at ${String(t)}`);
  return a;
};

describe('fitWalk', () => {
  it('maps the raw path onto the truth with two pins', () => {
    const pins = [pinAtTruth(raw, 4), pinAtTruth(raw, end)];
    const fit = fitWalk(raw, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.error).toBeNull();
    expect(fit.pinsOnly).toBe(false);
    for (const t of [0, 10, 25, 37.2, 50, end])
      expect(dist(at(fit, t).xz, truthXZ(raw, t))).toBeLessThan(1e-6);
    expect(at(fit, 10).dashed).toBe(false);
  });

  it('heads along the walk: east on the first leg, north on the second', () => {
    const fit = fitWalk(
      raw,
      { pins: [pinAtTruth(raw, 4), pinAtTruth(raw, end)], yawOffsetDeg: 0 },
      noDrawings,
      dur,
    );
    expect(at(fit, 10).headingRad).toBeCloseTo(-Math.PI / 2, 5);
    expect(at(fit, 50).headingRad).toBeCloseTo(0, 5);
  });

  it('refuses pins under 5 m', () => {
    const fit = fitWalk(
      raw,
      { pins: [pinAtTruth(raw, 4), pinAtTruth(raw, 7)], yawOffsetDeg: 0 },
      noDrawings,
      dur,
    );
    expect(fit.error).toMatch(/at least 5 m/);
    expect(fit.at(10)).toBeNull();
  });

  it('refuses two pins at the same raw position', () => {
    // Both pins while standing still, 10 m apart on the model.
    const pins: WalkPin[] = [
      { t: 1, surface: '@model', at: [0, 0] },
      { t: 3, surface: '@model', at: [10, 0] },
    ];
    const fit = fitWalk(raw, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.error).toMatch(/at least 5 m/);
  });

  it('sorts pins by t', () => {
    const a = fitWalk(
      raw,
      {
        pins: [pinAtTruth(raw, 4), pinAtTruth(raw, 30, [2, 0]), pinAtTruth(raw, end)],
        yawOffsetDeg: 0,
      },
      noDrawings,
      dur,
    );
    const b = fitWalk(
      raw,
      {
        pins: [pinAtTruth(raw, end), pinAtTruth(raw, 30, [2, 0]), pinAtTruth(raw, 4)],
        yawOffsetDeg: 0,
      },
      noDrawings,
      dur,
    );
    expect(b.pins.map((p) => p.t)).toEqual([4, 30, end]);
    expect(b.pins.map((p) => p.index)).toEqual([2, 1, 0]);
    for (const t of [5, 20, 29, 31, 45]) expect(dist(at(a, t).xz, at(b, t).xz)).toBeLessThan(1e-9);
  });

  it('blends without a jump at an inner pin', () => {
    const fit = fitWalk(
      raw,
      {
        pins: [pinAtTruth(raw, 4), pinAtTruth(raw, 30, [0, 2]), pinAtTruth(raw, end)],
        yawOffsetDeg: 0,
      },
      noDrawings,
      dur,
    );
    // Exact at the inner pin.
    expect(dist(at(fit, 30).xz, pinAtTruth(raw, 30, [0, 2]).at)).toBeLessThan(1e-9);
    const step = 1.2 * 0.05;
    let prev = at(fit, 25).xz;
    for (let t = 25.05; t <= 35; t += 0.05) {
      const cur = at(fit, t).xz;
      expect(dist(cur, prev)).toBeLessThan(0.01 + step);
      prev = cur;
    }
  });

  it('records the residual of an added pin', () => {
    const fit = fitWalk(
      raw,
      {
        pins: [pinAtTruth(raw, 4), pinAtTruth(raw, 30, [3, 0]), pinAtTruth(raw, end)],
        yawOffsetDeg: 0,
      },
      noDrawings,
      dur,
    );
    const inner = fit.pins.find((p) => p.t === 30);
    expect(inner?.residualM).toBeCloseTo(3, 2);
    const two = fitWalk(
      raw,
      { pins: [pinAtTruth(raw, 4), pinAtTruth(raw, end)], yawOffsetDeg: 0 },
      noDrawings,
      dur,
    );
    expect(two.pins.every((p) => p.residualM === null)).toBe(true);
  });

  it('fits a broken path segment by segment', () => {
    const pins = [4, 25, 40, 60].map((t) => pinAtTruth(broken, t));
    const fit = fitWalk(broken, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.error).toBeNull();
    expect(fit.gaps).toEqual([]);
    for (const t of [5, 15, 29.5, 38.5, 45, 55, 62]) {
      expect(dist(at(fit, t).xz, truthXZ(broken, t))).toBeLessThan(1e-6);
      expect(at(fit, t).dashed).toBe(false);
    }
    // The unregistered stretch is drawn dashed between the two fits.
    expect(at(fit, 34).dashed).toBe(true);
  });

  it('gives a segment with one pin the neighbouring turn and scale', () => {
    const pins = [4, 25, 50].map((t) => pinAtTruth(broken, t));
    const fit = fitWalk(broken, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.gaps).toEqual([]);
    expect(dist(at(fit, 50).xz, truthXZ(broken, 50))).toBeLessThan(1e-9);
    expect(at(fit, 45).dashed).toBe(false);
  });

  it('reports an unpinned segment as a gap', () => {
    const pins = [4, 25].map((t) => pinAtTruth(broken, t));
    const fit = fitWalk(broken, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.gaps).toEqual([{ fromT: 30, toT: end }]);
    expect(at(fit, 45).dashed).toBe(true);
    expect(at(fit, 20).dashed).toBe(false);
  });

  const pinsOnlyRaw = (r: WalkRawPath, zeroSteps = false): WalkRawPath => ({
    ...r,
    source: 'pins-only',
    stills: r.stills.map((s) => ({ n: s.n, t: s.t, steps: zeroSteps ? 0 : s.steps })),
  });
  const ends: WalkPin[] = [
    { t: 0, surface: '@model', at: [0, 0] },
    { t: end, surface: '@model', at: [40, 0] },
  ];

  it('pins-only by steps when there are no positions', () => {
    const fit = fitWalk(pinsOnlyRaw(raw), { pins: ends, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.pinsOnly).toBe(true);
    // Half the steps are walked at t = 4 + (58 * 1.2 / 2) / 1.2 = 33.
    expect(dist(at(fit, 33).xz, [20, 0])).toBeLessThan(0.01);
    expect(dist(at(fit, 2).xz, [0, 0])).toBeLessThan(1e-9);
    expect(at(fit, 33).headingRad).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('pins-only by time when steps are all zero or raw is null', () => {
    for (const r of [pinsOnlyRaw(raw, true), null]) {
      const fit = fitWalk(r, { pins: ends, yawOffsetDeg: 0 }, noDrawings, dur);
      expect(fit.pinsOnly).toBe(true);
      expect(dist(at(fit, end / 2).xz, [20, 0])).toBeLessThan(1e-9);
    }
  });

  it('moves with the drawing', () => {
    const frame: SurfaceFrame = {
      a: 0.1,
      b: 0,
      c: 0,
      d: 0.1,
      tx: -5,
      tz: 5,
      baseY: 2,
      provisional: false,
    };
    const onSheet = (t: number): WalkPin => {
      const [x, z] = truthXZ(raw, t);
      return { t, surface: 'sheet-a', at: [(x - frame.tx) / 0.1, (z - frame.tz) / 0.1] };
    };
    const pins = [onSheet(4), onSheet(end)];
    const f1 = fitWalk(raw, { pins, yawOffsetDeg: 0 }, { drawing: () => frame }, dur);
    const f2 = fitWalk(
      raw,
      { pins, yawOffsetDeg: 0 },
      { drawing: () => ({ ...frame, tx: frame.tx + 10 }) },
      dur,
    );
    for (const t of [0, 10, 33, 50, end]) {
      const a = at(f1, t);
      const b = at(f2, t);
      expect(dist(a.xz, truthXZ(raw, t))).toBeLessThan(1e-6);
      expect(b.xz[0] - a.xz[0]).toBeCloseTo(10, 9);
      expect(b.xz[1] - a.xz[1]).toBeCloseTo(0, 9);
      expect(a.groundY).toBe(2);
    }
    expect(f1.notToScale).toBe(false);
    const prov = fitWalk(
      raw,
      { pins, yawOffsetDeg: 0 },
      { drawing: () => ({ ...frame, provisional: true }) },
      dur,
    );
    expect(prov.notToScale).toBe(true);
  });

  it('deactivates a pin whose drawing is gone', () => {
    const pins: WalkPin[] = [
      pinAtTruth(raw, 4),
      pinAtTruth(raw, end),
      { t: 30, surface: 'gone', at: [1, 2] },
    ];
    const fit = fitWalk(raw, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(fit.pins.find((p) => p.t === 30)?.active).toBe(false);
    expect(dist(at(fit, 30).xz, truthXZ(raw, 30))).toBeLessThan(1e-6);
  });

  it('interpolates the ground height of the pins by time', () => {
    const pins = [
      { ...pinAtTruth(raw, 4), y: 1 },
      { ...pinAtTruth(raw, end), y: 3 },
    ];
    const fit = fitWalk(raw, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
    expect(at(fit, 0).groundY).toBe(1);
    expect(at(fit, (4 + end) / 2).groundY).toBeCloseTo(2, 9);
    expect(at(fit, end).groundY).toBe(3);
  });

  it('never returns NaN', () => {
    const cases: { r: WalkRawPath | null; pins: WalkPin[] }[] = [
      { r: raw, pins: [pinAtTruth(raw, 10), pinAtTruth(raw, 10)] },
      {
        r: raw,
        pins: [
          { t: 10, surface: '@model', at: [0, 0] },
          { t: 10, surface: '@model', at: [10, 0] },
        ],
      },
      {
        r: null,
        pins: [
          { t: 10, surface: '@model', at: [0, 0] },
          { t: 10, surface: '@model', at: [10, 0] },
        ],
      },
      {
        r: raw,
        pins: [
          pinAtTruth(raw, 4),
          pinAtTruth(raw, 30),
          pinAtTruth(raw, 30, [1, 0]),
          pinAtTruth(raw, end),
        ],
      },
      { r: raw, pins: [pinAtTruth(raw, 4), { t: 500, surface: '@model', at: [60, 0] }] },
      { r: broken, pins: [pinAtTruth(broken, 4), pinAtTruth(broken, 50)] },
    ];
    for (const { r, pins } of cases) {
      const fit = fitWalk(r, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
      for (const p of fit.pins) {
        expect(p.target.every(Number.isFinite)).toBe(true);
        if (p.residualM !== null) expect(Number.isFinite(p.residualM)).toBe(true);
      }
      for (const t of [-5, 0, 10, 30, 34, 61.9, end, 100, 1e9]) {
        const a = fit.at(t);
        if (!a) continue;
        expect([...a.xz, a.groundY, a.headingRad].every(Number.isFinite)).toBe(true);
      }
      expect(fit.at(Number.NaN)).toBeNull();
    }
  });
});
