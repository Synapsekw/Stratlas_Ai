import type { PhotoCorrection, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { correctPos } from './photo';
import {
  isPositionEdited,
  localFromSite,
  offsetForPosition,
  parseMetres,
  shiftToOffset,
  siteXYZ,
  withPositionOffset,
} from './positionEdit';

const origin: Vec3 = [245_000, 3_179_000, 12];

describe('siteXYZ and localFromSite', () => {
  it('show X east, Y north and Z as project height', () => {
    // 10 m east, 20 m north (z south = -20), 5 m above the origin height.
    expect(siteXYZ([10, 5, -20], origin)).toEqual({ x: 10, y: 20, z: 17 });
  });

  it('round-trip', () => {
    const pos: Vec3 = [-31.25, 48.5, 102.75];
    expect(localFromSite(siteXYZ(pos, origin), origin)).toEqual(pos);
    const xyz = { x: 3.5, y: -7.25, z: -40 };
    expect(siteXYZ(localFromSite(xyz, origin), origin)).toEqual(xyz);
  });

  it('give +0, not -0', () => {
    expect(Object.is(siteXYZ([0, 0, 0], origin).y, 0)).toBe(true);
    expect(Object.is(localFromSite({ x: 0, y: 0, z: 12 }, origin)[2], 0)).toBe(true);
  });
});

describe('shiftToOffset', () => {
  it('maps a site shift to the local frame', () => {
    expect(shiftToOffset({ x: 1, y: 2, z: -100 })).toEqual([1, -100, -2]);
    expect(Object.is(shiftToOffset({ x: 0, y: 0, z: 0 })[2], 0)).toBe(true);
  });
});

describe('offsetForPosition', () => {
  it('is the typed position minus the imported one, so the photo lands where typed', () => {
    const imported: Vec3 = [10, 5, -20];
    const xyz = { x: 12, y: 18, z: -50 };
    const off = offsetForPosition(imported, origin, xyz);
    expect(off).toEqual([2, -67, 2]);
    expect(
      siteXYZ(correctPos(imported, { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: off }), origin),
    ).toEqual(xyz);
  });

  it('rounds to 0.1 mm', () => {
    const off = offsetForPosition([0, 0, 0], origin, { x: 1.234567, y: 0, z: 12.00004 });
    expect(off).toEqual([1.2346, 0, 0]);
    expect(Object.is(off[1], 0)).toBe(true);
  });
});

describe('withPositionOffset', () => {
  const turned: PhotoCorrection = { yawDeg: 5, pitchDeg: -2, rollDeg: 0, offsetM: [1, 2, 3] };

  it('sets the offset and keeps rotations', () => {
    expect(withPositionOffset(turned, [0, -100, 0])).toEqual({
      yawDeg: 5,
      pitchDeg: -2,
      rollDeg: 0,
      offsetM: [0, -100, 0],
    });
  });

  it('adds a correction with zero rotations when there was none', () => {
    expect(withPositionOffset(undefined, [0, 1, 0])).toEqual({
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      offsetM: [0, 1, 0],
    });
  });

  it('removes the offset (null or under 0.5 mm) and keeps a turned photo', () => {
    expect(withPositionOffset(turned, null)).toEqual({ yawDeg: 5, pitchDeg: -2, rollDeg: 0 });
    expect(withPositionOffset(turned, [4e-4, 0, -4e-4])).toEqual({
      yawDeg: 5,
      pitchDeg: -2,
      rollDeg: 0,
    });
  });

  it('returns null when nothing is left', () => {
    const moved: PhotoCorrection = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 1, 1] };
    expect(withPositionOffset(moved, null)).toBeNull();
    expect(withPositionOffset(moved, [0, 1e-4, 0])).toBeNull();
    expect(withPositionOffset(undefined, null)).toBeNull();
  });

  it('keeps an offset of exactly 0.5 mm', () => {
    expect(withPositionOffset(undefined, [5e-4, 0, 0])?.offsetM).toEqual([5e-4, 0, 0]);
  });
});

describe('isPositionEdited', () => {
  it('is true for an offset of 0.5 mm or more in any component', () => {
    expect(isPositionEdited({ yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, 0, -5e-4] })).toBe(
      true,
    );
    expect(isPositionEdited({ yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, 4e-4, 0] })).toBe(
      false,
    );
  });

  it('is false for a rotation-only correction or none', () => {
    expect(isPositionEdited({ yawDeg: 10, pitchDeg: 0, rollDeg: 0 })).toBe(false);
    expect(isPositionEdited(undefined)).toBe(false);
    expect(isPositionEdited(null)).toBe(false);
  });
});

describe('parseMetres', () => {
  it('reads signs and dot or comma decimals', () => {
    expect(parseMetres('12.5', 'x')).toBe(12.5);
    expect(parseMetres('-12,5', 'y')).toBe(-12.5);
    expect(parseMetres('+3', 'z')).toBe(3);
    expect(parseMetres('  -100 ', 'shift')).toBe(-100);
    expect(parseMetres('.5', 'x')).toBe(0.5);
    expect(parseMetres('7.', 'x')).toBe(7);
  });

  it('gives null for empty or not a number', () => {
    for (const t of [
      '',
      '  ',
      '-',
      '+',
      'abc',
      '1.2.3',
      '1,000.5',
      '1e3',
      'NaN',
      'Infinity',
      '--1',
    ]) {
      expect(parseMetres(t, 'x')).toBeNull();
    }
  });

  it('keeps X and Y within 100 km of the origin', () => {
    expect(parseMetres('100000', 'x')).toBe(100_000);
    expect(parseMetres('-100000', 'y')).toBe(-100_000);
    expect(parseMetres('100000.1', 'x')).toBeNull();
    expect(parseMetres('-100001', 'y')).toBeNull();
  });

  it('keeps Z within -1000 to 10000 m', () => {
    expect(parseMetres('-1000', 'z')).toBe(-1000);
    expect(parseMetres('10000', 'z')).toBe(10_000);
    expect(parseMetres('-1000.5', 'z')).toBeNull();
    expect(parseMetres('10001', 'z')).toBeNull();
  });

  it('keeps a shift within 10000 m either way', () => {
    expect(parseMetres('-10000', 'shift')).toBe(-10_000);
    expect(parseMetres('10000', 'shift')).toBe(10_000);
    expect(parseMetres('10000.01', 'shift')).toBeNull();
    expect(parseMetres('-20000', 'shift')).toBeNull();
  });
});
