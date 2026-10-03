import type { Plane } from 'three';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION, applySection, sectionPlane } from './section';

const centre = new Vector3(10, 4, -20);

describe('sectionPlane', () => {
  it('is null when the section is off', () => {
    expect(sectionPlane(DEFAULT_SECTION, centre)).toBeNull();
  });

  it('cuts away the half toward the bearing (90 = east) through the centre', () => {
    const p = sectionPlane({ ...DEFAULT_SECTION, enabled: true, bearingDeg: 90 }, centre);
    if (!p) throw new Error('no plane');
    // three.js clips points with negative distance
    expect(p.distanceToPoint(new Vector3(20, 4, -20))).toBeLessThan(0); // east: removed
    expect(p.distanceToPoint(new Vector3(0, 4, -20))).toBeGreaterThan(0); // west: kept
    expect(p.distanceToPoint(centre)).toBeCloseTo(0, 9);
  });

  it('bearing 0 removes the north half and flip keeps it instead', () => {
    const p = sectionPlane({ ...DEFAULT_SECTION, enabled: true, bearingDeg: 0 }, centre);
    expect(p?.distanceToPoint(new Vector3(10, 4, -30))).toBeLessThan(0);
    const f = sectionPlane(
      { ...DEFAULT_SECTION, enabled: true, bearingDeg: 0, flip: true },
      centre,
    );
    expect(f?.distanceToPoint(new Vector3(10, 4, -30))).toBeGreaterThan(0);
  });

  it('moves along its normal by the offset', () => {
    const p = sectionPlane(
      { ...DEFAULT_SECTION, enabled: true, bearingDeg: 90, offset: 5 },
      centre,
    );
    expect(p?.distanceToPoint(new Vector3(15, 0, 0))).toBeCloseTo(0, 9);
  });

  it('horizontal mode removes everything above the cut height', () => {
    const p = sectionPlane(
      { ...DEFAULT_SECTION, enabled: true, mode: 'horizontal', offset: 2 },
      centre,
    );
    expect(p?.distanceToPoint(new Vector3(0, 7, 0))).toBeLessThan(0);
    expect(p?.distanceToPoint(new Vector3(0, 5, 0))).toBeGreaterThan(0);
  });
});

describe('applySection', () => {
  it('mutates the shared plane array in place', () => {
    const planes: Plane[] = [];
    const same = planes;
    applySection(planes, { ...DEFAULT_SECTION, enabled: true }, centre);
    expect(planes).toBe(same);
    expect(planes).toHaveLength(1);
    applySection(planes, DEFAULT_SECTION, centre);
    expect(planes).toHaveLength(0);
  });
});
