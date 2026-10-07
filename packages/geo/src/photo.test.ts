import type { PhotoRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { cameraQuatFromGimbal } from './camera';
import { directionFromQuat } from './direction';
import {
  correctedPhoto,
  correctionTo,
  correctQuat,
  isNoCorrection,
  sameFlightPhotos,
} from './photo';

const gap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

const photo = (id: string, extra: Partial<PhotoRef> = {}): PhotoRef => ({
  id,
  src: { path: `photos/${id}.jpg` },
  pos: [10, 40, -5],
  q: cameraQuatFromGimbal(90, -45, 0),
  ...extra,
});

describe('photo corrections', () => {
  it('turn heading, pitch and roll in the grid frame and move the camera', () => {
    const p = correctedPhoto(
      photo('a', { correction: { yawDeg: -12, pitchDeg: 5, rollDeg: 2, offsetM: [1, -2, 3] } }),
    );
    const d = directionFromQuat(p.q ?? [0, 0, 0, 1]);
    expect(gap(d.yaw, 78)).toBeLessThan(1e-6);
    expect(d.pitch).toBeCloseTo(-40, 6);
    expect(gap(d.roll, 2)).toBeLessThan(1e-6);
    expect(p.pos).toEqual([11, 38, -2]);
  });

  it('leave a photo without a correction as it is', () => {
    const p = photo('a');
    expect(correctedPhoto(p)).toBe(p);
    const zero = { ...p, correction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 } };
    expect(correctedPhoto(zero)).toBe(zero);
    expect(isNoCorrection(undefined)).toBe(true);
  });

  it('turn a straight-down photo about the vertical', () => {
    const q = cameraQuatFromGimbal(30, -90, 0);
    const d = directionFromQuat(correctQuat(q, { yawDeg: 20, pitchDeg: 0, rollDeg: 0 }));
    expect(d.pitch).toBeCloseTo(-90, 4);
    // tilted up a little, the view heads 50 degrees from north
    const up = directionFromQuat(correctQuat(q, { yawDeg: 20, pitchDeg: 10, rollDeg: 0 }));
    expect(gap(up.yaw, 50)).toBeLessThan(1e-4);
  });

  it('are found from the direction wanted, the short way round', () => {
    const q = cameraQuatFromGimbal(170, -30, 0);
    const c = correctionTo(q, { yaw: 190 - 360, pitch: -20, roll: 0 });
    expect(c.yawDeg).toBeCloseTo(20, 6);
    expect(c.pitchDeg).toBeCloseTo(10, 6);
    expect(c.rollDeg).toBeCloseTo(0, 6);
    const back = directionFromQuat(correctQuat(q, c));
    expect(gap(back.yaw, 190)).toBeLessThan(1e-3);
    expect(correctionTo(q, { yaw: 170, pitch: -30, roll: 0 }, [0, 0.0001, 0])).not.toHaveProperty(
      'offsetM',
    );
  });

  it('group the photos of one flight by the gaps in their times', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 0, 5, 7, min)).toISOString();
    const items = [
      photo('a', { takenAt: at(0) }),
      photo('b', { takenAt: at(5) }),
      photo('c', { takenAt: at(12) }),
      photo('d', { takenAt: at(60) }),
      photo('e'),
    ];
    const ids = (i: number) => {
      const p = items[i];
      return p ? sameFlightPhotos(items, p).map((x) => x.id) : [];
    };
    expect(ids(1)).toEqual(['a', 'b', 'c']);
    expect(ids(3)).toEqual(['d']);
    expect(ids(4)).toEqual(['e']);
  });
});
