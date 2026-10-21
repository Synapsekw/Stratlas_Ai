import type { MediaPick, MenuTarget, PhotoPick } from '@aio/ui';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { nextPicks } from '../builder/photoPicks';

/*
 * The photo tiles picked in Media: Ctrl toggles a tile, Shift adds the range from the last
 * clicked tile in tile order, a plain click picks one (the screen also selects it, as before). A
 * right-click on a picked tile acts on every pick (Edit position of several photos).
 */

const same = (a: PhotoPick, b: PhotoPick) => a.layerId === b.layerId && a.photoId === b.photoId;

export interface PickState {
  picks: PhotoPick[];
  /** Where a Shift range starts: the last tile clicked without Shift. */
  anchor: PhotoPick | null;
}

export interface ClickMods {
  ctrl: boolean;
  shift: boolean;
}

/** The picks after a click on `hit`; `order` is the tiles as shown, for a Shift range. */
export function clickPicks(
  s: PickState,
  hit: PhotoPick,
  mods: ClickMods,
  order: readonly PhotoPick[],
): PickState {
  if (mods.ctrl) return { picks: nextPicks(s.picks, hit, mods), anchor: hit };
  if (mods.shift) {
    const anchor = s.anchor;
    const from = anchor ? order.findIndex((p) => same(p, anchor)) : -1;
    const to = order.findIndex((p) => same(p, hit));
    if (from < 0 || to < 0) return { picks: nextPicks(s.picks, hit, mods), anchor: hit };
    const range = from <= to ? order.slice(from, to + 1) : order.slice(to, from + 1).reverse();
    const picks = range.reduce((acc, p) => nextPicks(acc, p, mods), s.picks);
    return { picks, anchor };
  }
  return { picks: [hit], anchor: hit };
}

/**
 * What a right-click on `hit` acts on: every pick when it is among them, else that tile alone (and
 * the picks are reset to it, `reset`).
 */
export function menuPicks(
  picks: readonly PhotoPick[],
  hit: PhotoPick,
): { picks: PhotoPick[]; reset: boolean } {
  return picks.some((p) => same(p, hit))
    ? { picks: [...picks], reset: false }
    : { picks: [hit], reset: true };
}

/**
 * The menu target of a tile: a photo among the picks targets every pick (Edit position of several
 * photos), another photo only itself; a 360 is `media`.
 */
export function tileTarget(k: MediaPick, picks: readonly PhotoPick[] = []): MenuTarget {
  if (k.kind !== 'photo') return { kind: 'media', picks: [k] };
  const hit = { layerId: k.layerId, photoId: k.itemId };
  return { kind: 'photos', picks: menuPicks(picks, hit).picks };
}

export interface MediaPicks extends PickState {
  /** The project the picks belong to: a click in another project starts afresh. */
  projectId: string | null;
  click(projectId: string, hit: PhotoPick, mods: ClickMods, order: readonly PhotoPick[]): void;
  reset(projectId: string, picks: readonly PhotoPick[]): void;
  clear(): void;
}

export const mediaPicks = createStore<MediaPicks>((set) => ({
  projectId: null,
  picks: [],
  anchor: null,
  click: (projectId, hit, mods, order) => {
    set((s) => {
      const from = s.projectId === projectId ? s : { picks: [], anchor: null };
      return { projectId, ...clickPicks(from, hit, mods, order) };
    });
  },
  reset: (projectId, picks) => {
    set({ projectId, picks: [...picks], anchor: picks[0] ?? null });
  },
  clear: () => {
    set({ projectId: null, picks: [], anchor: null });
  },
}));

export function useMediaPicks<T>(select: (s: MediaPicks) => T): T {
  return useStore(mediaPicks, select);
}

/** Whether a tile is among the picks of the project. */
export function isPicked(
  s: Pick<MediaPicks, 'projectId' | 'picks'>,
  projectId: string,
  hit: PhotoPick,
): boolean {
  return s.projectId === projectId && s.picks.some((p) => same(p, hit));
}
