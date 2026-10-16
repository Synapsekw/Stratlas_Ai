import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

interface RenameRequest {
  /** The dataset whose name field the sidebar should show, or null. */
  layerId: string | null;
  ask(id: string): void;
  done(): void;
}

/** Other parts of the window ask the sidebar to show a dataset's name field. */
export const renameRequest = createStore<RenameRequest>()((set) => ({
  layerId: null,
  ask: (id) => {
    set({ layerId: id });
  },
  done: () => {
    set({ layerId: null });
  },
}));

export function useRenameRequest<T>(select: (s: RenameRequest) => T): T {
  return useStore(renameRequest, select);
}
