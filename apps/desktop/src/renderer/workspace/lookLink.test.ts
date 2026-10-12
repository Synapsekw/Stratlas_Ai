import { PANO_FOV } from '@aio/engine';
import { describe, expect, it } from 'vitest';
import { createLookLink, fromShared, toShared } from './lookLink';

const look = (yawDeg: number, pitchDeg = 0, fovDeg = 70) => ({ yawDeg, pitchDeg, fovDeg });

describe('lookLink', () => {
  it('passes yaw, pitch and zoom through with offset 0', () => {
    expect(fromShared(toShared(look(123, -10, 50), 0), 0)).toEqual(look(123, -10, 50));
  });
  it('applies a member offset both ways', () => {
    expect(toShared(look(10), 30).yawDeg).toBe(40);
    expect(fromShared(look(40), 30).yawDeg).toBe(10);
  });
  it('wraps through north', () => {
    expect(toShared(look(359), 2).yawDeg).toBe(1);
    expect(fromShared(look(1), 2).yawDeg).toBe(359);
  });
  it('clamps pitch and zoom on set', () => {
    const s = createLookLink(look(0));
    s.getState().set(look(0, 120, 500));
    expect(s.getState().look.pitchDeg).toBe(89);
    expect(s.getState().look.fovDeg).toBe(PANO_FOV.max);
  });
  it('notifies subscribers once per set', () => {
    const s = createLookLink(look(0));
    let n = 0;
    s.subscribe(() => {
      n++;
    });
    s.getState().set(look(5));
    expect(n).toBe(1);
  });
});
