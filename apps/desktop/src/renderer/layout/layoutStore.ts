/**
 * The person's layout choices per project (D7): what they moved away from the preset's default
 * (another tab, another strip, an island mode, Map or 3D, the Layers column in a wide window),
 * remembered in `quadrion.layout.<projectId>` and used on the next open. The video's place keeps
 * its own store (`videoDock`, D4); Reset clears both. Also the open-time requests the workspace
 * hands to parts that keep their own state (the island's mode).
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { ISLAND_MODES, type IslandMode } from '../tools/registry';
import { isPanelTab } from '../workspace/workbench/tabsModel';
import type { LayoutOverrides } from './applyPreset';

export const LAYOUT_KEY_PREFIX = 'quadrion.layout.';
export const layoutKey = (projectId: string): string => `${LAYOUT_KEY_PREFIX}${projectId}`;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const STRIPS = new Set(['dates', 'footage', 'volume', 'chainage']);
const STAGES = new Set(['3d', 'map']);

/** The saved choices, each checked; anything unreadable is left out. */
export function parseOverrides(raw: string | null | undefined): LayoutOverrides {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: LayoutOverrides = {};
  if (isPanelTab(o.rightTab)) out.rightTab = o.rightTab;
  if (typeof o.strip === 'string' && STRIPS.has(o.strip))
    out.strip = o.strip as NonNullable<LayoutOverrides['strip']>;
  if (
    typeof o.islandMode === 'string' &&
    (ISLAND_MODES as readonly string[]).includes(o.islandMode)
  )
    out.islandMode = o.islandMode as IslandMode;
  if (typeof o.stage === 'string' && STAGES.has(o.stage))
    out.stage = o.stage as NonNullable<LayoutOverrides['stage']>;
  if (typeof o.layersOpenWide === 'boolean') out.layersOpenWide = o.layersOpenWide;
  return out;
}

export interface LayoutPrefsState {
  /** The choices read or made this session, per project id. */
  byProject: Readonly<Record<string, LayoutOverrides>>;
  /** A project's choices: from memory, else read from storage once. */
  get(projectId: string): LayoutOverrides;
  /** As `get`, without keeping what it read (safe while rendering). */
  peek(projectId: string): LayoutOverrides;
  /** The person moved away from a default: remembered for this project. */
  choose(projectId: string, patch: LayoutOverrides): void;
  /** "Reset layout to project defaults": the project's choices go; `resetSeq` moves. */
  reset(projectId: string): void;
  /** Moves on every reset: the workspace applies the preset again. */
  resetSeq: number;
  /** The island's mode the workspace asks for on open (taken by the island). */
  islandAsk: { mode: IslandMode; seq: number } | null;
  askIsland(mode: IslandMode): void;
}

export function createLayoutPrefs(
  storage: KeyValue | null = browserStorage(),
): StoreApi<LayoutPrefsState> {
  const read = (id: string): LayoutOverrides => {
    try {
      return parseOverrides(storage?.getItem(layoutKey(id)));
    } catch {
      return {};
    }
  };
  const write = (id: string, o: LayoutOverrides) => {
    try {
      if (Object.keys(o).length === 0) storage?.removeItem(layoutKey(id));
      else storage?.setItem(layoutKey(id), JSON.stringify(o));
    } catch {
      // private window or blocked storage: the choice lasts for this session
    }
  };
  return createStore<LayoutPrefsState>()((set, get) => ({
    byProject: {},
    resetSeq: 0,
    islandAsk: null,
    get: (id) => {
      const known = get().byProject[id];
      if (known) return known;
      const o = read(id);
      set({ byProject: { ...get().byProject, [id]: o } });
      return o;
    },
    peek: (id) => get().byProject[id] ?? read(id),
    choose: (id, patch) => {
      const now = get().get(id);
      const next = { ...now, ...patch };
      if (JSON.stringify(next) === JSON.stringify(now)) return;
      set({ byProject: { ...get().byProject, [id]: next } });
      write(id, next);
    },
    reset: (id) => {
      set({ byProject: { ...get().byProject, [id]: {} }, resetSeq: get().resetSeq + 1 });
      write(id, {});
    },
    askIsland: (mode) => {
      set({ islandAsk: { mode, seq: (get().islandAsk?.seq ?? 0) + 1 } });
    },
  }));
}

export const layoutPrefs = createLayoutPrefs();

export function useLayoutPrefs<T>(selector: (s: LayoutPrefsState) => T): T {
  return useStore(layoutPrefs, selector);
}
