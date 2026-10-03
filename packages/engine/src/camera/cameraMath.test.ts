import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  easeInOutCubic,
  fitDistance,
  frameBox,
  headingDeg,
  poseForPreset,
  type CameraPose,
} from './cameraMath';

const VFOV = 40;

describe('fitDistance', () => {
  it('fits a sphere in the vertical field of view on a wide viewport', () => {
    const d = fitDistance(10, VFOV, 16 / 9, 1);
    // sphere of radius 10 subtends exactly the vertical fov at distance r / sin(fov / 2)
    expect(d).toBeCloseTo(10 / Math.sin((VFOV * Math.PI) / 360), 6);
  });

  it('uses the horizontal field of view on a tall viewport', () => {
    const wide = fitDistance(10, VFOV, 2, 1);
    const tall = fitDistance(10, VFOV, 0.5, 1);
    expect(tall).toBeGreaterThan(wide);
    const hfov = 2 * Math.atan(Math.tan((VFOV * Math.PI) / 360) * 0.5);
    expect(tall).toBeCloseTo(10 / Math.sin(hfov / 2), 6);
  });

  it('applies the margin and never returns zero', () => {
    expect(fitDistance(10, VFOV, 1, 1.2)).toBeCloseTo(fitDistance(10, VFOV, 1, 1) * 1.2, 6);
    expect(fitDistance(0, VFOV, 1)).toBeGreaterThan(0);
  });
});

const sphere = { center: new Vector3(100, 5, -50), radius: 20 };
const dir = (p: CameraPose) => p.position.clone().sub(p.target).normalize();

describe('poseForPreset', () => {
  it('looks straight down from the top with north at the top of the screen', () => {
    const p = poseForPreset('top', sphere, VFOV, 1.5);
    expect(p.target.toArray()).toEqual(sphere.center.toArray());
    const d = dir(p);
    expect(d.y).toBeGreaterThan(0.999);
    // camera sits a hair south (+z) of the target, so the view direction points north (-z)
    expect(p.position.z).toBeGreaterThan(p.target.z);
    expect(Math.abs(p.position.x - p.target.x)).toBeLessThan(1e-9);
  });

  it('views the north side from the north, looking south', () => {
    const d = dir(poseForPreset('north', sphere, VFOV, 1.5));
    expect(d.z).toBeLessThan(-0.9); // camera is north (-z) of the target
    expect(d.y).toBeGreaterThan(0);
    expect(Math.abs(d.x)).toBeLessThan(1e-9);
  });

  it('places the iso camera south-east and above at 35 degrees', () => {
    const d = dir(poseForPreset('iso', sphere, VFOV, 1.5));
    expect(d.x).toBeGreaterThan(0);
    expect(d.z).toBeGreaterThan(0);
    expect(Math.asin(d.y) * (180 / Math.PI)).toBeCloseTo(35.264, 2);
  });

  it('keeps the whole sphere in view', () => {
    const p = poseForPreset('iso', sphere, VFOV, 1.5);
    expect(p.position.distanceTo(p.target)).toBeGreaterThanOrEqual(
      fitDistance(sphere.radius, VFOV, 1.5, 1),
    );
  });
});

describe('frameBox', () => {
  it('keeps the current viewing direction and fits the box', () => {
    const box = new Box3(new Vector3(-5, 0, -5), new Vector3(5, 10, 5));
    const current: CameraPose = {
      position: new Vector3(100, 100, 0),
      target: new Vector3(0, 0, 0),
    };
    const p = frameBox(box, current, VFOV, 1);
    if (!p) throw new Error('expected a pose');
    expect(p.target.toArray()).toEqual([0, 5, 0]);
    expect(dir(p).dot(dir(current))).toBeCloseTo(1, 6);
    const radius = Math.sqrt(5 * 5 + 5 * 5 + 5 * 5);
    expect(p.position.distanceTo(p.target)).toBeGreaterThanOrEqual(fitDistance(radius, VFOV, 1, 1));
  });

  it('returns null for an empty box', () => {
    const current: CameraPose = { position: new Vector3(0, 10, 10), target: new Vector3() };
    expect(frameBox(new Box3(), current, VFOV, 1)).toBeNull();
  });
});

describe('headingDeg', () => {
  it('is 0 looking north and 90 looking east', () => {
    expect(headingDeg(new Vector3(0, 10, 10), new Vector3(0, 0, 0))).toBeCloseTo(0, 6);
    expect(headingDeg(new Vector3(-10, 10, 0), new Vector3(0, 0, 0))).toBeCloseTo(90, 6);
    expect(headingDeg(new Vector3(0, 10, -10), new Vector3(0, 0, 0))).toBeCloseTo(180, 6);
  });
});

describe('easeInOutCubic', () => {
  it('starts at 0, ends at 1 and is symmetric', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 9);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});
