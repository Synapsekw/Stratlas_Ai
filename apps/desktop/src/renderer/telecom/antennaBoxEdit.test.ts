import { readFileSync } from 'node:fs';
import { AntennaUnit, type AntennaBox, type Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  BOX_FACES,
  boxCropSelection,
  draggedUnit,
  extentFromRay,
  faceKey,
  MIN_BOX_EXTENT_M,
  resizeBox,
  settleBoxEdit,
  type BoxEdit,
} from './antennaBoxEdit';
import { userValue } from './antennaTyped';

const contract = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { example: { units: unknown[] }; notMeasured: unknown };

const panel = AntennaUnit.parse(contract.example.units[0]);
const notMeasured = AntennaUnit.parse(contract.notMeasured);

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const near = (a: readonly number[], b: readonly number[], d = 1e-9) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => {
    expect(Math.abs(v - (b[i] ?? NaN))).toBeLessThan(d);
  });
};

/** A box turned 30 degrees about Z and tilted 5 degrees, ENZ, unit axes. */
function turnedBox(): AntennaBox {
  const a = (30 * Math.PI) / 180;
  const t = (5 * Math.PI) / 180;
  const n: Vec3 = [Math.cos(t) * Math.sin(a), Math.cos(t) * Math.cos(a), -Math.sin(t)];
  const up: Vec3 = [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)];
  const across: Vec3 = [
    up[1] * n[2] - up[2] * n[1],
    up[2] * n[0] - up[0] * n[2],
    up[0] * n[1] - up[1] * n[0],
  ];
  return { centre: [100, 200, 30], axes: [across, up, n], extents: [0.3, 1.3, 0.15] };
}

/** The centre of face `f` of a box (ENZ). */
const faceCentre = (b: AntennaBox, axis: 0 | 1 | 2, sign: 1 | -1): Vec3 =>
  add(b.centre, b.axes[axis], (sign * b.extents[axis]) / 2);

describe('the six faces', () => {
  it('has one face per axis and side, with distinct keys', () => {
    expect(BOX_FACES).toHaveLength(6);
    expect(new Set(BOX_FACES.map(faceKey)).size).toBe(6);
  });
});

describe('resizeBox', () => {
  it('moves only the dragged face: the opposite face stays where it was', () => {
    const box = turnedBox();
    for (const f of BOX_FACES) {
      const next = resizeBox(box, f, box.extents[f.axis] + 0.4);
      near(faceCentre(next, f.axis, -f.sign as 1 | -1), faceCentre(box, f.axis, -f.sign as 1 | -1));
      near(
        sub(faceCentre(next, f.axis, f.sign), faceCentre(box, f.axis, f.sign)),
        box.axes[f.axis].map((v) => v * f.sign * 0.4),
      );
      // the other sizes and the axes are untouched
      expect(next.axes).toEqual(box.axes);
      for (const k of [0, 1, 2] as const)
        if (k !== f.axis) expect(next.extents[k]).toBe(box.extents[k]);
    }
  });

  it('works in the box frame for axes that are not unit length', () => {
    const box: AntennaBox = {
      centre: [0, 0, 0],
      axes: [
        [2, 0, 0],
        [0, 0, 3],
        [0, 4, 0],
      ],
      extents: [1, 1, 1],
    };
    const next = resizeBox(box, { axis: 1, sign: 1 }, 2);
    near(next.centre, [0, 0, 0.5]);
    expect(next.extents).toEqual([1, 2, 1]);
  });

  it('clamps the size to the minimum, the opposite face still fixed', () => {
    const box = turnedBox();
    const f = { axis: 1, sign: 1 } as const;
    const next = resizeBox(box, f, -3);
    expect(next.extents[1]).toBe(MIN_BOX_EXTENT_M);
    near(faceCentre(next, 1, -1), faceCentre(box, 1, -1));
  });
});

describe('extentFromRay', () => {
  it('is the distance from the fixed face to the point on the normal line nearest the ray', () => {
    // normal line along +y from the origin; a ray along -z through (0, 2, 5)
    const t = extentFromRay([0, 0, 0], [0, 1, 0], [0, 2, 5], [0, 0, -1]);
    expect(t).toBeCloseTo(2, 9);
    const skew = extentFromRay([0, 0, 0], [0, 1, 0], [1, 0.7, 5], [0, 0, -1]);
    expect(skew).toBeCloseTo(0.7, 9);
  });

  it('is null when the ray runs along the normal', () => {
    expect(extentFromRay([0, 0, 0], [0, 1, 0], [0, 5, 0], [0, -1, 0])).toBeNull();
  });
});

