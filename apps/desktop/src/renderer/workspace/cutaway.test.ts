import { DEFAULT_SECTION } from '@aio/engine';
import { Box3, Plane, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bearingDeg, cutawayFor, insideAsset, insideViewPose, sameCut } from './cutaway';

const DEG = Math.PI / 180;

/** The engine's plane for a vertical cut (tools/section.ts): points with distance < 0 are cut. */
function plane(origin: Vector3, bearing: number, offset: number): Plane {
  const toward = new Vector3(Math.sin(bearing * DEG), 0, -Math.cos(bearing * DEG));
  return new Plane().setFromNormalAndCoplanarPoint(
    toward.clone().negate(),
    origin.clone().addScaledVector(toward, offset),
  );
}

describe('cut-away for a drone inside the asset', () => {
  const tank = new Box3(new Vector3(-2, 0, -2), new Vector3(2, 6, 2));

  it('knows when the drone is inside the asset', () => {
    expect(insideAsset(new Vector3(0, 3, 0), tank)).toBe(true);
    expect(insideAsset(new Vector3(0, 3, 2.5), tank)).toBe(false);
    expect(insideAsset(new Vector3(0, 6.5, 0), tank)).toBe(false);
    expect(insideAsset(new Vector3(0, 3, 0), new Box3())).toBe(false);
  });

  it('measures compass bearings clockwise from north (-Z)', () => {
    const o = new Vector3();
    expect(bearingDeg(o, new Vector3(0, 0, -1))).toBeCloseTo(0);
    expect(bearingDeg(o, new Vector3(1, 0, 0))).toBeCloseTo(90);
    expect(bearingDeg(o, new Vector3(0, 0, 1))).toBeCloseTo(180);
    expect(bearingDeg(o, new Vector3(-1, 5, 0))).toBeCloseTo(270);
  });

  it('removes the wall between the camera and the drone and keeps the drone and the far wall', () => {
    const origin = new Vector3(0, 3, 0);
    const drone = new Vector3(0.5, 2, -0.8);
    const camera = new Vector3(20, 10, 15);
    const cut = cutawayFor(drone, camera, origin);
    const p = plane(origin, cut.bearingDeg, cut.offset);
    const towardCamera = camera.clone().sub(drone).setY(0).normalize();
    const nearWall = drone.clone().addScaledVector(towardCamera, 2);
    const farWall = drone.clone().addScaledVector(towardCamera, -1.5);
    expect(p.distanceToPoint(drone)).toBeGreaterThan(0.5);
    expect(p.distanceToPoint(farWall)).toBeGreaterThan(0);
    expect(p.distanceToPoint(nearWall)).toBeLessThan(0);
  });

  it('does not re-apply a cut that barely changed', () => {
    const cut = cutawayFor(new Vector3(), new Vector3(10, 0, 0), new Vector3());
    const now = { ...DEFAULT_SECTION, ...cut };
    expect(
      sameCut(now, { ...cut, bearingDeg: cut.bearingDeg + 1, offset: cut.offset + 0.02 }),
    ).toBe(true);
    expect(sameCut(now, { ...cut, bearingDeg: cut.bearingDeg + 20 })).toBe(false);
    expect(sameCut({ ...now, bearingDeg: 359 }, { ...cut, bearingDeg: 1 })).toBe(true);
    expect(sameCut({ ...now, enabled: false }, cut)).toBe(false);
  });

  it('places the inside view behind and above the drone, looking where it looks', () => {
    const drone = new Vector3(0, 2, 0);
    const look = new Vector3(1, -0.3, 0).normalize();
    const { position, target } = insideViewPose(drone, look, 8);
    expect(position.x).toBeLessThan(drone.x);
    expect(position.y).toBeGreaterThan(drone.y);
    expect(target.x).toBeGreaterThan(drone.x);
    // straight down: still a usable direction
    const down = insideViewPose(drone, new Vector3(0, -1, 0), 8);
    expect(Number.isFinite(down.position.z)).toBe(true);
  });
});
