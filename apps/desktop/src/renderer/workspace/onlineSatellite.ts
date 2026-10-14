/**
 * Switching online maps on and off from the renderer (ADR 0007, amendments of 10 and 14 Oct 2026),
 * for every place that offers it: Settings, Map sources, the Map menus of the three views and the
 * command palette. One switch (`rasterPacks.setOnline`, which asks main) and one notice per
 * provider: the first time a source of a provider is used, the person reads what is requested
 * and from whom, and nothing is switched on or fetched until they say yes
 * (`OnlineSatelliteNotice.tsx` shows it wherever the request came from).
 */
import {
  isOnlineBase,
  onlineSource,
  type BaseMapId,
  type OnlineProvider,
  type OnlineSourceId,
} from '@aio/schema';
import { createStore } from 'zustand/vanilla';
import { rasterPacks } from './siteTiles';

const NOTICE_KEY = 'stratlas.onlineNotice';
/** 0.11's flag: its notice named EOX only. */
const LEGACY_KEY = 'stratlas.onlineSatelliteNotice';

export function onlineNoticeSeen(provider: OnlineProvider = 'eox'): boolean {
  try {
    if (localStorage.getItem(`${NOTICE_KEY}.${provider}`) === '1') return true;
    return provider === 'eox' && localStorage.getItem(LEGACY_KEY) === '1';
  } catch {
    return false;
  }
}

function markNoticeSeen(provider: OnlineProvider): void {
  try {
    localStorage.setItem(`${NOTICE_KEY}.${provider}`, '1');
  } catch {
    // blocked storage: the notice shows again next time
  }
}

interface OnlineSwitch {
  /** The source whose provider's notice is open: the person asked for it and has not answered. */
  asking: OnlineSourceId | null;
  /** Why the last change did not happen, or null. */
  error: string | null;
  /**
   * Switch online maps on (for `source`, default the workstation's online satellite) or off. The
   * first use of a provider opens its notice instead and waits for `confirm`; `then` runs once
   * online maps are on.
   */
  request(on: boolean, source?: OnlineSourceId, then?: () => void): void;
  confirm(): void;
  cancel(): void;
}

export const onlineSatelliteSwitch = createStore<OnlineSwitch>()((set, get) => {
  let after: (() => void) | null = null;
  const apply = async (
    on: boolean,
    id: OnlineSourceId | undefined,
    then: (() => void) | null,
  ): Promise<void> => {
    // only an online satellite becomes the workstation's source; a Mapbox style is a view's pick
    const keep = id && onlineSource(id)?.group === 'satellite' ? { source: id } : {};
    const error = await rasterPacks
      .getState()
      .setOnline(on ? { enabled: true, ...keep } : { enabled: false });
    set({ error });
    if (error || !on) return;
    const provider = onlineSource(id ?? rasterPacks.getState().online.source)?.provider;
    if (provider) markNoticeSeen(provider);
    then?.();
  };
  return {
    asking: null,
    error: null,
    request(on, source, then) {
      if (!on) {
        after = null;
        set({ asking: null });
        void apply(false, undefined, null);
        return;
      }
      const id = source ?? rasterPacks.getState().online.source;
      if (!onlineNoticeSeen(onlineSource(id)?.provider ?? 'eox')) {
        after = then ?? null;
        set({ asking: id, error: null });
        return;
      }
      set({ asking: null });
      void apply(true, source, then ?? null);
    },
    confirm() {
      const id = get().asking;
      if (!id) return;
      const then = after;
      after = null;
      set({ asking: null });
      void apply(true, id, then);
    },
    cancel() {
      after = null;
      if (get().asking) set({ asking: null });
    },
  };
});

/**
 * Pick a base map in a view. An online source used for the first time asks (its provider's
 * notice) and switches online maps on; `apply` stores the view's choice once that is done.
 */
export function pickBase(id: BaseMapId, apply: (id: BaseMapId) => void): void {
  if (!isOnlineBase(id)) {
    apply(id);
    return;
  }
  const source = onlineSource(id);
  if (source && rasterPacks.getState().prefs.onlineSatellite && onlineNoticeSeen(source.provider)) {
    apply(id);
    return;
  }
  onlineSatelliteSwitch.getState().request(true, id, () => {
    apply(id);
  });
}
