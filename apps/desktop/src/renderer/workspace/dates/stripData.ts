import type { SiteMaterial, SurveyMeasurement } from '@aio/schema';
import type { MaterialGroup } from '@aio/survey';
import { countedGroups, type IsCounted } from '../../survey/volumes/inventory';
import type { StripDate, StripMode } from './stripModel';

/**
 * What the dates strip draws, per survey date (volumetrics redesign, spec section 5): the site's
 * inventory by material on each dated survey (`countedGroups`, the Volumes tab's one counting
 * rule), its totals and each pile's figure. Only counted figures are added; a date with none has
 * no value (a gap, never a zero). Undated captures are left out (Review Focus 3).
 */

export interface StripCapture {
  id: string;
  date?: string | undefined;
}

/** How a survey date is written and coloured (`dateTags`). */
export interface StripTag {
  /** "31 Dec 2020" */
  long: string;
  /** "31 Dec" */
  short: string;
  /** "var(--date-1)" */
  colour: string;
}

export interface StripPileFigure {
  volumeM3: number;
  tonnes: number | null;
}

export interface StripDay {
  capture: string;
  /**
   * Where the survey sits in time: its day (epoch ms), and for a second survey on the same day a
   * share of that day later, so every survey has its own time.
   */
  t: number;
  label: string;
  short: string;
  colour: string;
  groups: MaterialGroup[];
  /** The site total on this date; null when no pile has a counted figure. */
  volumeM3: number | null;
  /** The tonnes of the materials with a density; null when none has one. */
  tonnes: number | null;
  /** The counted piles' figures. */
  piles: ReadonlyMap<string, StripPileFigure>;
}

const DAY_MS = 86_400_000;

/** A capture's date as epoch ms (its day), null when undated or not a date. */
export function captureTime(date: string | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date.slice(0, 10));
  return Number.isFinite(t) ? t : null;
}

/** Pending material assignments (the Materials pane's draft) applied to the piles. */
export function withAssignments(
  piles: readonly SurveyMeasurement[],
  assignments: Readonly<Record<string, string | null>>,
): SurveyMeasurement[] {
  if (Object.keys(assignments).length === 0) return [...piles];
  return piles.map((p) => {
    if (!(p.id in assignments)) return p;
    const next = { ...p };
    const id = assignments[p.id];
    if (id) next.material = id;
    else delete next.material;
    return next;
  });
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The dated surveys, oldest first (by date, then id: the inventory's and `dateTags`' order), with
 * their figures by material. Only figures the site inventory counts are added (`isCounted`, the
 * Volumes tab's one rule); a pile's change is over the nearest earlier date with counted piles.
 * Two surveys on the same day keep their own entries: each later one sits a share of the day after
 * the one before (`t`).
 */
export function stripDays(
  captures: readonly StripCapture[],
  piles: readonly SurveyMeasurement[],
  materials: readonly SiteMaterial[],
  tagOf: (capture: string) => StripTag | undefined,
  isCounted: IsCounted,
): StripDay[] {
  const dated = captures
    .flatMap((c) => {
      const day = captureTime(c.date);
      return day === null ? [] : [{ capture: c.id, date: c.date ?? '', day }];
    })
    .sort((a, b) => a.day - b.day || cmp(a.date, b.date) || cmp(a.capture, b.capture));
  const dayOf = new Map(dated.map((d) => [d.capture, d.day]));
  const dateOf = (capture: string) => dayOf.get(capture) ?? null;
  const perDay = new Map<number, number>();
  for (const d of dated) perDay.set(d.day, (perDay.get(d.day) ?? 0) + 1);
  const slot = new Map<number, number>();
  let previous: string | null = null;
  return dated.map(({ capture, day }) => {
    const k = slot.get(day) ?? 0;
    slot.set(day, k + 1);
    const t = day + Math.floor((k * DAY_MS) / (perDay.get(day) ?? 1));
    const groups = countedGroups(piles, capture, previous, materials, dateOf, isCounted);
    const pileFigures = new Map<string, StripPileFigure>();
    let volume: number | null = null;
    let tonnes: number | null = null;
    for (const g of groups) {
      volume = (volume ?? 0) + g.volumeM3;
      if (g.tonnes !== null) tonnes = (tonnes ?? 0) + g.tonnes;
      for (const p of g.piles) pileFigures.set(p.id, { volumeM3: p.volumeM3, tonnes: p.tonnes });
    }
    if (pileFigures.size > 0) previous = capture;
    const tag = tagOf(capture);
    return {
      capture,
      t,
      label: tag?.long ?? capture,
      short: tag?.short ?? capture,
      colour: tag?.colour ?? 'var(--fg-3)',
      groups,
      volumeM3: volume,
      tonnes,
      piles: pileFigures,
    };
  });
}

/** The stack's input: every date; one without a counted figure has no groups (a gap). */
export function stripDates(days: readonly StripDay[]): StripDate[] {
  return days.map((d) => ({
    capture: d.capture,
    t: d.t,
    groups: d.groups.map((g) => ({
      key: g.material?.id ?? '',
      colour: g.colour,
      volumeM3: g.volumeM3,
      tonnes: g.tonnes,
    })),
  }));
}

export interface LegendEntry {
  key: string;
  /** The material's name; null for "No material" (the component names it). */
  name: string | null;
  colour: string;
}

/** The materials in the stack's order (first seen, "No material" last). */
export function legendOf(days: readonly StripDay[]): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const d of days)
    for (const g of d.groups) {
      const key = g.material?.id ?? '';
      if (!out.some((e) => e.key === key))
        out.push({ key, name: g.material?.name ?? null, colour: g.colour });
    }
  return out.sort((a, b) => Number(a.key === '') - Number(b.key === ''));
}