describe('boxCropSelection', () => {
  /** Whether `p` passes the flag job's test (python `select_points` and the bounds read). */
  function selects(sel: ReturnType<typeof boxCropSelection>, p: Vec3): boolean {
    const { min, max } = sel.bounds;
    for (const k of [0, 1, 2] as const) if (p[k] < min[k] || p[k] > max[k]) return false;
    const m = sel.viewProj;
    const clip = [0, 1, 2, 3].map(
      (r) =>
        (m[r] ?? 0) * p[0] + (m[4 + r] ?? 0) * p[1] + (m[8 + r] ?? 0) * p[2] + (m[12 + r] ?? 0),
    );
    const w = clip[3] ?? 0;
    if (w <= 0) return false;
    const x = (clip[0] ?? 0) / w;
    const y = (clip[1] ?? 0) / w;
    // the polygon is the square [-1, 1]^2
    expect(sel.polygon).toHaveLength(4);
    return Math.abs(x) <= 1 && Math.abs(y) <= 1;
  }

  // local frame: a panel turned 30 degrees about the vertical, tilted 4 degrees
  const a = (30 * Math.PI) / 180;
  const t = (4 * Math.PI) / 180;
  const out: Vec3 = [Math.sin(a) * Math.cos(t), -Math.sin(t), -Math.cos(a) * Math.cos(t)];
  const up: Vec3 = [Math.sin(a) * Math.sin(t), Math.cos(t), -Math.cos(a) * Math.sin(t)];
  const across: Vec3 = [
    up[1] * out[2] - up[2] * out[1],
    up[2] * out[0] - up[0] * out[2],
    up[0] * out[1] - up[1] * out[0],
  ];
  const centre: Vec3 = [5, 40, -3];
  const ext: Vec3 = [0.3, 2.6, 0.15];
  const axes: [Vec3, Vec3, Vec3] = [across, up, out];
  const sel = boxCropSelection(centre, axes, ext);
  const at = (s: Vec3): Vec3 =>
    add(
      add(add(centre, across, (s[0] * ext[0]) / 2), up, (s[1] * ext[1]) / 2),
      out,
      (s[2] * ext[2]) / 2,
    );

  it('keeps every point inside the box and on its faces', () => {
    for (const s of [
      [0, 0, 0],
      [0.99, 0.99, 0.99],
      [-1, 1, -1],
      [1, -1, 1],
      [0, 1, 0],
    ] as Vec3[])
      expect(selects(sel, at(s))).toBe(true);
  });

  it('drops points beside the box, in front of it and behind it', () => {
    for (const s of [
      [1.5, 0, 0],
      [-1.5, 0, 0],
      [0, 0, 1.8],
      [0, 0, -1.8],
    ] as Vec3[])
      expect(selects(sel, at(s))).toBe(false);
  });

  it('drops points past the top and the bottom, within a few centimetres', () => {
    expect(selects(sel, add(at([0, 1, 0]), up, 0.1))).toBe(false);
    expect(selects(sel, add(at([0, -1, 0]), up, -0.1))).toBe(false);
  });

  it('anchors on the box centre and fits the job input', () => {
    expect(sel.anchor).toEqual(centre);
    expect(sel.viewProj).toHaveLength(16);
    for (const [x, y] of sel.polygon) expect(Math.abs(x) <= 100 && Math.abs(y) <= 100).toBe(true);
    for (const k of [0, 1, 2] as const) expect(sel.bounds.min[k]).toBeLessThan(sel.bounds.max[k]);
  });
});

describe('draggedUnit', () => {
  it('puts the dragged box in and shows the dragged size on its value, basis kept', () => {
    const box = resizeBox(panel.box, { axis: 1, sign: 1 }, 2.4);
    const u = draggedUnit(panel, { axis: 1, sign: 1 }, box);
    expect(u.box).toBe(box);
    expect(u.heightM?.value).toBe(2.4);
    expect(u.heightM?.basis).toBe('measured');
    expect(u.widthM).toBe(panel.widthM);
  });
});

