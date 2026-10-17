/**
 * The Measure workbench's catalogue (stage island D12): every measuring tool in its family, with
 * a one-line hint and its key, and the person's favourites (a per-computer view preference, D17).
 * No React: the bench renders what this lists.
 */
import type { MeasurementTool } from '@aio/schema';
import { t, type MessageKey, type ShortcutId } from '@aio/ui';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { browserStorage } from '../workspace/stagePrefs';

/**
 * A catalogue tool: a survey tool, or the section plane. The section plane is not a survey
 * measurement, and `'section'` already names the Cross-section tool, so it has its own id.
 */
export type CatalogueTool = MeasurementTool | 'section-plane';

export type FamilyId = 'point' | 'line' | 'polygon' | 'telecom' | 'markup' | 'section';

export interface CatalogueEntry {
  tool: CatalogueTool;
  label: string;
  hint: string;
  key?: ShortcutId;
  /** The tool writes a measurement: hidden in a read-only package (D6). */
  saves: boolean;
}

export interface Family {
  id: FamilyId;
  label: string;
  tools: readonly CatalogueEntry[];
}

const entry = (
  tool: CatalogueTool,
  name: string,
  saves: boolean,
  key?: ShortcutId,
): CatalogueEntry => ({
  tool,
  label: t(`measureCat.tool.${name}` as MessageKey),
  hint: t(`measureCat.hint.${name}` as MessageKey),
  saves,
  ...(key ? { key } : {}),
});

/** The D12 families in order; Distance and the section plane read without saving. */
export const FAMILIES: readonly Family[] = [
  {
    id: 'point',
    label: t('measureCat.family.point'),
    tools: [
      entry('elevation', 'elevation', true),
      entry('elevation-difference', 'elevationDiff', true),
      entry('annotation', 'annotation', true),
    ],
  },
  {
    id: 'line',
    label: t('measureCat.family.line'),
    tools: [
      entry('distance', 'distance', false, 'scene.measure'),
      entry('grade', 'grade', true),
      entry('vertex-table', 'vertexDiff', true),
      entry('berm-check', 'berm', true),
      entry('section', 'crossSection', true),
    ],
  },
  {
    id: 'polygon',
    label: t('measureCat.family.polygon'),
    tools: [entry('area', 'area', true), entry('volume', 'volume', true)],
  },
  {
    id: 'telecom',
    label: t('measureCat.family.telecom'),
    tools: [
      entry('azimuth', 'azimuth', true),
      entry('antenna-tilt', 'tilt', true),
      entry('clearance', 'clearance', true),
    ],
  },
  {
    id: 'markup',
    label: t('measureCat.family.markup'),
    tools: [entry('freehand', 'freehand', true)],
  },
  {
    id: 'section',
    label: t('measureCat.family.section'),
    tools: [entry('section-plane', 'sectionPlane', false, 'scene.section')],
  },
];

/** Every catalogue entry, in the families' order. */
export const ALL_TOOLS: readonly CatalogueEntry[] = FAMILIES.flatMap((f) => f.tools);

export const entryOf = (tool: CatalogueTool): CatalogueEntry | undefined =>
  ALL_TOOLS.find((e) => e.tool === tool);

export const familyOf = (tool: CatalogueTool): FamilyId | undefined =>
  FAMILIES.find((f) => f.tools.some((e) => e.tool === tool))?.id;

/** The families a read-only package offers: only the tools that read without saving (D6). */
export function familiesFor(readOnly: boolean): Family[] {
  return FAMILIES.map((f) => ({
    ...f,
    tools: readOnly ? f.tools.filter((e) => !e.saves) : [...f.tools],
  })).filter((f) => f.tools.length > 0);
}

/** A tool's name matches the search (case-insensitive, on the name only, not the hint). */
export function matchesQuery(e: CatalogueEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || e.label.toLowerCase().includes(q);
}

// ---------------------------------------------------------------- favourites and recent

export const FAVOURITES_KEY = 'quadrion.measure.favourites';
/** The founder's quick tiles (16 Oct): Distance, Elevation, Area, Volume. */
export const DEFAULT_FAVOURITES: readonly CatalogueTool[] = [
  'distance',
  'elevation',
  'area',
  'volume',
];
const RECENT_MAX = 3;

export interface FavouritesState {
  favourites: readonly CatalogueTool[];
  /** The tools used last, newest first (this session only). */
  recent: readonly CatalogueTool[];
  toggle(tool: CatalogueTool): void;
  used(tool: CatalogueTool): void;
}

const known = new Set<string>(ALL_TOOLS.map((e) => e.tool));

function readFavourites(storage: Storage | null): readonly CatalogueTool[] {
  try {
    const raw = storage?.getItem(FAVOURITES_KEY);
    if (raw == null) return DEFAULT_FAVOURITES;
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return DEFAULT_FAVOURITES;
    return v.filter((x): x is CatalogueTool => typeof x === 'string' && known.has(x));
  } catch {
    return DEFAULT_FAVOURITES;
  }
}

export function createFavouritesStore(
  storage: Storage | null = browserStorage(),
): StoreApi<FavouritesState> {
  const store = createStore<FavouritesState>()((set, get) => ({
    favourites: readFavourites(storage),
    recent: [],
    toggle: (tool) => {
      const f = get().favourites;
      set({ favourites: f.includes(tool) ? f.filter((x) => x !== tool) : [...f, tool] });
    },
    used: (tool) => {
      set({ recent: [tool, ...get().recent.filter((x) => x !== tool)].slice(0, RECENT_MAX) });
    },
  }));
  store.subscribe((s, prev) => {
    if (s.favourites === prev.favourites) return;
    try {
      storage?.setItem(FAVOURITES_KEY, JSON.stringify(s.favourites));
    } catch {
      // private window or blocked storage: the stars are just not remembered
    }
  });
  return store;
}

export const measureFavourites = createFavouritesStore();

export function useFavourites<T>(selector: (s: FavouritesState) => T): T {
  return useStore(measureFavourites, selector);
}

/** Favourites first, then the recent tools not starred, each once. */
export function favouritesAndRecent(
  s: Pick<FavouritesState, 'favourites' | 'recent'>,
): CatalogueTool[] {
  return [...s.favourites, ...s.recent.filter((r) => !s.favourites.includes(r))];
}
