import type { WalkFit } from '@aio/geo';
import { wrapDeg } from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type { TrackSample } from './spotTypes';

/** A three.js `Ry` heading (0 looks down -z, -pi/2 east) as a compass bearing. */
export const bearingFromHeadingRad = (rad: number): number => wrapDeg((-rad * 180) / Math.PI);

/** A placed walk every `stepS` seconds: camera over its fitted ground, picture centre's bearing. */
export function walkTrack(
  fit: WalkFit,
  durationS: number,
  heightM: number,
  headingAt: (t: number) => number | null,
  stepS: number = SPOT_RULES.walkStepS,
): TrackSample[] {
  const out: TrackSample[] = [];
  for (let i = 0; i * stepS <= durationS + 1e-9; i++) {
    const t = i * stepS;
    const s = fit.at(t);
    if (!s) continue;
    out.push({
      t,
      pos: [s.xz[0], s.groundY + heightM, s.xz[1]],
      groundY: s.groundY,
      bearingDeg: bearingFromHeadingRad(headingAt(t) ?? s.headingRad),
    });
  }
  return out;
}