describe('settleBoxEdit', () => {
  const face = { axis: 1, sign: 1 } as const;
  const dragged = resizeBox(panel.box, face, 2.6);
  const edit: BoxEdit = { face, before: panel, box: dragged };
  const fixedFace = faceCentre(panel.box, 1, -1);

  /** The unit the job writes back: flagged, measured again with `height` and a nudged axis. */
  function remeasured(height: number): AntennaUnit {
    const tilt = 0.02;
    const upAxis: Vec3 = [0, Math.sin(tilt), Math.cos(tilt)];
    const outAxis: Vec3 = [0, Math.cos(tilt), -Math.sin(tilt)];
    const centre = add(fixedFace, upAxis, height / 2);
    return {
      ...panel,
      origin: 'flagged',
      box: { centre, axes: [[1, 0, 0], upAxis, outAxis], extents: [0.31, height, 0.16] },
      widthM: { ...panel.widthM, value: 0.31, basis: 'measured' } as AntennaUnit['widthM'],
      heightM: { ...panel.heightM, value: height, basis: 'measured' } as AntennaUnit['heightM'],
    };
  }

  it('keeps the measurement when the points give the dragged size or more', () => {
    expect(settleBoxEdit(remeasured(2.6), edit)).toBeNull();
    expect(settleBoxEdit(remeasured(2.59), edit)).toBeNull();
  });

  it('keeps the dragged size as typed when the points give it back smaller', () => {
    const after = remeasured(1.9);
    const u = settleBoxEdit(after, edit);
    if (!u) throw new Error('expected a settled unit');
    expect(u.heightM).toEqual(userValue(2.6));
    // Reset to measured brings back what the points gave
    expect(u.measured?.heightM?.value).toBe(1.9);
    expect(u.box.extents[1]).toBe(2.6);
    // the fixed face stays where it was along the new up axis
    const up = u.box.axes[1];
    const bottom = add(u.box.centre, up, -1.3);
    expect(dot(sub(bottom, fixedFace), up)).toBeCloseTo(0, 6);
    // the other sizes are the new measurement
    expect(u.widthM?.value).toBe(0.31);
  });

  it('keeps the dragged size when the person had typed that size before', () => {
    const typed: AntennaUnit = {
      ...panel,
      heightM: userValue(1.0),
      ...(panel.heightM ? { measured: { heightM: panel.heightM } } : {}),
    };
    const after: AntennaUnit = {
      ...remeasured(2.7),
      heightM: userValue(1.0),
      measured: { heightM: { value: 2.7, basis: 'measured', quality: { basis: 'measured' } } },
    };
    const u = settleBoxEdit(after, { face, before: typed, box: resizeBox(typed.box, face, 2.6) });
    expect(u?.heightM).toEqual(userValue(2.6));
    expect(u?.measured?.heightM?.value).toBe(2.7);
  });

  it('with too few points keeps the dragged box and the earlier angles and values', () => {
    // the job's placeholder: no values, a 0.2 m cube
    const after: AntennaUnit = {
      ...panel,
      origin: 'flagged',
      box: {
        centre: [10, 20, 31.5],
        axes: [
          [1, 0, 0],
          [0, 0, 1],
          [0, 1, 0],
        ],
        extents: [0.2, 0.2, 0.2],
      },
      support: 3,
    };
    delete after.azimuthGridDeg;
    delete after.downtiltDeg;
    delete after.plumbDeg;
    delete after.widthM;
    delete after.heightM;
    delete after.depthM;
    const u = settleBoxEdit(after, edit);
    if (!u) throw new Error('expected a settled unit');
    expect(u.box).toEqual(dragged);
    expect(u.azimuthGridDeg).toEqual(panel.azimuthGridDeg);
    expect(u.downtiltDeg).toEqual(panel.downtiltDeg);
    expect(u.widthM).toEqual(panel.widthM);
    expect(u.support).toBe(panel.support);
    expect(u.heightM).toEqual(userValue(2.6));
    expect(u.measured?.heightM).toEqual(panel.heightM);
    expect(u.origin).toBe('flagged');
    expect(AntennaUnit.safeParse(u).success).toBe(true);
  });

  it('a unit never measured keeps no numbers, only its dragged box', () => {
    const box = resizeBox(notMeasured.box, face, 1.5);
    const u = settleBoxEdit(notMeasured, { face, before: notMeasured, box });
    expect(u?.box).toEqual(box);
    expect(u?.heightM).toBeUndefined();
    expect(u?.widthM).toBeUndefined();
  });

  it('a typed centre height follows the box it settled on', () => {
    const typed: AntennaUnit = { ...panel, centreHeightM: userValue(31.5) };
    const after: AntennaUnit = { ...remeasured(1.9), centreHeightM: userValue(31.5) };
    const u = settleBoxEdit(after, { face, before: typed, box: resizeBox(typed.box, face, 2.6) });
    expect(u?.centreHeightM?.basis).toBe('user');
    expect(u?.centreHeightM?.value).toBeCloseTo(u?.box.centre[2] ?? NaN, 9);
  });
});
