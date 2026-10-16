import type { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { alignSources, formatDistance, planAlign, type AlignSource } from './alignTo';

const src = (
  photoId: string,
  pos?: [number, number, number],
  offsetM?: [number, number, number],
): AlignSource => ({
  layerId: 'ph',
  photoId,
  pos,
  correction: offsetM ? { yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM } : undefined,
});
const target = {
  min: [-10, 0, -10] as [number, number, number],
  max: [10, 5, 10] as [number, number, number],
};

describe('planAlign', () => {
  it('moves the block in plan onto the target centre and keeps plausible heights', () => {
    const p = planAlign([src('a', [91000, 40, 2000]), src('b', [91010, 42, 2010])], target, null);
    expect(p.shift).toEqual([-91005, 0, -2005]);
    expect(p.moved).toBe(2);
    expect(p.inPlace).toBe(false);
    expect(p.fixes.ph?.a).toEqual({
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      offsetM: [-91005, 0, -2005],
    });
    expect(p.before.ph?.a).toBeNull();
  });

  it('lifts a block that lies under the ground to eye height, keeping relative heights', () => {
    const p = planAlign([src('a', [0, -50, 0]), src('b', [1, -48, 1])], target, 2);
    expect(p.shift[1]).toBeCloseTo(2 + 1.6 + 50);
    // every photo gets the same shift, so the 2 m between them stays
    expect(p.fixes.ph?.a?.offsetM?.[1]).toBe(p.fixes.ph?.b?.offsetM?.[1]);
  });

  it('lowers a block more than 300 m above the ground, uses the target minimum without a DSM', () => {
    const p = planAlign([src('a', [0, 900, 0])], target, null);
    expect(p.shift[1]).toBeCloseTo(0 + 1.6 - 900);
    expect(planAlign([src('a', [0, 299, 0])], target, null).shift[1]).toBe(0);
  });

  it('a photo or panorama target without a DSM keeps the heights', () => {
    // drone photos at 100 m: their lowest point is no ground to put the source on
    const drone = {
      min: [-10, 100, -10] as [number, number, number],
      max: [10, 120, 10] as [number, number, number],
    };
    const p = planAlign([src('a', [500, 40, 0])], drone, null, { boundsFloor: false });
    expect(p.shift).toEqual([-500, 0, 0]);
    // a DSM height still counts
    const onDsm = planAlign([src('a', [500, 40, 0])], drone, 50, { boundsFloor: false });
    expect(onDsm.shift[1]).toBeCloseTo(50 + 1.6 - 40);
  });

  it('adds the shift to an existing correction and keeps its angles', () => {
    const p = planAlign([src('a', [500, 10, 0], [10, 0, 0])], target, null);
    // corrected at 510 east; the target centre is at 0: the offset goes from 10 to -500
    expect(p.fixes.ph?.a).toEqual({ yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [-500, 0, 0] });
    expect(p.before.ph?.a).toEqual({ yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [10, 0, 0] });
  });

  it('skips photos without a position and counts them', () => {
    const p = planAlign([src('a', [100, 1, 0]), src('b')], target, null);
    expect(p.moved).toBe(1);
    expect(p.skipped).toBe(1);
    expect(p.fixes.ph?.b).toBeUndefined();
  });

  it('writes nothing under 1 m', () => {
    const p = planAlign([src('a', [0.5, 1, 0.5])], target, null);
    expect(p.inPlace).toBe(true);
    expect(p.fixes).toEqual({});
  });

  it('undo restores exactly: before holds every value as it was', () => {
    const p = planAlign([src('a', [123.4567, 5, 9.87654], [0.001, 0, 0])], target, null);
    expect(p.before).toEqual({
      ph: { a: { yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [0.001, 0, 0] } },
    });
  });

  it('formats a distance in metres or kilometres', () => {
    expect(formatDistance(91234)).toBe('91.2 km');
    expect(formatDistance(350.4)).toBe('350 m');
  });
});

describe('alignSources', () => {
  const m = {
    layers: [
      {
        kind: 'photos',
        id: 'ph',
        name: 'P',
        visible: true,
        items: [
          { id: 'a', src: { path: 'a' }, pos: [1, 2, 3] },
          { id: 'b', src: { path: 'b' } },
        ],
      },
      { kind: 'mesh', id: 'm', name: 'M', visible: true, src: { path: 'm' }, transform: [] },
    ],
  } as unknown as ProjectManifest;
  it('takes every photo of the sets, or only the picks', () => {
    expect(alignSources(m, null, { layerIds: ['ph', 'm'] }).map((s) => s.photoId)).toEqual([
      'a',
      'b',
    ]);
    expect(
      alignSources(m, null, { picks: [{ layerId: 'ph', photoId: 'b' }] }).map((s) => s.photoId),
    ).toEqual(['b']);
  });
});
