import type { PhotoPick } from '@aio/ui';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const same = (a: PhotoPick, b: PhotoPick) => a.layerId === b.layerId && a.photoId === b.photoId;

/** The picks after a Ctrl click (toggle) or a Shift click (add without removing). */
export function nextPicks(
  picks: readonly PhotoPick[],
  hit: PhotoPick,
  mods: { ctrl: boolean; shift: boolean },
): PhotoPick[] {
  const has = picks.some((p) => same(p, hit));
  if (mods.ctrl) return has ? picks.filter((p) => !same(p, hit)) : [...picks, hit];
  if (mods.shift && !has) return [...picks, hit];
  return [...picks];
}

export interface PhotoPicks {
  picks: PhotoPick[];
  toggle(p: PhotoPick): void;
  add(ps: readonly PhotoPick[]): void;
  clear(): void;
}

/** The photo pins picked on the map and in 3D; the photo right-click menu acts on them. */
export const photoPicks = createStore<PhotoPicks>((set) => ({
  picks: [],
  toggle: (p) => {
    set((s) => ({ picks: nextPicks(s.picks, p, { ctrl: true, shift: false }) }));
  },
  add: (ps) => {
    set((s) => ({
      picks: ps.reduce((acc, p) => nextPicks(acc, p, { ctrl: false, shift: true }), s.picks),
    }));
  },
  clear: () => {
    set({ picks: [] });
  },
}));

export function usePhotoPicks<T>(select: (s: PhotoPicks) => T): T {
  return useStore(photoPicks, select);
}
