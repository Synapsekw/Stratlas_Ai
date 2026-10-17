/**
 * What the workbench drawer is doing (Drawer.tsx), kept outside the component so the collapsed
 * sidebar can step aside while the drawer shows the bench (stage island I-R38: one live copy of
 * each bench, so no duplicate test ids and no bench effect running twice).
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** `live`: a tool the person started opened it; `click`: the person opened it from the island. */
export type DrawerOpened = 'live' | 'click';

export interface DrawerState {
  opened: DrawerOpened | null;
  /** The drawer is on screen, sliding out included: the sidebar leaves its bench to it. */
  present: boolean;
  open(by: DrawerOpened): void;
  close(): void;
  setPresent(on: boolean): void;
}

export function createDrawerStore(): StoreApi<DrawerState> {
  return createStore<DrawerState>()((set) => ({
    opened: null,
    present: false,
    open: (by) => {
      set((s) => (s.opened === null ? { opened: by } : {}));
    },
    close: () => {
      set({ opened: null });
    },
    setPresent: (on) => {
      set({ present: on });
    },
  }));
}

export const drawerStore = createDrawerStore();

/** Open the drawer for the person (an island open while the sidebar is hidden, I-R40). */
export function openDrawer(): void {
  drawerStore.getState().open('click');
}

export function useDrawer<T>(selector: (s: DrawerState) => T): T {
  return useStore(drawerStore, selector);
}
