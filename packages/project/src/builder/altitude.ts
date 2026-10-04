import { fromWgs84, takeoffAbsAltitude, type AltitudeReading, type HeightRule } from '@aio/geo';
import type {
  AltitudeChoice,
  AltitudePlan,
  ImportHeights,
  ImportItem,
  ProjectManifest,
  VerticalDatum,
} from '@aio/schema';

/**
 * Camera heights of a raw import (data-conventions section 3a).
 *
 * - Absolute altitude is used when the project defines a vertical datum (`verticalDatum`,
 *   `H = absolute + absAltOffsetM`), or when the person picks it at import with an offset (saved
 *   as the project's datum so later imports agree).
 * - Otherwise relative altitude plus the take-off height H the person confirms at import (the
 *   import UI proposes the model or terrain height under the take-off point, else the origin
 *   height with a warning).
 * - A file without the preferred altitude uses the other one; without either it sits at the
 *   take-off height. The summary shows the rule and its numbers so the person can correct them.
 */
export interface ResolvedHeights {
  rule: HeightRule;
  /** The rule as the summary shows it when every file used the preferred altitude. */
  summary: ImportHeights;
  /** A datum the person set at this import, to save into the manifest. */
  saveDatum?: VerticalDatum;
}

export function resolveHeights(m: ProjectManifest, choice?: AltitudeChoice): ResolvedHeights {
  const source = choice?.source ?? 'auto';
  const datum = m.verticalDatum;
  const takeoffH = choice?.takeoffH ?? m.origin[2];
  const takeoffFrom: ImportHeights['from'] =
    choice?.takeoffH === undefined ? 'origin' : (choice.takeoffFrom ?? 'typed');
  const absolute = source === 'absolute' || (source === 'auto' && datum !== undefined);
  if (absolute) {
    const typed = choice?.absAltOffsetM;
    const offset = typed ?? datum?.absAltOffsetM ?? 0;
    const known = typed !== undefined || datum !== undefined;
    const note =
      typed !== undefined && typed !== datum?.absAltOffsetM
        ? 'Set at import: project height = absolute altitude + offset.'
        : datum?.note;
    return {
      rule: { prefer: 'absolute', absOffsetM: offset, takeoffH },
      summary: {
        source: 'absolute',
        offsetM: offset,
        from: known ? 'datum' : 'uncorrected',
        ...(note ? { note } : {}),
      },
      ...(typed !== undefined && typed !== datum?.absAltOffsetM
        ? { saveDatum: { absAltOffsetM: typed, note: note ?? '' } }
        : {}),
    };
  }
  return {
    rule: { prefer: 'relative', absOffsetM: datum?.absAltOffsetM ?? 0, takeoffH },
    summary: { source: 'relative', offsetM: takeoffH, from: takeoffFrom },
  };
}

/**
 * The summary of what an import did: the rule, or the other altitude's numbers when every file
 * that got a height fell back to it (photos with only a GPS altitude under the relative rule).
 */
export function importHeights(
  r: ResolvedHeights,
  items: readonly ImportItem[],
  datumDefined: boolean,
): ImportHeights | undefined {
  const used = items.map((i) => i.heightSource).filter((s) => s !== undefined);
  if (!used.length) return undefined;
  const all = (s: ImportItem['heightSource']) => used.every((u) => u === s);
  if (r.summary.source === 'relative' && all('absolute'))
    return {
      source: 'absolute',
      offsetM: r.rule.absOffsetM,
      from: datumDefined ? 'datum' : 'uncorrected',
    };
  if (r.summary.source === 'absolute' && all('relative'))
    return {
      source: 'relative',
      offsetM: r.rule.takeoffH,
      from: r.summary.from === 'datum' || r.summary.from === 'uncorrected' ? 'origin' : 'typed',
    };
  return r.summary;
}

/** A sentence for an import item: where its heights came from. */
export function heightNote(
  source: ImportItem['heightSource'],
  rule: HeightRule,
  datumDefined: boolean,
): string {
  const n = (v: number) => v.toFixed(1);
  switch (source) {
    case 'absolute':
      return datumDefined
        ? `Heights: absolute altitude ${rule.absOffsetM >= 0 ? '+' : '-'} ${n(Math.abs(rule.absOffsetM))} m (project datum).`
        : 'Heights: absolute altitude as logged, no datum correction; it can be tens of metres off.';
    case 'relative':
      return `Heights: relative altitude + take-off at H ${n(rule.takeoffH)} m.`;
    case 'mixed':
      return 'Heights: absolute and relative altitude mixed (some frames lack one); check them.';
    case 'none':
      return `No altitude logged: placed at the take-off height H ${n(rule.takeoffH)} m.`;
    default:
      return '';
  }
}

/** Altitude readings of one file, for the plan. */
export interface FileAltitudes {
  readings: (AltitudeReading & { lat?: number | undefined; lon?: number | undefined })[];
  /** Home (take-off) point when the log names it. */
  home?: { lat: number; lon: number } | undefined;
}

/** What a set of files carries for heights, and the rule `auto` would pick (`builder:altitudePlan`). */
export function altitudePlan(
  m: ProjectManifest,
  epsg: number,
  files: FileAltitudes[],
): AltitudePlan {
  const withHeights = files.filter((f) => f.readings.length > 0);
  const has = (f: FileAltitudes, k: 'abs' | 'rel') =>
    f.readings.every((r) => r[k] !== undefined && Number.isFinite(r[k]));
  const absolute = withHeights.filter((f) => has(f, 'abs')).length;
  const relative = withHeights.filter((f) => has(f, 'rel')).length;
  const datum = m.verticalDatum ?? null;
  const local = (lat: number, lon: number) => {
    const p = fromWgs84([lon, lat, 0], epsg);
    return { x: p[0] - m.origin[0], z: 0 - (p[1] - m.origin[1]) };
  };
  let takeoff: AltitudePlan['takeoff'] = null;
  const home = withHeights.find((f) => f.home)?.home;
  if (home) takeoff = { ...local(home.lat, home.lon), relAltM: 0 };
  else {
    let low: { lat: number; lon: number; rel: number } | undefined;
    for (const f of withHeights)
      for (const r of f.readings)
        if (
          r.rel !== undefined &&
          r.lat !== undefined &&
          r.lon !== undefined &&
          (!low || r.rel < low.rel)
        )
          low = { lat: r.lat, lon: r.lon, rel: r.rel };
    if (low) takeoff = { ...local(low.lat, low.lon), relAltM: low.rel };
  }
  const r = (v: number) => Math.round(v * 1000) / 1000;
  if (takeoff) takeoff = { x: r(takeoff.x), z: r(takeoff.z), relAltM: r(takeoff.relAltM) };
  const abs = takeoffAbsAltitude(withHeights.flatMap((f) => f.readings));
  return {
    files: withHeights.length,
    absolute,
    relative,
    datum,
    recommended: datum && absolute > 0 ? 'absolute' : relative > 0 ? 'relative' : 'absolute',
    takeoff,
    takeoffAbsAlt: abs === null ? null : r(abs),
  };
}
