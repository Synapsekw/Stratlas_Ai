import { DEFAULT_SECTION } from '@aio/engine';
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Plane,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  cutawayFor,
  insideAsset,
  insideViewPose,
  makeSeeThrough,
  parseCutawayPref,
  sameCut,
} from './cutaway';

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

describe('the see-through asset', () => {
  /** A tank: two meshes sharing one material, one with a material array, one already blended. */
  function tank() {
    const shell = new MeshStandardMaterial({ opacity: 1 });
    const roof = new MeshStandardMaterial({ opacity: 0.8, transparent: true });
    const ladder = new MeshBasicMaterial();
    ladder.depthWrite = false;
    const geo = new BoxGeometry();
    const root = new Group();
    root.add(new Mesh(geo, shell), new Mesh(geo, shell), new Mesh(geo, [roof, ladder]));
    return { root, shell, roof, ladder };
  }
  const snapshot = (...ms: { transparent: boolean; opacity: number; depthWrite: boolean }[]) =>
    ms.map((m) => ({ transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }));

  it('blends every material once, scaled by its own opacity, without writing depth', () => {
    const { root, shell, roof, ladder } = tank();
    const look = makeSeeThrough(root, 0.4);
    expect(look.count).toBe(3);
    for (const m of [shell, roof, ladder]) {
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
    }
    expect(shell.opacity).toBeCloseTo(0.4);
    expect(roof.opacity).toBeCloseTo(0.32);
    look.setOpacity(0.7);
    expect(shell.opacity).toBeCloseTo(0.7);
    expect(roof.opacity).toBeCloseTo(0.56);
  });

  it('restores exactly what the materials were, also after opacity changes', () => {
    const { root, shell, roof, ladder } = tank();
    const before = snapshot(shell, roof, ladder);
    const versions = [shell, roof, ladder].map((m) => m.version);
    const look = makeSeeThrough(root, 0.25);
    look.setOpacity(0.9);
    look.restore();
    expect(snapshot(shell, roof, ladder)).toEqual(before);
    // the renderer rebuilds the programs (blending changed back)
    [shell, roof, ladder].forEach((m, i) => {
      expect(m.version).toBeGreaterThan(versions[i] ?? 0);
    });
    // restoring twice or changing opacity afterwards does nothing
    look.restore();
    look.setOpacity(0.1);
    expect(snapshot(shell, roof, ladder)).toEqual(before);
  });

  it('keeps the opacity within usable limits', () => {
    const { root, shell } = tank();
    makeSeeThrough(root, 0);
    expect(shell.opacity).toBeCloseTo(0.05);
    const again = tank();
    makeSeeThrough(again.root, 3);
    expect(again.shell.opacity).toBeCloseTo(0.95);
  });

  it('reads back a remembered mode, or nothing', () => {
    expect(parseCutawayPref({ mode: 'transparent', opacity: 0.5 })).toEqual({
      mode: 'transparent',
      opacity: 0.5,
    });
    expect(parseCutawayPref({ mode: 'cut' })?.opacity).toBeCloseTo(0.3);
    expect(parseCutawayPref({ mode: 'auto' })).toBeNull();
    expect(parseCutawayPref(null)).toBeNull();
  });
});
