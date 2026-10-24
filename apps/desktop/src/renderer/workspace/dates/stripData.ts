import type { SiteMaterial, SurveyMeasurement } from '@aio/schema';
import { inventoryByMaterial, type MaterialGroup } from '@aio/survey';
import type { StripDate, StripMode } from './stripModel';

/**
 * What the dates strip draws, per survey date (volumetrics redesign, spec section 5): the site's
 * inventory by material on each dated survey (`inventoryByMaterial`, the Volumes tab's own rule),
 * its totals and each pile's figure. Only counted figures are added; a date with none has no value
 * (a gap, never a zero). Undated captures are left out (Review Focus 3).
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
  t: number;
  label: string;
  short: string;
  colour: string;
  groups: MaterialGroup[];
  /** The site total on this date; null when no pile has a counted figure. */
  volumeM3: number | null;
  /** The tonnes of the materials with a density; null when none has one. */
  tonnes: number | null;
  piles: ReadonlyMap<string, StripPileFigure>;
}

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

/** The dated surveys, oldest first, with their figures by material. */
export function stripDays(
  captures: readonly StripCapture[],
  piles: readonly SurveyMeasurement[],
  materials: readonly SiteMaterial[],
  tagOf: (capture: string) => StripTag | undefined,
): StripDay[] {
  const times = new Map<string, number>();
  for (const c of captures) {
    const t = captureTime(c.date);
    if (t !== null) times.set(c.id, t);
  }
  const dateOf = (capture: string) => times.get(capture) ?? null;
  const dated = [...times.entries()].sort((a, b) => a[1] - b[1]);
  return dated.map(([capture, t], i) => {
    const previous = dated[i - 1]?.[0] ?? null;
    const groups = inventoryByMaterial(piles, capture, previous, materials, dateOf);
    const pileFigures = new Map<string, StripPileFigure>();
    let volume: number | null = null;
    let tonnes: number | null = null;
    for (const g of groups) {
      volume = (volume ?? 0) + g.volumeM3;
      if (g.tonnes !== null) tonnes = (tonnes ?? 0) + g.tonnes;
      for (const p of g.piles) pileFigures.set(p.id, { volumeM3: p.volumeM3, tonnes: p.tonnes });
    }
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

/** The stack's input: only dates with a counted figure (a date without one is a gap). */
export function stripDates(days: readonly StripDay[]): StripDate[] {
  return days
    .filter((d) => d.volumeM3 !== null)
    .map((d) => ({
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

export interface StripReadout {
  day: StripDay;
  volumeM3: number | null;
  tonnes: number | null;
  /** The change since the survey before, in the mode's quantity (m³, or t for Tonnes). */
  delta: { value: number; pct: number | null } | null;
  /** The survey the change is against. */
  vs: StripDay | null;
  /** The survey before is still preparing its surface: the change waits for it. */
  waiting: StripDay | null;
}

/** States of a date's surface that mean its figures are still to come. */
const PENDING = new Set(['preparing', 'missing']);

/** The readout of a date: its figures and the change since the survey before it. */
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
  const now = valueOn(day, mode, pile);
  const was = before ? valueOn(before, mode, pile) : null;
  let delta: StripReadout['delta'] = null;
  let waiting: StripDay | null = null;
  if (before && now !== null && was !== null) {
    const value = now - was;
    delta = { value, pct: was !== 0 ? (value / Math.abs(was)) * 100 : null };
  } else if (before && was === null && PENDING.has(stateOf(before.capture) ?? '')) {
    waiting = before;
  }
  return { day, volumeM3, tonnes, delta, vs: delta ? (before ?? null) : null, waiting };
}

/** The change between two surveys in a mode, or null when either has no value. */
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
  const va = valueOn(a, mode, pile);
  const vb = valueOn(b, mode, pile);
  return va === null || vb === null ? null : vb - va;
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

/** The survey nearest a time (the playhead snaps to it). */
export function nearestDay(days: readonly StripDay[], t: number): StripDay | null {
  let best: StripDay | null = null;
  let gap = Infinity;
  for (const d of days) {
    const g = Math.abs(d.t - t);
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
