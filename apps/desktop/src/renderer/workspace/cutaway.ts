import type { SectionState } from '@aio/engine';
import { Vector3, type Box3 } from 'three';

const DEG = Math.PI / 180;

/** Is `p` inside the box, with the box shrunk by `inset` (a fraction of its size) on every side? */
export function insideAsset(p: Vector3, box: Box3, inset = 0.04): boolean {
  if (box.isEmpty()) return false;
  const size = box.getSize(new Vector3()).multiplyScalar(inset);
  return (
    p.x > box.min.x + size.x &&
    p.x < box.max.x - size.x &&
    p.y > box.min.y + size.y &&
    p.y < box.max.y - size.y &&
    p.z > box.min.z + size.z &&
    p.z < box.max.z - size.z
  );
}

/** Compass bearing of the horizontal direction from `from` to `to` (clockwise from north, -Z). */
export function bearingDeg(from: Vector3, to: Vector3): number {
  return (((Math.atan2(to.x - from.x, -(to.z - from.z)) / DEG) % 360) + 360) % 360;
}

export type Cut = Pick<SectionState, 'enabled' | 'mode' | 'bearingDeg' | 'offset' | 'flip'>;

/**
 * The vertical section that opens the asset toward the viewer: it removes the half between the
 * camera and the drone, `margin` metres in front of the drone, so the drone and the walls it
 * films stay. Offsets are measured from the engine's section origin.
 */
export function cutawayFor(drone: Vector3, camera: Vector3, origin: Vector3, margin = 0.6): Cut {
  const b = Math.round(bearingDeg(drone, camera));
  const toward = new Vector3(Math.sin(b * DEG), 0, -Math.cos(b * DEG));
  const offset = drone.clone().sub(origin).dot(toward) + margin;
  return { enabled: true, mode: 'vertical', bearingDeg: b % 360, offset, flip: false };
}

/** Is the section already (close to) this cut? Avoids re-applying it every frame. */
export function sameCut(s: SectionState, c: Cut): boolean {
  const db = Math.abs(((((s.bearingDeg - c.bearingDeg) % 360) + 540) % 360) - 180);
  return (
    s.enabled === c.enabled &&
    s.mode === c.mode &&
    s.flip === c.flip &&
    db < 3 &&
    Math.abs(s.offset - c.offset) < 0.08
  );
}

/**
 * A view from outside the cut, behind and above the drone, looking the way the drone looks, so
 * the drone and the walls its video is projected on are both in frame.
 */
export function insideViewPose(
  drone: Vector3,
  look: Vector3,
  distance: number,
): { position: Vector3; target: Vector3 } {
  const h = new Vector3(look.x, 0, look.z);
  if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
  h.normalize();
  const target = drone.clone().addScaledVector(h, Math.min(1.5, distance * 0.25));
  const position = drone
    .clone()
    .addScaledVector(h, -distance)
    .add(new Vector3(0, distance * 0.35, 0));
  return { position, target };
}
