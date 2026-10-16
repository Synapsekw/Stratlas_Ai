import { useCallback } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { TabId } from './tabsModel';

// Which workbench sections are open, per tab, remembered on this computer (stage island D16).

interface BenchSections {
  /** What Collapse all / Expand all last set for sections not toggled since (absent: defaults). */
  all?: boolean;
  /** Sections the user toggled by hand. */
  ids: Record<string, boolean>;
}

const KEY = 'quadrion.sections';

function parseBench(v: unknown): BenchSections {
  const out: BenchSections = { ids: {} };
  if (!v || typeof v !== 'object') return out;
  const raw = v as Record<string, unknown>;
  if (typeof raw.all === 'boolean') out.all = raw.all;
  if (raw.ids && typeof raw.ids === 'object') {
    for (const [id, open] of Object.entries(raw.ids)) {
      if (typeof open === 'boolean') out.ids[id] = open;
    }
  }
  return out;
}

function parse(raw: string | null | undefined): Record<string, BenchSections> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, BenchSections> = {};
    for (const [bench, b] of Object.entries(v)) out[bench] = parseBench(b);
    return out;
  } catch {
    return {};
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface SectionState {
  byBench: Record<string, BenchSections>;
  toggle(bench: TabId, id: string, currentlyOpen: boolean): void;
  setAll(bench: TabId, open: boolean): void;
}

export function createSectionStore(
  storage: Storage | null = browserStorage(),
): StoreApi<SectionState> {
  let initial: Record<string, BenchSections> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with the defaults
  }
  const store = createStore<SectionState>()((set, get) => ({
    byBench: initial,
    toggle: (bench, id, currentlyOpen) => {
      const cur = get().byBench[bench] ?? { ids: {} };
      set({
        byBench: {
          ...get().byBench,
          [bench]: { ...cur, ids: { ...cur.ids, [id]: !currentlyOpen } },
        },
      });
    },
    setAll: (bench, open) => {
      set({ byBench: { ...get().byBench, [bench]: { all: open, ids: {} } } });
    },
  }));
  store.subscribe((s) => {
    try {
      storage?.setItem(KEY, JSON.stringify(s.byBench));
    } catch {
      // private window or blocked storage: the choice is just not remembered
    }
  });
  return store;
}

export const sectionStore = createSectionStore();

export interface Sections {
  /** A hand toggle, else Collapse/Expand all, else `defaultOpen` (collapsed when absent). */
  isOpen(id: string, defaultOpen?: boolean): boolean;
  toggle(id: string, defaultOpen?: boolean): void;
  collapseAll(): void;
  expandAll(): void;
}

export function useSections(bench: TabId): Sections {
  const b = useStore(sectionStore, (s) => s.byBench[bench]);
  const isOpen = useCallback(
    (id: string, defaultOpen = false) => b?.ids[id] ?? b?.all ?? defaultOpen,
    [b],
  );
  const toggle = useCallback(
    (id: string, defaultOpen = false) => {
      sectionStore.getState().toggle(bench, id, b?.ids[id] ?? b?.all ?? defaultOpen);
    },
    [bench, b],
  );
  const collapseAll = useCallback(() => {
    sectionStore.getState().setAll(bench, false);
  }, [bench]);
  const expandAll = useCallback(() => {
    sectionStore.getState().setAll(bench, true);
  }, [bench]);
  return { isOpen, toggle, collapseAll, expandAll };
}

/** Drops the empty sections; while a query is active the caller opens every one left. */
export function filterSections<T>(
  sections: readonly { id: string; items: readonly T[] }[],
  match: (t: T) => boolean,
): { id: string; items: T[] }[] {
  return sections
    .map((s) => ({ id: s.id, items: s.items.filter(match) }))
    .filter((s) => s.items.length > 0);
}
