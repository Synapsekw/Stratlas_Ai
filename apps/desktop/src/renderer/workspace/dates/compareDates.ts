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

/** True when both ends of the pair are set, differ and are among `captures`. */
export function pairIn(
  pair: { from: string | null; to: string | null },
  captures: readonly string[],
): pair is ComparePair {
  return (
    pair.from !== null &&
    pair.to !== null &&
    pair.from !== pair.to &&
    captures.includes(pair.from) &&
    captures.includes(pair.to)
  );
}

/**
 * The pair to use with the open project's captures: the chosen one when it belongs to them, else
 * the default for the focus (a pair left over from another project never applies).
 */
export function pairFor(
  pair: { from: string | null; to: string | null },
  focus: string | null,
  captures: readonly DatedCapture[],
): ComparePair | null {
  if (
    pairIn(
      pair,
      captures.map((c) => c.capture),
    )
  )
    return { from: pair.from, to: pair.to };
  return defaultPair(focus, captures);
}

export interface CompareDatesState {
  on: boolean;
  from: string | null;
  to: string | null;
  /** The open project's captures (null: not known yet); a pair outside them is not reused. */
  known: readonly string[] | null;
  /** Sets the pair, swapped into date order when `timeOf` is given. */
  set(from: string, to: string, timeOf?: (capture: string) => number | null): void;
  /**
   * Turns Compare on or off; turning on without a pair, or with one whose captures are not the
   * open project's, takes `defaults` (see `defaultPair`).
   */
  toggle(defaults?: ComparePair | null): void;
  /** Another project: Compare off, the pair forgotten, `captures` the known ones. */
  reset(captures?: readonly string[] | null): void;
  /** The open project's captures changed (a survey added or removed). */
  setKnown(captures: readonly string[] | null): void;
}

export function createCompareDates(): StoreApi<CompareDatesState> {
  return createStore<CompareDatesState>((set, get) => ({
    on: false,
    from: null,
    to: null,
    known: null,
    set(from, to, timeOf) {
      set(timeOf ? orderPair(from, to, timeOf) : { from, to });
    },
    toggle(defaults) {
      const s = get();
      if (s.on) {
        set({ on: false });
        return;
      }
      const kept = s.from !== null && s.to !== null && (s.known === null || pairIn(s, s.known));
      const pair = kept ? null : (defaults ?? null);
      set(pair ? { on: true, ...pair } : { on: true });
    },
    reset(captures) {
      set({ on: false, from: null, to: null, known: captures ?? null });
    },
    setKnown(captures) {
      set({ known: captures });
    },
  }));
}

/** The open project as the compare pair follows it (the workspace store's shape). */
export interface ProjectSource {
  project: { id: string; manifest: { captures: readonly { id: string }[] } } | null;
}

/**
 * Keeps the pair to the open project: a project change (or closing it) resets it, a change of
 * the same project's captures updates the known ones. Returns the unsubscribe.
 */
export function followProject(
  store: StoreApi<CompareDatesState>,
  source: Pick<StoreApi<ProjectSource>, 'getState' | 'subscribe'>,
): () => void {
  const ids = (s: ProjectSource) => s.project?.manifest.captures.map((c) => c.id) ?? null;
  store.getState().setKnown(ids(source.getState()));
  return source.subscribe((s, prev) => {
    if ((s.project?.id ?? null) !== (prev.project?.id ?? null)) {
      store.getState().reset(ids(s));
      return;
    }
    if (s.project?.manifest.captures !== prev.project?.manifest.captures)
      store.getState().setKnown(ids(s));
  });
}

/**
 * The app's one compare pair. The app keeps it to the open project (`followProject` with the
 * workspace, wired where the shell loads: shell/Sidebar.tsx).
 */
export const compareDates = createCompareDates();
