import type { Box3 } from 'three';
import { Vector3 } from 'three';

/**
 * The sun's shadow frustum, fitted to what the camera looks at: a square in the light's view
 * centred on the orbit target (kept inside the content), sized in a few fixed steps by the
 * camera distance and never wider than the content, snapped to whole shadow texels so shadows
 * stay still while orbiting, with a depth range that just encloses the content (tight depth
 * means little acne and little bias). One map, re-aimed when the view moves: on a plant a few
 * kilometres wide this keeps close-ups crisp at a fraction of the cost of cascades.
 */
export interface ShadowFit {
  /** Light position (the shadow camera) and its target, local frame. */
  position: Vector3;
  target: Vector3;
  /** Half the side of the square the map covers, metres. */
  halfExtent: number;
  near: number;
  far: number;
  /** Metres per shadow texel. */
  texel: number;
}

/** Right and up axes of the shadow camera for a sun direction (three's lookAt with +Y up). */
export function lightBasis(sunDir: Vector3): { x: Vector3; y: Vector3 } {
  const up = new Vector3(0, 1, 0);
  const x = new Vector3().crossVectors(up, sunDir);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const y = new Vector3().crossVectors(sunDir, x).normalize();
  return { x, y };
}

const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Fit the frustum. `box` holds everything that casts or receives shadows (content and the ground
 * under it); `radius` is the content radius the extent steps are taken from; `viewDist` the
 * camera's distance to `target`.
 */
export function fitShadow(
  sunDir: Vector3,
  box: Box3,
  radius: number,
  target: Vector3,
  viewDist: number,
  mapSize: number,
): ShadowFit {
  const s = sunDir.clone().normalize();
  const { x: lx, y: ly } = lightBasis(s);
  // the content's footprint in light space
  let aMin = Infinity;
  let aMax = -Infinity;
  let bMin = Infinity;
  let bMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;
  const p = new Vector3();
  for (const i of CORNERS) {
    p.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    const a = p.dot(lx);
    const b = p.dot(ly);
    const c = p.dot(s);
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
    bMin = Math.min(bMin, b);
    bMax = Math.max(bMax, b);
    cMin = Math.min(cMin, c);
    cMax = Math.max(cMax, c);
  }
  const r = Math.max(radius, 1);
  const steps = [r / 16, r / 8, r / 4, r / 2, r * 1.1];
  const want = viewDist * 0.85;
  const footprint = Math.max(aMax - aMin, bMax - bMin) / 2;
  const ext = Math.max(Math.min(steps.find((e) => e >= want) ?? r * 1.1, footprint * 1.02), 0.5);
  const texel = (2 * ext) / mapSize;
  // centre on the target, kept so the square stays over the content
  const clampTo = (v: number, lo: number, hi: number) =>
    lo + ext > hi - ext ? (lo + hi) / 2 : Math.min(Math.max(v, lo + ext), hi - ext);
  const a = Math.round(clampTo(target.dot(lx), aMin, aMax) / texel) * texel;
  const b = Math.round(clampTo(target.dot(ly), bMin, bMax) / texel) * texel;
  const margin = Math.max(1, (cMax - cMin) * 0.02);
  const position = new Vector3()
    .addScaledVector(lx, a)
    .addScaledVector(ly, b)
    .addScaledVector(s, cMax + margin);
  return {
    position,
    target: position.clone().sub(s),
    halfExtent: ext,
    near: margin * 0.5,
    far: cMax - cMin + margin * 2,
    texel,
  };
}
