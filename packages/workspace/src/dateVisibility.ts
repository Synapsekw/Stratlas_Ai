import type { Issue } from '@aio/schema';

/**
 * Which annotations are on screen with the survey dates (captures): an annotation belongs to a
 * date like a layer does, so hiding the date's layers hides it. One rule for every view (3D pins
 * and draped shapes, the map, the photo and video viewers, measurements), read from the layer
 * switches (`hidden`) and the capture index; nothing here is stored.
 *
 * The rule, for an annotation of a date:
 * - marked on layers of that date (its sightings): on screen while one of those layers is shown;
 * - tied to the date only by its `capture` field: on screen while any layer of the date is shown
 *   (a date without layers has nothing to hide it by, so it stays).
 *
 * An annotation of no date (marked on layers common to every date, or on none) is always on
 * screen, as before.
 */

/** The capture each dated layer belongs to (`CaptureIndex`, or the same read-only). */
interface DateOf {
  captures: readonly { id: string }[];
  of: Readonly<Record<string, string>>;
}
/** The layers of each capture (`CaptureIndex`, or the same read-only). */
interface DateLayers {
  layers: Readonly<Record<string, readonly string[]>>;
}
type DateIndex = DateOf & DateLayers;
type Hidden = Readonly<Record<string, true>>;
type Dated = Pick<Issue, 'capture' | 'sightings'>;

/**
 * The capture (survey date) an issue belongs to: its own `capture` when the project has it, else
 * the date most of its sightings' layers belong to (the first such date on a tie). Undefined: no
 * date. Unlike change detection (`issueDate` of `@aio/change`) there is no fallback to the day the
 * issue was written.
 */
export function issueCapture(issue: Dated, index: DateOf): string | undefined {
  const own = issue.capture;
  if (own !== undefined && index.captures.some((c) => c.id === own)) return own;
  const votes = new Map<string, number>();
  for (const s of issue.sightings) {
    const c = index.of[s.layer];
    if (c !== undefined) votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  let best: string | undefined;
  let most = 0;
  for (const [c, n] of votes) {
    if (n > most) {
      best = c;
      most = n;
    }
  }
  return best;
}

/** A capture with one of its layers shown, or with no layer at all. */
export function captureOnScreen(
  index: DateLayers,
  capture: string,
  hidden: Hidden,
  shown: readonly string[] = [],
): boolean {
  const layers = index.layers[capture] ?? [];
  return layers.length === 0 || layers.some((id) => !hidden[id] || shown.includes(id));
}

/**
 * Whether something scoped to the whole site or to one survey (a survey measurement) is on
 * screen: site-wide always, a survey's while that survey is. A survey the project does not have
 * hides nothing.
 */
export function scopeOnScreen(
  scope: { kind: 'site' } | { kind: 'survey'; capture: string },
  index: (Pick<DateOf, 'captures'> & DateLayers) | null | undefined,
  hidden: Hidden,
): boolean {
  if (scope.kind !== 'survey' || !index) return true;
  if (!index.captures.some((c) => c.id === scope.capture)) return true;
  return captureOnScreen(index, scope.capture, hidden);
}

/**
 * Whether an issue is on screen (the rule above). `shown` names layers a view shows whatever the
 * switches say (the photo viewer its photo set, the video window its clip): that view draws what
 * is marked on them and, their date being on screen there, every issue of that date.
 */
export function issueOnScreen(
  issue: Dated,
  index: DateIndex,
  hidden: Hidden,
  shown: readonly string[] = [],
): boolean {
  const capture = issueCapture(issue, index);
  if (capture === undefined) return true;
  if (shown.some((id) => index.of[id] === capture)) return true;
  if (shown.length > 0 && issue.sightings.some((s) => shown.includes(s.layer))) return true;
  let marked = false;
  for (const s of issue.sightings) {
    if (index.of[s.layer] !== capture) continue;
    if (!hidden[s.layer]) return true;
    marked = true;
  }
  return marked ? false : captureOnScreen(index, capture, hidden);
}

/**
 * The issues on screen. The same array when none is left out (no dates, nothing hidden), so a
 * view that redraws on a new array does not redraw for nothing.
 */
export function issuesOnScreen<T extends Dated>(
  issues: readonly T[],
  index: DateIndex | null | undefined,
  hidden: Hidden,
  shown: readonly string[] = [],
): readonly T[] {
  if (!index || index.captures.length === 0) return issues;
  let dropped = false;
  const out: T[] = [];
  for (const i of issues) {
    if (issueOnScreen(i, index, hidden, shown)) out.push(i);
    else dropped = true;
  }
  return dropped ? out : issues;
}

/** The same items in the same order (a redraw can be skipped). */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Issues per capture id, and those of no date, for a tree that lists them by date. */
export function issuesByCapture<T extends Dated>(
  issues: readonly T[],
  index: DateOf,
): { dated: Record<string, T[]>; undated: T[] } {
  const dated: Record<string, T[]> = {};
  const undated: T[] = [];
  for (const i of issues) {
    const c = issueCapture(i, index);
    if (c === undefined) undated.push(i);
    else (dated[c] ??= []).push(i);
  }
  return { dated, undated };
}
