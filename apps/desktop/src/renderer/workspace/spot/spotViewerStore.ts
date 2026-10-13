import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SpotHistory, SpotMatch, SpotOpen } from './spotTypes';

/**
 * The spot viewer's own state (founder decision 2): what it shows, never the workspace's
 * selection, date or layers. Pure stepping helpers below; the dialog is SpotViewer.tsx.
 */
export interface SpotAt {
  capture: string;
  i: number;
}
export type SpotCompareMode = 'side' | 'swipe';
export interface SpotCompareState {
  mode: SpotCompareMode;
  left: SpotAt;
  right: SpotAt | null;
  /** Swipe position, 0 to 1. */
  amount: number;
}
export interface SpotViewerState {
  open: SpotOpen | null;
  /** Null: the start date (the clicked one). */
  at: SpotAt | null;
  compare: SpotCompareState | null;
  show(open: SpotOpen, at?: SpotAt): void;
  close(): void;
  goTo(at: SpotAt): void;
  setCompare(c: SpotCompareState | null): void;
}

export function createSpotViewer(): StoreApi<SpotViewerState> {
  return createStore<SpotViewerState>()((set) => ({
    open: null,
    at: null,
    compare: null,
    show: (open, at) => {
      set({ open, at: at ?? null, compare: null });
    },
    close: () => {
      set({ open: null, at: null, compare: null });
    },
    goTo: (at) => {
      set({ at });
    },
    setCompare: (compare) => {
      set({ compare });
    },
  }));
}
export const spotViewer = createSpotViewer();
export function openSpotHistory(open: SpotOpen, at?: SpotAt): void {
  spotViewer.getState().show(open, at);
}

const dateOf = (h: SpotHistory, capture: string) => h.dates.find((d) => d.capture === capture);

export function matchAt(h: SpotHistory, at: SpotAt | null): SpotMatch | undefined {
  return at ? dateOf(h, at.capture)?.matches[at.i] : undefined;
}

export function startAt(h: SpotHistory, capture: string | undefined): SpotAt | null {
  if (capture !== undefined && (dateOf(h, capture)?.matches.length ?? 0) > 0)
    return { capture, i: 0 };
  for (let k = h.dates.length - 1; k >= 0; k--) {
    const d = h.dates[k];
    if (d && d.matches.length > 0) return { capture: d.capture, i: 0 };
  }
  return null;
}

export function resolveAt(
  h: SpotHistory,
  at: SpotAt | null,
  capture: string | undefined,
): SpotAt | null {
  return matchAt(h, at) ? at : startAt(h, capture);
}

export function stepDate(h: SpotHistory, at: SpotAt | null, dir: 1 | -1): SpotAt | null {
  const from = at
    ? h.dates.findIndex((d) => d.capture === at.capture)
    : dir > 0
      ? -1
      : h.dates.length;
  for (let k = from + dir; k >= 0 && k < h.dates.length; k += dir) {
    const d = h.dates[k];
    if (d && d.matches.length > 0) return { capture: d.capture, i: 0 };
  }
  return at;
}

export function cycleMatch(h: SpotHistory, at: SpotAt | null, dir: 1 | -1): SpotAt | null {
  if (!at) return null;
  const n = dateOf(h, at.capture)?.matches.length ?? 0;
  return n === 0 ? at : { capture: at.capture, i: (((at.i + dir) % n) + n) % n };
}

export function defaultOther(h: SpotHistory, capture: string): SpotAt | null {
  const here = { capture, i: 0 };
  const before = stepDate(h, here, -1);
  if (before && before.capture !== capture) return before;
  const after = stepDate(h, here, 1);
  return after && after.capture !== capture ? after : null;
}
