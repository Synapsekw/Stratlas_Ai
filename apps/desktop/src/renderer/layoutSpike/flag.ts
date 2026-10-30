/**
 * The Wave 2 layout spike's switch (UI revision plan, W4, gate G1): a localStorage flag, off by
 * default. Ctrl+Alt+L turns it on or off, in `pnpm dev` and in packaged builds alike, and the
 * shell switches in place: the app refuses renderer navigations (main/index.ts `will-navigate`),
 * a reload among them, so the flag is a small store App re-renders from. The spike is deleted with
 * this file in W12.
 */
import { useEffect, useSyncExternalStore } from 'react';

export const LAYOUT_SPIKE_KEY = 'quadrion.flags.layoutV2';

type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storageOrNull(): FlagStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether the spike layout is on: only when the key holds "1". */
export function layoutSpikeOn(storage: FlagStorage | null = storageOrNull()): boolean {
  try {
    return storage?.getItem(LAYOUT_SPIKE_KEY) === '1';
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

/** Turn the flag over; returns the new value. Whoever reads `useLayoutSpike` re-renders. */
export function toggleLayoutSpike(storage: FlagStorage | null = storageOrNull()): boolean {
  const next = !layoutSpikeOn(storage);
  try {
    if (next) storage?.setItem(LAYOUT_SPIKE_KEY, '1');
    else storage?.removeItem(LAYOUT_SPIKE_KEY);
  } catch {
    // blocked storage: the flag stays as it was
    return !next;
  }
  for (const l of listeners) l();
  return next;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Ctrl+Alt+L (Cmd+Alt+L on macOS), without Shift. */
export function isSpikeToggle(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    e.altKey &&
    !e.shiftKey &&
    (e.code === 'KeyL' || e.key.toLowerCase() === 'l')
  );
}

/** The flag as App reads it, with the Ctrl+Alt+L listener that flips it. */
export function useLayoutSpike(): boolean {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSpikeToggle(e)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleLayoutSpike();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => layoutSpikeOn());
}