/** A date's value in a mode, for the site or one pile (Cut & fill reads the volume). */
export function valueOn(day: StripDay, mode: StripMode, pile: string | null): number | null {
  if (pile !== null) {
    const f = day.piles.get(pile);
    if (!f) return null;
    return mode === 'tonnes' ? f.tonnes : f.volumeM3;
  }
  return mode === 'tonnes' ? day.tonnes : day.volumeM3;
}

/**
 * The change from `was` to `now` by the inventory's rule: over the piles counted on both dates
 * (for Tonnes, those with tonnes on both), with the percentage of their earlier figure; null when
 * no pile is on both.
 */
export function changeOver(
  was: StripDay,
  now: StripDay,
  mode: StripMode,
  pile: string | null,
): { value: number; pct: number | null } | null {
  const ids = pile !== null ? [pile] : [...now.piles.keys()];
  let value = 0;
  let base = 0;
  let on = 0;
  for (const id of ids) {
    const a = was.piles.get(id);
    const b = now.piles.get(id);
    if (!a || !b) continue;
    const va = mode === 'tonnes' ? a.tonnes : a.volumeM3;
    const vb = mode === 'tonnes' ? b.tonnes : b.volumeM3;
    if (va === null || vb === null) continue;
    value += vb - va;
    base += va;
    on += 1;
  }
  if (on === 0) return null;
  return { value, pct: base > 0 ? (value / base) * 100 : null };
}

/** The nearest date before index `i` with counted piles (the Volumes header's previous date). */
export function previousCounted(days: readonly StripDay[], i: number): StripDay | null {
  for (let j = i - 1; j >= 0; j -= 1) {
    const d = days[j];
    if (d && d.piles.size > 0) return d;
  }
  return null;
}

export interface StripReadout {
  day: StripDay;
  volumeM3: number | null;
  tonnes: number | null;
  /** The change since the previous date, in the mode's quantity (m³, or t for Tonnes). */
  delta: { value: number; pct: number | null } | null;
  /** The date the change is against. */
  vs: StripDay | null;
  /** The survey just before is still preparing its surface: the change waits for it. */
  waiting: StripDay | null;
}

/** States of a date's surface that mean its figures are still to come. */
const PENDING = new Set(['preparing', 'missing']);

/**
 * The readout of a date: its figures and the change since the previous date by the Volumes
 * header's rule (the nearest earlier date with counted piles, over the piles counted on both).
 * When the survey just before has no figure yet because its surface is still to come, the change
 * waits for it instead.
 */
export function readoutOf(
  days: readonly StripDay[],
  capture: string,
  mode: StripMode,
  pile: string | null,
  stateOf: (capture: string) => string | undefined = () => undefined,
): StripReadout | null {
  const i = days.findIndex((d) => d.capture === capture);
  const day = days[i];
  if (!day) return null;
  const fig = pile !== null ? day.piles.get(pile) : null;
  const volumeM3 = pile !== null ? (fig?.volumeM3 ?? null) : day.volumeM3;
  const tonnes = pile !== null ? (fig?.tonnes ?? null) : day.tonnes;
  const before = i > 0 ? days[i - 1] : undefined;
  if (before && valueOn(before, mode, pile) === null && PENDING.has(stateOf(before.capture) ?? ''))
    return { day, volumeM3, tonnes, delta: null, vs: null, waiting: before };
  const vs = previousCounted(days, i);
  const delta = vs && valueOn(day, mode, pile) !== null ? changeOver(vs, day, mode, pile) : null;
  return { day, volumeM3, tonnes, delta, vs: delta ? vs : null, waiting: null };
}

/** The change between two surveys in a mode (over the piles counted on both), or null. */
export function changeBetween(
  days: readonly StripDay[],
  from: string,
  to: string,
  mode: StripMode,
  pile: string | null,
): number | null {
  const a = days.find((d) => d.capture === from);
  const b = days.find((d) => d.capture === to);
  if (!a || !b) return null;
  return changeOver(a, b, mode, pile)?.value ?? null;
}

/** Consecutive survey pairs, oldest first (the Cut & fill bars). */
export function consecutivePairs(days: readonly StripDay[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const a = days[i - 1];
    const b = days[i];
    if (a && b) out.push({ from: a.capture, to: b.capture });
  }
  return out;
}

/**
 * The survey nearest a time (the playhead snaps to it). `at` places a survey (its time by
 * default); a tie keeps the earlier survey.
 */
export function nearestDay(
  days: readonly StripDay[],
  t: number,
  at: (d: StripDay) => number = (d) => d.t,
): StripDay | null {
  let best: StripDay | null = null;
  let gap = Infinity;
  for (const d of days) {
    const g = Math.abs(at(d) - t);
    if (g < gap) {
      gap = g;
      best = d;
    }
  }
  return best;
}

/** The survey `dir` steps from `capture` (clamped to the ends). */
export function stepDay(
  days: readonly StripDay[],
  capture: string | null,
  dir: -1 | 1,
): StripDay | null {
  if (days.length === 0) return null;
  const i = capture === null ? -1 : days.findIndex((d) => d.capture === capture);
  if (i < 0) return (dir > 0 ? days[0] : days[days.length - 1]) ?? null;
  return days[Math.min(days.length - 1, Math.max(0, i + dir))] ?? null;
}
