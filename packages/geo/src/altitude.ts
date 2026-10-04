/**
 * Camera heights from drone altitudes (data-conventions section 3a).
 *
 * Drones log two altitudes. Relative altitude (DJI `rel_alt`, XMP `RelativeAltitude`) is the
 * barometric height above the take-off point: steady within a flight, but only a project height
 * once the take-off point's height is known. Absolute altitude (DJI `abs_alt`, XMP
 * `AbsoluteAltitude`, EXIF `GPSAltitude`) is barometric, offset to GNSS at power-on, nominally above
 * mean sea level but often tens of metres off (and it drifts between flights); RTK aircraft write
 * ellipsoidal heights. It is a project height only through a vertical datum offset the project
 * defines: `H = absolute + absOffsetM`.
 *
 * Rule: prefer absolute altitude when the project defines a datum, else relative altitude plus
 * the take-off height; a reading without the preferred altitude uses the other one, and one
 * without either sits at the take-off height.
 */

export type HeightSource = 'absolute' | 'relative' | 'none';

export interface HeightRule {
  prefer: 'absolute' | 'relative';
  /** `H = absolute altitude + absOffsetM` (vertical datum; 0 when the project defines none). */
  absOffsetM: number;
  /** Project height H of the take-off point, for relative altitude. */
  takeoffH: number;
}

export interface AltitudeReading {
  /** Absolute altitude, metres. */
  abs?: number | undefined;
  /** Height above the take-off point, metres. */
  rel?: number | undefined;
}

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/** Project height H of one reading under a rule, and the altitude it came from. */
export function projectHeight(
  r: AltitudeReading,
  rule: HeightRule,
): { h: number; source: HeightSource } {
  const abs = finite(r.abs) ? { h: r.abs + rule.absOffsetM, source: 'absolute' as const } : null;
  const rel = finite(r.rel) ? { h: rule.takeoffH + r.rel, source: 'relative' as const } : null;
  const pick = rule.prefer === 'absolute' ? (abs ?? rel) : (rel ?? abs);
  return pick ?? { h: rule.takeoffH, source: 'none' };
}

/** One source for a set of readings: the common one, or `mixed`. */
export function summariseSources(
  sources: Iterable<HeightSource>,
): HeightSource | 'mixed' | undefined {
  let out: HeightSource | undefined;
  for (const s of sources) {
    if (out === undefined) out = s;
    else if (out !== s) return 'mixed';
  }
  return out;
}

/**
 * The take-off point's absolute altitude: the median of absolute minus relative altitude over the
 * readings that have both (a flight logs it as a constant up to barometric noise), or null.
 */
export function takeoffAbsAltitude(readings: Iterable<AltitudeReading>): number | null {
  const d: number[] = [];
  for (const r of readings) if (finite(r.abs) && finite(r.rel)) d.push(r.abs - r.rel);
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? (d[m] ?? 0) : ((d[m - 1] ?? 0) + (d[m] ?? 0)) / 2;
}
