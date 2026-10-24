import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The compare pair: From and To survey captures shared by the dates strip's compare band and the
 * Cut & fill tab. From is always the earlier survey.
 */

export interface DatedCapture {
  capture: string;
  /** Capture date in epoch ms; null when undated (never part of a pair by default). */
  t: number | null;
}

export interface ComparePair {
  from: string;
  to: string;
}

/**
 * The default pair for a focus: the survey before it and it; the first survey pairs with the next.
 * No focus or an undated one: the last two surveys. Null with fewer than two dated surveys.
 */
export function defaultPair(
  focus: string | null,
  captures: readonly DatedCapture[],
): ComparePair | null {
  const dated = captures
    .filter((c): c is DatedCapture & { t: number } => c.t !== null && Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
  if (dated.length < 2) return null;
  const i = focus === null ? -1 : dated.findIndex((c) => c.capture === focus);
  const at = i < 0 ? dated.length - 1 : Math.max(i, 1);
  const from = dated[at - 1];
  const to = dated[at];
  return from && to ? { from: from.capture, to: to.capture } : null;
}

/** The pair with From before To (swapped when given the wrong way round; undated keeps order). */
export function orderPair(
  from: string,
  to: string,
  timeOf: (capture: string) => number | null,
): ComparePair {
  const a = timeOf(from);
  const b = timeOf(to);
  return a !== null && b !== null && a > b ? { from: to, to: from } : { from, to };
}

export interface CompareDatesState {
  on: boolean;
  from: string | null;
  to: string | null;
  /** Sets the pair, swapped into date order when `timeOf` is given. */
  set(from: string, to: string, timeOf?: (capture: string) => number | null): void;
  /** Turns Compare on or off; turning on without a pair takes `defaults` (see `defaultPair`). */
  toggle(defaults?: ComparePair | null): void;
}

export function createCompareDates(): StoreApi<CompareDatesState> {
  return createStore<CompareDatesState>((set, get) => ({
    on: false,
    from: null,
    to: null,
    set(from, to, timeOf) {
      set(timeOf ? orderPair(from, to, timeOf) : { from, to });
    },
    toggle(defaults) {
      const s = get();
      if (s.on) {
        set({ on: false });
        return;
      }
      const pair = s.from !== null && s.to !== null ? null : (defaults ?? null);
      set(pair ? { on: true, ...pair } : { on: true });
    },
  }));
}

/** The app's one compare pair. */
export const compareDates = createCompareDates();
