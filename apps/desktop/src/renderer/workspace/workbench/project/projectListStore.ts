// Requests to Project > In this project from elsewhere: reveal a row (a pick in 3D, another tool
// asking for a review). A request made while the list is not mounted is honoured when it mounts
// (useRevealRow).
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { GroupId } from './projectGroups';

export interface RevealRequest {
  group: GroupId;
  /** The row to show; null holds the group open with nothing selected until the next reveal. */
  id: string | null;
  /** Grows with every request, so the same row revealed again scrolls again. */
  seq: number;
}

export interface ProjectListState {
  reveal: RevealRequest | null;
}

export const projectListStore = createStore<ProjectListState>()(() => ({
  reveal: null,
}));

/** Open a group (without changing the person's fold) and scroll its row into view. */
export function revealInList(group: GroupId, id: string | null): void {
  const prev = projectListStore.getState().reveal;
  projectListStore.setState({ reveal: { group, id, seq: (prev?.seq ?? 0) + 1 } });
}

export function useProjectList<T>(selector: (s: ProjectListState) => T): T {
  return useStore(projectListStore, selector);
}
