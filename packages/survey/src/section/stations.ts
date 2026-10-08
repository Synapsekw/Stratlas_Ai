/**
 * Section lines from an alignment, the map's corridor band, and the 3D cutaway plane of a line.
 *
 * Alignment sections (G6's alignment arithmetic): a line across the alignment at each station
 * label (every `intervalM`, default the alignment's own interval), from `leftM` to the left of the
 * direction of travel to `rightM` to its right. Offsets are positive to the right, as
 * `stationOffset` reports them, so a section's ends read offsets `-leftM` and `+rightM`.
 */
import type { Alignment } from '@aio/schema';
import { pointAt, stationLabels } from '../designs/alignment';
import type { XY } from './profile';

type Elements = Pick<Alignment, 'elements' | 'equations' | 'startStation'> &
  Partial<Pick<Alignment, 'intervalM'>>;

export interface StationSection {
  station: number;
  label: string;
  region: number;
  /** Distance along the alignment, metres. */
  distance: number;
  /** From the left end to the right end (E, N). */
  line: [[number, number], [number, number]];
}

export function alignmentSections(
  al: Elements,
  opts: { intervalM?: number; leftM: number; rightM: number; from?: number; to?: number },
): StationSection[] {
  const out: StationSection[] = [];
  for (const s of stationLabels(al, opts.intervalM)) {
    if (opts.from !== undefined && s.station < opts.from - 1e-9) continue;
    if (opts.to !== undefined && s.station > opts.to + 1e-9) continue;
    const [e, n, b] = pointAt(al, s.distance);
    // the right-hand normal of bearing b (clockwise from north) is (cos b, -sin b)
    const re = Math.cos(b);
    const rn = -Math.sin(b);
    out.push({
      station: s.station,
      label: s.label,
      region: s.region,
      distance: s.distance,
      line: [
        [e - opts.leftM * re, n - opts.leftM * rn],
        [e + opts.rightM * re, n + opts.rightM * rn],
      ],
    });
  }
  return out;
}

/**
 * A band `halfWidth` either side of a polyline, as a closed ring (E, N): the left offsets forward
 * and the right offsets back, mitred at the vertices (the miter limited to 4 half widths).
 */
export function corridorRing(line: readonly XY[], halfWidth: number): [number, number][] {
  const pts = line.filter(
    (p, i) =>
      i === 0 || Math.hypot(p[0] - (line[i - 1]?.[0] ?? 0), p[1] - (line[i - 1]?.[1] ?? 0)) > 0,
  );
  if (pts.length < 2) return [];
  const normals: [number, number][] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1] ?? pts[0];
    const b = pts[k] ?? pts[0];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // left normal of the direction (de, dn) is (-dn, de)
    normals.push([-(b[1] - a[1]) / len, (b[0] - a[0]) / len]);
  }
  const offsetAt = (k: number): [number, number] => {
    const before = normals[k - 1];
    const after = normals[k];
    const one = before ?? after ?? [0, 0];
    const two = after ?? before ?? [0, 0];
    let me = one[0] + two[0];
    let mn = one[1] + two[1];
    const len = Math.hypot(me, mn);
    if (len < 1e-12) return [one[0] * halfWidth, one[1] * halfWidth];
    me /= len;
    mn /= len;
    const cos = me * one[0] + mn * one[1];
    const scale = Math.min(halfWidth / Math.max(cos, 1e-9), 4 * halfWidth);
    return [me * scale, mn * scale];
  };
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  pts.forEach((p, k) => {
    const [oe, on] = offsetAt(k);
    left.push([p[0] + oe, p[1] + on]);
    right.push([p[0] - oe, p[1] - on]);
  });
  return [...left, ...right.reverse()];
}

/**
 * The stage's vertical section plane (`SectionState`) that cuts along a section line: the plane
 * holds the line's first segment; the half to the right of the direction of travel is removed
 * (`bearingDeg` is the bearing of that side), so the view looks at the cut from the right.
 * `centre` is the stage's section origin in the local frame (x east, z south) and `origin` the
 * project origin (E, N) of that frame.
 */
export function cutawayPlane(
  line: readonly XY[],
  origin: readonly [number, number],
  centre: { x: number; z: number },
): { bearingDeg: number; offset: number } | null {
  const a = line[0];
  const b = line.find(
    (p, i) => i > 0 && Math.hypot(p[0] - (a?.[0] ?? 0), p[1] - (a?.[1] ?? 0)) > 0,
  );
  if (!a || !b) return null;
  const dir = Math.atan2(b[0] - a[0], b[1] - a[1]);
  const right = dir + Math.PI / 2;
  const te = Math.sin(right);
  const tn = Math.cos(right);
  const ce = origin[0] + centre.x;
  const cn = origin[1] - centre.z;
  const offset = (a[0] - ce) * te + (a[1] - cn) * tn;
  const deg = ((((right * 180) / Math.PI) % 360) + 360) % 360;
  return { bearingDeg: deg, offset };
}
