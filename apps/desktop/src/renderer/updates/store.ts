import type { WebsiteUpdateStatus } from '@aio/schema';
import { createStore } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
export type UpdateCommand = 'check' | 'restart' | 'signOut' | 'rollbackKit';
export interface WebsiteUpdates {
  status: WebsiteUpdateStatus | null;
  error: string | null;
  busy: boolean;
  start: () => () => void;
  command: (command: UpdateCommand) => Promise<void>;
}
/** One memory-only subscription for the whole window, independent of the Settings screen. */
export function createWebsiteUpdateStore(
  bridge: Bridge,
  listen?: (listener: (status: WebsiteUpdateStatus) => void) => () => void,
) {
  return createStore<WebsiteUpdates>()((set, get) => ({
    status: null,
    error: null,
    busy: false,
    start: () => {
      let live = true;
      let eventReceived = false;
      const stop = listen?.((status) => {
        if (!live) return;
        eventReceived = true;
        set({ status, error: null });
      });
      void bridge.call('websiteUpdate:status', {}).then((r) => {
        if (!live || eventReceived) return;
        if (r.ok) set({ status: r.value, error: null });
        else set({ error: r.error });
      });
      return () => {
        live = false;
        stop?.();
      };
    },
    command: async (command) => {
      if (get().busy) return;
      set({ busy: true, error: null });
      const r = await bridge.call(`websiteUpdate:${command}`, {});
      set({
        busy: false,
        error: !r.ok
          ? r.error
          : r.value.ok
            ? null
            : (r.value.error ?? 'The update action could not finish. Try again.'),
      });
    },
  }));
}
