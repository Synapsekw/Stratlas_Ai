import type { WalkFit } from '@aio/geo';
import { wrapDeg } from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type { TrackSample } from './spotTypes';

/** A three.js `Ry` heading (0 looks down -z, -pi/2 east) as a compass bearing. */
export const bearingFromHeadingRad = (rad: number): number => wrapDeg((-rad * 180) / Math.PI);

/**
 * A placed walk every `stepS` seconds: the camera `heightM` over its ground, the picture centre's
 * bearing. The ground is `groundAt` under the walk's point (the 3D view's walk ground, in the
 * walk's own frame, asked near the fitted ground) where it answers, else the fitted ground (its
 * pins).
 */
export function walkTrack(
  fit: WalkFit,
  durationS: number,
  heightM: number,
  headingAt: (t: number) => number | null,
  groundAt?: (x: number, z: number, near: number) => number | null,
  stepS: number = SPOT_RULES.walkStepS,
): TrackSample[] {
  const out: TrackSample[] = [];
  for (let i = 0; i * stepS <= durationS + 1e-9; i++) {
    const t = i * stepS;
    const s = fit.at(t);
    if (!s) continue;
    const g = groundAt?.(s.xz[0], s.xz[1], s.groundY);
    const groundY = typeof g === 'number' && Number.isFinite(g) ? g : s.groundY;
    out.push({
      t,
      pos: [s.xz[0], groundY + heightM, s.xz[1]],
      groundY,
      bearingDeg: bearingFromHeadingRad(headingAt(t) ?? s.headingRad),
    });
  }
  return out;
}
