/**
 * Pointer motion of the launch screen (from the approved prototype, docs/brand/quadrion/build/
 * gate.mjs): springs give the movement weight, the four plates separate in depth toward the
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
/** Longest frame step the springs take, so a stall does not throw the plates. */
export const MAX_DT = 0.05;

/** How far each plate (bottom first) travels at full deflection, in symbol units. */
const DEPTH = [1, 2.2, 3.5, 5] as const;
/** How each plate moves as the stack opens: the lower ones down, the upper ones up. */
const SPREAD = [1.2, 0.4, -0.4, -1.2] as const;

/**
 * Offset of each plate, bottom first, for the smoothed pointer `mx`, `my` in -1..1 from the
 * window centre: the top plate travels furthest, and the stack opens as the pointer leaves the
 * centre.
 */
export function plateOffsets(mx: number, my: number): [number, number][] {
  const opened = Math.min(1, Math.hypot(mx, my));
  return DEPTH.map((depth, i) => [mx * depth, my * depth * 0.6 + (SPREAD[i] ?? 0) * opened * 2]);
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
