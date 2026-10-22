import { readFileSync } from 'node:fs';
import { AntennaUnit, type Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  boxWithValues,
  canReset,
  isNotMeasured,
  isPersonOwned,
  parseTyped,
  TYPED_RANGE,
  userValue,
  withoutTyped,
  withTyped,
} from './antennaTyped';

const contract = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { example: { units: unknown[] }; flagged: unknown; notMeasured: unknown };

const panel = AntennaUnit.parse(contract.example.units[0]);
const flagged = AntennaUnit.parse(contract.flagged);
const notMeasured = AntennaUnit.parse(contract.notMeasured);

const D = Math.PI / 180;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// measure.py's conventions, in project ENZ (E = x, N = -z, Z = y of its local frame)
const azimuthOf = (n: Vec3) => (((Math.atan2(n[0], n[1]) / D) % 360) + 360) % 360;
const downtiltOf = (n: Vec3) => -Math.asin(n[2]) / D;
function plumbOf(long: Vec3, n: Vec3): number {
  const z = n[2];
  let up: Vec3 = [-z * n[0], -z * n[1], 1 - z * n[2]];
  const l = Math.hypot(...up);
  up = [up[0] / l, up[1] / l, up[2] / l];
  const right = cross(up, n);
  const a: Vec3 = dot(long, up) < 0 ? [-long[0], -long[1], -long[2]] : long;
  return Math.atan2(dot(a, right), dot(a, up)) / D;
}

function expectVec(a: Vec3, b: Vec3, tol = 1e-3) {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] ?? 0) - (b[i] ?? 0))).toBeLessThan(tol);
}

describe('parseTyped', () => {
  it('reads numbers in range and refuses the rest', () => {
    expect(parseTyped('azimuthGridDeg', '271')).toBe(271);
    expect(parseTyped('azimuthGridDeg', ' 360 ')).toBe(0);
    expect(parseTyped('azimuthGridDeg', '361')).toBeNull();
    expect(parseTyped('downtiltDeg', '-3.5')).toBe(-3.5);
    expect(parseTyped('downtiltDeg', '95')).toBeNull();
    expect(parseTyped('widthM', '0')).toBeNull();
    expect(parseTyped('widthM', '0.3')).toBe(0.3);
    expect(parseTyped('azimuthGridDeg', 'abc')).toBeNull();
    expect(parseTyped('azimuthGridDeg', '')).toBeNull();
    expect(parseTyped('centreHeightM', '31,5')).toBeNull();
    expect(parseTyped('centreHeightM', '31.5')).toBe(31.5);
  });

  it('has the agreed ranges', () => {
    expect(TYPED_RANGE).toEqual({
      azimuthGridDeg: [0, 360],
      downtiltDeg: [-90, 90],
      centreHeightM: [-1000, 10000],
      widthM: [0.01, 10],
      heightM: [0.01, 10],
      depthM: [0.01, 10],
    });
  });
});

describe('userValue', () => {
  it('is a user value', () => {
    expect(userValue(3)).toEqual({ value: 3, basis: 'user', quality: { basis: 'user' } });
  });
});

describe('boxWithValues', () => {
  it("reproduces a measured panel's axes", () => {
    const box = boxWithValues(panel);
    const [across, up, out] = box.axes;
    expect(azimuthOf(out)).toBeCloseTo(120, 3);
    expect(downtiltOf(out)).toBeCloseTo(4, 3);
    expect(plumbOf(up, out)).toBeCloseTo(0.5, 3);
    // across is right seen from the front: up x outward
    expectVec(across, cross(up, out));
    // fed its own values again, the axes stay
    const again = boxWithValues({ ...panel, box });
    for (const i of [0, 1, 2] as const) expectVec(again.axes[i], box.axes[i]);
    expect(box.extents).toEqual([0.3, 1.3, 0.15]);
    expect(box.centre).toEqual(panel.box.centre);
    expect(AntennaUnit.safeParse({ ...panel, box }).success).toBe(true);
  });

  it('typed azimuth 90 turns the outward axis east', () => {
    const u = withTyped(withTyped(panel, 'downtiltDeg', 0), 'azimuthGridDeg', 90);
    expectVec(u.box.axes[2], [1, 0, 0]);
  });

  it('falls back to the current outward axis and no plumb', () => {
    const bare = { ...panel };
    delete bare.azimuthGridDeg;
    delete bare.downtiltDeg;
    delete bare.plumbDeg;
    const box = boxWithValues(bare);
    // current outward is north (0, 1, 0): azimuth 0, tilt 0
    expectVec(box.axes[2], [0, 1, 0]);
    expectVec(box.axes[1], [0, 0, 1]);
    expectVec(box.axes[0], [-1, 0, 0]);
  });

  it('typed sizes set the extents', () => {
    let u = withTyped(panel, 'widthM', 0.5);
    u = withTyped(u, 'heightM', 2);
    expect(u.box.extents).toEqual([0.5, 2, 0.15]);
    u = withTyped(u, 'depthM', 0.25);
    expect(u.box.extents).toEqual([0.5, 2, 0.25]);
  });

  it('typed centre elevation moves the centre Z only', () => {
    const u = withTyped(panel, 'centreHeightM', 40);
    expect(u.box.centre).toEqual([10, 20, 40]);
  });
});

