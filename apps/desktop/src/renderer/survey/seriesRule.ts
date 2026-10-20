/**
 * The rule for a measurement's volume over time (W4), one module for the app's compare store and
 * the report: each survey date's line-up (the engine's fingerprint inputs), how a per-date row is
 * keyed, which items keep figures carried over from an earlier version, and which dates need
 * working out. Pure: no store, so the report page works the dates out exactly as the app does.
 */
import {
  turnOf,
  type CaptureLineUpTurn,
  type ComparisonResult,
  type SurveyMeasurement,
} from '@aio/schema';
import { captureShift } from '@aio/workspace';

type Manifest = Parameters<typeof captureShift>[0];

/** The line-up each survey date has now, for the engine's fingerprints (dates without one left out). */
export function currentShifts(
  manifest: Manifest | null | undefined,
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  if (!manifest) return out;
  for (const c of manifest.captures) {
    const s = captureShift(manifest, c.id);
    if (s) out[c.id] = [s.eastM, s.northM];
  }
  return out;
}

/** The turn beside each survey date's line-up now, for the engine's fingerprints (dates without one left out). */
export function currentTurns(
  manifest: Manifest | null | undefined,
): Record<string, CaptureLineUpTurn> {
  const out: Record<string, CaptureLineUpTurn> = {};
  if (!manifest) return out;
  for (const c of manifest.captures) {
    const t = turnOf(captureShift(manifest, c.id));
    if (t) out[c.id] = t;
  }
  return out;
}

/** The engine context's line-ups: `shifts` and `turns`, each left out when no date has one. */
export function lineUps(manifest: Manifest | null | undefined): {
  shifts?: Record<string, [number, number]>;
  turns?: Record<string, CaptureLineUpTurn>;
} {
  const shifts = currentShifts(manifest);
  const turns = currentTurns(manifest);
  return {
    ...(Object.keys(shifts).length > 0 ? { shifts } : {}),
    ...(Object.keys(turns).length > 0 ? { turns } : {}),
  };
}

/** The date a per-date row is for (R16): `toCapture`, else `fromCapture`. */
export const seriesDate = (r: ComparisonResult): string => r.toCapture ?? r.fromCapture ?? '';

/** A per-date row's key: its item and its date. */
export const seriesKeyOf = (r: ComparisonResult): string => `${r.item} ${seriesDate(r)}`;

/** True when an item's figure, or any of its figures over time, was carried from the kit. */
export function carriedItem(m: SurveyMeasurement, item: string): boolean {
  return (
    m.results.some((r) => r.item === item && r.carried !== undefined) ||
    (m.series ?? []).some((r) => r.item === item && r.carried !== undefined)
  );
}

/**
 * The dates of an item to work out: of `captures` (with `fps` their fingerprints now, in the same
 * order), the `wanted` ones whose row is missing, or stale (marked, or worked out from other
 * inputs) and not carried over from an earlier version.
 */
export function datesToRun(
  m: SurveyMeasurement,
  item: string,
  captures: readonly string[],
  fps: readonly string[],
  wanted: ReadonlySet<string> = new Set(captures),
): string[] {
  const have = new Map((m.series ?? []).map((r) => [seriesKeyOf(r), r]));
  return captures.filter((c, k) => {
    if (!wanted.has(c)) return false;
    const r = have.get(`${item} ${c}`);
    return !r || (!r.carried && (r.status === 'stale' || r.fingerprint !== fps[k]));
  });
}
