import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

interface RenameRequest {
  /** The dataset whose name field the sidebar should show, or null. */
  layerId: string | null;
  /** The measurement whose name field the tree should show, or null. */
  measureId: string | null;
  ask(id: string): void;
  askMeasure(id: string): void;
  done(): void;
}

/** Other parts of the window ask the sidebar to show a dataset's name field. */
export const renameRequest = createStore<RenameRequest>()((set) => ({
  layerId: null,
  measureId: null,
  ask: (id) => {
    set({ layerId: id, measureId: null });
  },
  askMeasure: (id) => {
    set({ measureId: id, layerId: null });
  },
  done: () => {
    set({ layerId: null, measureId: null });
  },
}));

export function useRenameRequest<T>(select: (s: RenameRequest) => T): T {
  return useStore(renameRequest, select);
}
