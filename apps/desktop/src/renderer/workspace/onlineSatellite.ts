/**
 * Switching online satellite on and off from the renderer (ADR 0007, amendment of 10 Oct 2026),
 * for every place that offers it: the checkbox in Settings, Offline maps, the row of the map type
 * picker and the command palette. One switch (`rasterPacks.setOnlineSatellite`, which asks main)
 * and one notice: the first time it is switched on, from any of them, the person reads what is
 * requested and from whom, and nothing is switched on or fetched until they say yes
 * (`OnlineSatelliteNotice.tsx` shows it wherever the request came from).
 */
import { createStore } from 'zustand/vanilla';
import { rasterPacks } from './siteTiles';

/** Whether the person has read what online satellite sends (shown the first time only). */
const NOTICE_KEY = 'stratlas.onlineSatelliteNotice';

export function onlineNoticeSeen(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function markNoticeSeen(): void {
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    // blocked storage: the notice shows again next time
  }
}

interface OnlineSwitch {
  /** The notice is open: the person asked to switch it on and has not answered yet. */
  asking: boolean;
  /** Why the last change did not happen, or null. */
  error: string | null;
  /** Switch it on or off. The first "on" opens the notice instead and waits for `confirm`. */
  request(on: boolean): void;
  /** The person's yes to the notice: switch it on. */
  confirm(): void;
  /** Close the notice without switching anything on. */
  cancel(): void;
}

export const onlineSatelliteSwitch = createStore<OnlineSwitch>()((set, get) => {
  const apply = async (on: boolean): Promise<void> => {
    const error = await rasterPacks.getState().setOnlineSatellite(on);
    set({ error });
    if (!error && on) markNoticeSeen();
  };
  return {
    asking: false,
    error: null,
    request(on) {
      if (on && !onlineNoticeSeen()) set({ asking: true, error: null });
      else {
        set({ asking: false });
        void apply(on);
      }
    },
    confirm() {
      if (!get().asking) return;
      set({ asking: false });
      void apply(true);
    },
    cancel() {
      if (get().asking) set({ asking: false });
    },
  };
});
