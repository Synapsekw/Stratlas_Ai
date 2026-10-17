import { useSyncExternalStore } from 'react';

/*
 * The opt-in landmark click of the Panoramas pane: while a line-up session is armed it sets a
 * callback here and the pane reports the compass bearing of a click, in the panorama's own frame
 * (`offsetDeg`); with none set the pane behaves as always. One module-level slot, like the other
 * transient workspace hooks, so the pins code needs no prop path into the split.
 */

export type PanoPick = (p: { layerId: string; panoId: string; offsetDeg: number }) => void;

let current: PanoPick | null = null;
const listeners = new Set<() => void>();

/** Arm (a function) or disarm (null) the landmark click. */
export function setPanoPick(fn: PanoPick | null): void {
  if (current === fn) return;
  current = fn;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The armed landmark callback, or null when no line-up asks for a click. */
export function usePanoPick(): PanoPick | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