describe('withTyped', () => {
  it('keeps the measured value it replaces', () => {
    const u = withTyped(panel, 'azimuthGridDeg', 200);
    expect(u.azimuthGridDeg).toEqual(userValue(200));
    expect(u.measured?.azimuthGridDeg).toEqual(panel.azimuthGridDeg);
    expect(azimuthOf(u.box.axes[2])).toBeCloseTo(200, 3);
    expect(AntennaUnit.safeParse(u).success).toBe(true);
  });

  it('over a typed value keeps the first measured value', () => {
    const u = withTyped(withTyped(panel, 'azimuthGridDeg', 200), 'azimuthGridDeg', 210);
    expect(u.azimuthGridDeg?.value).toBe(210);
    expect(u.measured?.azimuthGridDeg).toEqual(panel.azimuthGridDeg);
    const f = withTyped(flagged, 'azimuthGridDeg', 150);
    expect(f.measured?.azimuthGridDeg?.value).toBe(120);
  });

  it('keeps the measured centre elevation of a measured unit', () => {
    const u = withTyped(panel, 'centreHeightM', 40);
    expect(u.measured?.centreHeightM?.value).toBe(31.5);
    expect(u.measured?.centreHeightM?.basis).not.toBe('user');
    expect(AntennaUnit.safeParse(u).success).toBe(true);
    const n = withTyped(notMeasured, 'centreHeightM', 33);
    expect(n.measured?.centreHeightM).toBeUndefined();
    expect(n.box.centre[2]).toBe(33);
    // a size typed on a not-measured unit does not make its centre a measured one
    const s = withTyped(withTyped(notMeasured, 'widthM', 0.3), 'centreHeightM', 33);
    expect(s.measured?.centreHeightM).toBeUndefined();
  });

  it('does not change the unit it is given', () => {
    const before = structuredClone(panel);
    withTyped(panel, 'widthM', 0.9);
    expect(panel).toEqual(before);
  });
});

describe('withoutTyped', () => {
  it('restores the measured value and its box', () => {
    const typed = withTyped(panel, 'azimuthGridDeg', 200);
    const back = withoutTyped(typed, 'azimuthGridDeg');
    expect(back.azimuthGridDeg).toEqual(panel.azimuthGridDeg);
    expect(back.measured).toBeUndefined();
    const box = boxWithValues(panel);
    for (const i of [0, 1, 2] as const) expectVec(back.box.axes[i], box.axes[i]);

    const sized = withoutTyped(withTyped(panel, 'widthM', 0.5), 'widthM');
    expect(sized.box.extents).toEqual([0.3, 1.3, 0.15]);

    const h = withoutTyped(withTyped(panel, 'centreHeightM', 40), 'centreHeightM');
    expect(h.centreHeightM?.value).toBe(31.5);
    expect(h.box.centre[2]).toBe(31.5);
  });

  it('keeps the other measured values', () => {
    const u = withTyped(withTyped(panel, 'azimuthGridDeg', 200), 'widthM', 0.5);
    const back = withoutTyped(u, 'widthM');
    expect(back.measured).toEqual({ azimuthGridDeg: panel.azimuthGridDeg });
  });

  it('leaves the unit alone when there is nothing to go back to', () => {
    expect(withoutTyped(panel, 'azimuthGridDeg')).toBe(panel);
    const n = withTyped(notMeasured, 'widthM', 0.3);
    expect(withoutTyped(n, 'widthM')).toBe(n);
  });
});

describe('canReset', () => {
  it('is false for a not-measured unit and for a value nothing measured', () => {
    expect(canReset(withTyped(notMeasured, 'widthM', 0.3), 'widthM')).toBe(false);
    expect(canReset(withTyped(notMeasured, 'centreHeightM', 33), 'centreHeightM')).toBe(false);
    expect(canReset(panel, 'azimuthGridDeg')).toBe(false);
    expect(canReset(flagged, 'centreHeightM')).toBe(false);
    expect(canReset(flagged, 'azimuthGridDeg')).toBe(true);
    expect(canReset(withTyped(panel, 'downtiltDeg', 6), 'downtiltDeg')).toBe(true);
  });
});

describe('ownership', () => {
  it('knows person-owned and not-measured units', () => {
    expect(isPersonOwned(panel)).toBe(false);
    expect(isPersonOwned(flagged)).toBe(true);
    expect(isPersonOwned(withTyped(panel, 'widthM', 0.4))).toBe(true);
    expect(isPersonOwned({ ...panel, plumbDeg: userValue(1) })).toBe(true);
    expect(isNotMeasured(notMeasured)).toBe(true);
    expect(isNotMeasured(flagged)).toBe(false);
    expect(isNotMeasured(panel)).toBe(false);
  });
});
