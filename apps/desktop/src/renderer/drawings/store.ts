import type { Vec3 } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { PlacePair } from './model';

/** A PDF of several pages waiting for the person to say which pages become drawings. */
export interface PagePrompt {
  name: string;
  pages: number;
  /** The chosen pages (1-based), or null to bring in none. */
  answer: (pages: number[] | null) => void;
}

/** What `drawings/<stem>/placement.json` says about a picture drawing. */
export interface DrawingPlaced {
  /** Still on its provisional placement: not placed. */
  provisional: boolean;
  /** Pixel size of its picture. */
  size: { width: number; height: number };
}

/** The place tool at work on one drawing: pairs of a drawing pixel and its true spot. */
export interface PlaceSession {
  layerId: string;
  pairs: PlacePair[];
  /** The drawing point picked last, waiting for its spot on the site. */
  pending: [number, number] | null;
}

export interface DrawingsState {
  pagePrompt: PagePrompt | null;
  /** The plan layer whose row shows its controls in the Datasets list. */
  controls: string | null;
  /** Picture drawings by plan layer, from their placement files (DXF drawings are not listed). */
  placed: Readonly<Record<string, DrawingPlaced>>;
  place: PlaceSession | null;
}

export interface DrawingsActions {
  toggleControls(layerId: string): void;
  startPlace(layerId: string): void;
  stopPlace(): void;
  /** A click on the drawing: the pixel the next site point belongs to. */
  pickDrawing(px: [number, number]): void;
  /** The true spot of the pending drawing point. */
  addSite(local: Vec3, horizontalOnly: boolean): void;
  removePair(index: number): void;
}

export type Drawings = DrawingsState & DrawingsActions;

const initial: DrawingsState = { pagePrompt: null, controls: null, placed: {}, place: null };

export function createDrawings() {
  return createStore<Drawings>()((set, get) => ({
    ...initial,
    toggleControls: (layerId) => {
      set({ controls: get().controls === layerId ? null : layerId });
    },
    startPlace: (layerId) => {
      set({ place: { layerId, pairs: [], pending: null } });
    },
    stopPlace: () => {
      set({ place: null });
    },
    pickDrawing: (px) => {
      const place = get().place;
      if (place) set({ place: { ...place, pending: px } });
    },
    addSite: (local, horizontalOnly) => {
      const place = get().place;
      if (!place?.pending) return;
      const pair: PlacePair = {
        px: place.pending,
        local,
        ...(horizontalOnly ? { horizontalOnly: true } : {}),
      };
      set({ place: { ...place, pairs: [...place.pairs, pair], pending: null } });
    },
    removePair: (index) => {
      const place = get().place;
      if (place) set({ place: { ...place, pairs: place.pairs.filter((_, i) => i !== index) } });
    },
  }));
}

/** The app-wide drawings store. Tests create their own with `createDrawings()`. */
export const drawings = createDrawings();

export function useDrawings<T>(selector: (s: Drawings) => T): T {
  return useStore(drawings, selector);
}

/** Layer ids of the drawings that are not placed yet (their rows say so). */
export function unplacedOf(placed: Readonly<Record<string, DrawingPlaced>>): Set<string> {
  return new Set(
    Object.entries(placed)
      .filter(([, p]) => p.provisional)
      .map(([id]) => id),
  );
}

/** Back to nothing open: a tool, a prompt and the flags belong to their project. */
export function resetDrawings(): void {
  drawings.getState().pagePrompt?.answer(null);
  drawings.setState(initial);
}
