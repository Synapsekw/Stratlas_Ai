/**
 * The Measure workbench's catalogue (stage island D12): every measuring tool in its family, with
 * a one-line hint and its key, and the person's favourites (a per-computer view preference, D17).
 * No React: the bench renders what this lists.
 */
import type { MeasurementTool } from '@aio/schema';
import { t, type ShortcutId } from '@aio/ui';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ProjectKind } from '../builder/model';
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

/** The catalogue's names for its tools: `measureCat.tool.<name>` and `measureCat.hint.<name>`. */
type ToolName =
  | 'elevation'
  | 'elevationDiff'
  | 'annotation'
  | 'distance'
  | 'grade'
  | 'vertexDiff'
  | 'berm'
  | 'crossSection'
  | 'area'
  | 'volume'
  | 'azimuth'
  | 'tilt'
  | 'clearance'
  | 'freehand'
  | 'sectionPlane';

// Names and hints are read when shown, in the language in use then (not once at load), and their
// keys are typed: a renamed key fails the typecheck.
const entry = (
  tool: CatalogueTool,
  name: ToolName,
  saves: boolean,
  key?: ShortcutId,
): CatalogueEntry => ({
  tool,
  get label() {
    return t(`measureCat.tool.${name}`);
  },
  get hint() {
    return t(`measureCat.hint.${name}`);
  },
  saves,
  ...(key ? { key } : {}),
});

const family = (id: FamilyId, tools: readonly CatalogueEntry[]): Family => ({
  id,
  get label() {
    return t(`measureCat.family.${id}`);
  },
  tools,
});

/** The D12 families in order; Distance and the section plane read without saving. */
export const FAMILIES: readonly Family[] = [
  family('point', [
    entry('elevation', 'elevation', true),
    entry('elevation-difference', 'elevationDiff', true),
    entry('annotation', 'annotation', true),
  ]),
  family('line', [
    entry('distance', 'distance', false, 'scene.measure'),
    entry('grade', 'grade', true),
    entry('vertex-table', 'vertexDiff', true),
    entry('berm-check', 'berm', true),
    entry('section', 'crossSection', true),
  ]),
  family('polygon', [entry('area', 'area', true), entry('volume', 'volume', true)]),
  family('telecom', [
    entry('azimuth', 'azimuth', true),
    entry('antenna-tilt', 'tilt', true),
    entry('clearance', 'clearance', true),
  ]),
  family('markup', [entry('freehand', 'freehand', true)]),
  family('section', [entry('section-plane', 'sectionPlane', false, 'scene.section')]),
];

/** Every catalogue entry, in the families' order. */
export const ALL_TOOLS: readonly CatalogueEntry[] = FAMILIES.flatMap((f) => f.tools);

export const entryOf = (tool: CatalogueTool): CatalogueEntry | undefined =>
  ALL_TOOLS.find((e) => e.tool === tool);

export const familyOf = (tool: CatalogueTool): FamilyId | undefined =>
  FAMILIES.find((f) => f.tools.some((e) => e.tool === tool))?.id;

/** The project kinds with no tower to measure: their catalogue has no Telecom family. */
const TOWERLESS: ReadonlySet<ProjectKind> = new Set(['survey', 'construction']);

/**
 * The families the open project offers: a read-only package only the tools that read without
 * saving (D6), a survey or construction project no Telecom family. Any other kind, or none known,
 * keeps it.
 */
export function familiesFor(readOnly: boolean, kind: ProjectKind | null = null): Family[] {
  const towerless = kind !== null && TOWERLESS.has(kind);
  return FAMILIES.filter((f) => !(towerless && f.id === 'telecom'))
    .map((f) => ({
      ...f,
      tools: readOnly ? f.tools.filter((e) => !e.saves) : [...f.tools],
    }))
    .filter((f) => f.tools.length > 0);
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
