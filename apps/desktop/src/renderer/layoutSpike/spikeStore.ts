/**
 * The spike's own state, in memory only (no persistence: W13 adds `quadrion.layout.<id>`). It
 * never writes the workbench, island or shell stores' own state, except the stage mode a preset
 * picks and the stage's own video window, which the spike hides while its tile shows the clip.
 */
import type { ProjectPurpose } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import {
  sectionTab,
  type Band,
  type IslandMode,
  type LayoutDefaults,
  type PanelTab,
  type SectionId,
  type StripMode,
} from './model';

export type VideoMode = 'docked' | 'floating' | 'closed';

/** The popped-out window: its top left on the stage and its width (16:9 kept). */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
}

export interface SpikeState {
  /** The preset picked in the title bar; null: the project's own. */
  pick: ProjectPurpose | null;
  tab: PanelTab;
  open: Partial<Record<SectionId, boolean>>;
  strip: StripMode;
  stripFolded: boolean;
  video: VideoMode;
  rect: FloatRect | null;
  /** The Layers column opened or closed by hand; null: the band's default. */
  layers: boolean | null;
  islandOpen: boolean;
  islandMode: IslandMode;
  slots: boolean;
  rightPx: Partial<Record<Band, number>>;
  /** `<projectId>:<purpose>` of the defaults last applied. */
  applied: string | null;
  apply(key: string, d: LayoutDefaults): void;
  pickPreset(p: ProjectPurpose | null): void;
  setTab(tab: PanelTab): void;
  /** Bring a section forward: its tab in front, the section open. */
  show(id: SectionId): void;
  toggle(id: SectionId): void;
  setStrip(m: StripMode): void;
  foldStrip(on: boolean): void;
  setVideo(v: VideoMode): void;
  setRect(r: FloatRect | null): void;
  setLayers(on: boolean | null): void;
  setIsland(open: boolean, mode?: IslandMode): void;
  setSlots(on: boolean): void;
  setRight(band: Band, px: number): void;
}

export const spike = createStore<SpikeState>()((set, get) => ({
  pick: null,
  tab: 'selection',
  open: {},
  strip: 'dates',
  stripFolded: false,
  video: 'docked',
  rect: null,
  layers: null,
  islandOpen: false,
  islandMode: 'view',
  slots: false,
  rightPx: {},
  applied: null,
  apply: (key, d) => {
    set({
      applied: key,
      tab: d.tab,
      open: Object.fromEntries(d.open.map((id) => [id, true])),
      strip: d.strip,
      islandMode: d.islandMode,
      islandOpen: false,
      layers: null,
      // the tile follows the data, whatever the preset (D4, D7)
      video: d.video === 'docked' ? 'docked' : 'closed',
    });
  },
  pickPreset: (pick) => {
    set({ pick });
  },
  setTab: (tab) => {
    set({ tab });
  },
  show: (id) => {
    set({ tab: sectionTab(id), open: { ...get().open, [id]: true } });
  },
  toggle: (id) => {
    const open = get().open;
    set({ open: { ...open, [id]: !open[id] } });
  },
  setStrip: (strip) => {
    set({ strip, stripFolded: false });
  },
  foldStrip: (stripFolded) => {
    set({ stripFolded });
  },
  setVideo: (video) => {
    set({ video });
  },
  setRect: (rect) => {
    set({ rect });
  },
  setLayers: (layers) => {
    set({ layers });
  },
  setIsland: (islandOpen, mode) => {
    set(mode ? { islandOpen, islandMode: mode } : { islandOpen });
  },
  setSlots: (slots) => {
    set({ slots });
  },
  setRight: (band, px) => {
    set({ rightPx: { ...get().rightPx, [band]: px } });
  },
}));

export function useSpike<T>(selector: (s: SpikeState) => T): T {
  return useStore(spike, selector);
}
