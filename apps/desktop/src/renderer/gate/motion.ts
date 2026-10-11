/**
 * Pointer motion of the launch screen (from the approved prototype, docs/brand/quadrion/build/
 * gate.mjs): springs give the movement weight, the four pieces separate in depth toward the
 * pointer, and everything drifts back to the centre when the pointer rests.
 */

export interface Spring {
  x: number;
  v: number;
}

/** One step of a damped spring towards `target` (stiffness `k`, damping `d`, `dt` in seconds). */
export function stepSpring(s: Spring, target: number, k: number, d: number, dt: number): void {
  const a = (target - s.x) * k - s.v * d;
  s.v += a * dt;
  s.x += s.v * dt;
}

/** Parallax of the mark and the terrain. */
export const PARALLAX = { k: 90, d: 14 } as const;
/** The scan light under the pointer, a little quicker. */
export const LIGHT = { k: 160, d: 22 } as const;
/** After this long without a pointer move the scene returns to the centre. */
export const IDLE_MS = 4000;
/** Longest frame step the springs take, so a stall does not throw the pieces. */
export const MAX_DT = 0.05;

/** How far each piece (north-west, north-east, south-west, tail) travels at full deflection, in symbol units. */
const DEPTH = [1, 1.6, 2.2, 5] as const;
/** The way each piece moves as the ring opens: out along its own diagonal. */
const OUT: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
/** How far the ring opens at full deflection, in symbol units. */
const OPEN = 0.9;

/**
 * Offset of each piece for the smoothed pointer `mx`, `my` in -1..1 from the window centre: the
 * tail travels furthest, and the ring opens as the pointer leaves the centre.
 */
export function pieceOffsets(mx: number, my: number): [number, number][] {
  const opened = Math.min(1, Math.hypot(mx, my)) * OPEN;
  return DEPTH.map((depth, i) => {
    const [ox, oy] = OUT[i] ?? [0, 0];
    return [mx * depth + ox * opened, my * depth * 0.6 + oy * opened];
  });
}

/** Pointer position in -1..1 from the window centre. */
export function pointerTarget(
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number] {
  if (width <= 0 || height <= 0) return [0, 0];
  return [(x / width) * 2 - 1, (y / height) * 2 - 1];
}
