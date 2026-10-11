/**
 * The survey date a photo run's layers go under, worked out from the days the photos were taken
 * (`PhotoEstimate.photoDays`) and the project's survey dates. Pure: the wizard shows the pick and
 * `startProducts` makes a new date real just before the maps are built.
 */

export type DatePick =
  | { kind: 'existing'; captureId: string; date: string; label: string }
  | { kind: 'new'; date: string }
  | { kind: 'none' };

export interface CaptureLike {
  id: string;
  label: string;
  date: string;
}

type Days = readonly { date: string; photos: number }[] | undefined;

const existing = (c: CaptureLike): DatePick => ({
  kind: 'existing',
  captureId: c.id,
  date: c.date,
  label: c.label,
});

/**
 * The automatic pick: the date a photos layer already belongs to, else the date of the day most
 * photos were taken (`days` comes most photos first), else a new date for that day, else none.
 */
export function pickSurveyDate(
  days: Days,
  captures: readonly CaptureLike[],
  layerCapture?: string,
): DatePick {
  const own = layerCapture ? captures.find((c) => c.id === layerCapture) : undefined;
  if (own) return existing(own);
  const day = days?.[0]?.date;
  if (!day) return { kind: 'none' };
  const found = captures.find((c) => c.date === day);
  return found ? existing(found) : { kind: 'new', date: day };
}

/** True for a day that is on the calendar (not 0000-00-00 or 2026-02-30). */
function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y = 0, m = 0, d = 0] = day.split('-').map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * The days of a photos layer's items, from each item's `takenAt` (its first ten characters, the
 * local date), most photos first and a tie to the earlier day. Items without a real date are skipped.
 */
export function daysOfItems(
  items: readonly { takenAt?: string | undefined }[],
): { date: string; photos: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const day = item.takenAt?.slice(0, 10);
    if (day && isCalendarDay(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts]
    .map(([date, photos]) => ({ date, photos }))
    .sort((a, b) => b.photos - a.photos || a.date.localeCompare(b.date));
}

/** The value of the pick in the Options list: '', a capture id, or `new:<date>`. */
export function choiceOf(pick: DatePick): string {
  return pick.kind === 'existing' ? pick.captureId : pick.kind === 'new' ? `new:${pick.date}` : '';
}

/** The pick a value of the Options list stands for; a date that is gone reads as none. */
export function pickFromChoice(choice: string, captures: readonly CaptureLike[]): DatePick {
  if (choice.startsWith('new:')) return { kind: 'new', date: choice.slice(4) };
  const found = captures.find((c) => c.id === choice);
  return found ? existing(found) : { kind: 'none' };
}

/** A date with its name, when the name says more than the default "Survey". */
const named = (c: { date: string; label: string }, show: (iso: string) => string) =>
  c.label && c.label !== 'Survey' ? `${show(c.date)} · ${c.label}` : show(c.date);

/** The line under the photo summary. */
export function dateSentence(pick: DatePick, show: (iso: string) => string): string {
  if (pick.kind === 'existing') return `Survey date: ${named(pick, show)}`;
  if (pick.kind === 'new') return `Survey date: ${show(pick.date)} (new)`;
  return 'No survey date.';
}

/** Said once when the photos are from more than one day; null otherwise. */
export function daysNote(days: Days, show: (iso: string) => string): string | null {
  if (!days || days.length < 2 || !days[0]) return null;
  return `The photos are from ${String(days.length)} days. Most are from ${show(days[0].date)}.`;
}

/**
 * The Options list: None, the project's dates in date order, then each distinct new day among the
 * picks to offer (the automatic pick and the person's own), earliest first.
 */
export function dateOptions(
  picks: readonly DatePick[],
  captures: readonly CaptureLike[],
  show: (iso: string) => string,
): { value: string; label: string }[] {
  const sorted = [...captures].sort((a, b) => a.date.localeCompare(b.date));
  const newDays = [...new Set(picks.flatMap((p) => (p.kind === 'new' ? [p.date] : [])))].sort();
  return [
    { value: '', label: 'None' },
    ...sorted.map((c) => ({ value: c.id, label: named(c, show) })),
    ...newDays.map((date) => ({ value: `new:${date}`, label: `New: ${show(date)}` })),
  ];
}

/** What `startProducts` is given: the id of a date that exists, or the day of a new one. */
export function pickParams(pick: DatePick): { capture?: string; captureDate?: string } {
  if (pick.kind === 'existing') return { capture: pick.captureId };
  if (pick.kind === 'new') return { captureDate: pick.date };
  return {};
}

/** Said when a run's maps were built without the survey date wanted, because it could not be saved. */
export const DATE_NOT_SAVED =
  'The survey date could not be saved, so these maps are under no date. Move them to the date in Datasets.';

/**
 * Where the run panel says `DATE_NOT_SAVED`, once: with the results when the run is ready and its
 * layers are under no date, on the progress while the maps are still being built, else nowhere
 * (no warning, or the layers are under a date).
 */
export function dateWarningPlace(s: {
  warned: boolean;
  dated: boolean;
  ready: boolean;
}): 'results' | 'progress' | null {
  if (!s.warned || s.dated) return null;
  return s.ready ? 'results' : 'progress';
}

/**
 * The survey date the results sentence names: where the run's layers really are (the first output
 * layer that is filed under a date, which may have been moved by hand), else the run file's own.
 */
export function captureOfRun(
  outputLayerIds: readonly string[],
  layers: readonly { id: string; capture?: string | undefined }[],
  runCapture: string | undefined,
): string | undefined {
  for (const id of outputLayerIds) {
    const capture = layers.find((l) => l.id === id)?.capture;
    if (capture) return capture;
  }
  return runCapture;
}
