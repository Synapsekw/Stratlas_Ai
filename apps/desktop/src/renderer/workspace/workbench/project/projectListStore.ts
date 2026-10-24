// Requests to the Project tab's list from elsewhere: reveal a row (a pick in 3D, another tool
// asking for a review) and scroll the TOOLS caption to the top (the island's Measure group).
// A request made while the list is not mounted is honoured when it mounts (useRevealRow,
// ProjectList).
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
  /** Grows with every tools-scroll request. */
  toolsSeq: number;
}

export const projectListStore = createStore<ProjectListState>()(() => ({
  reveal: null,
  toolsSeq: 0,
}));

/** Open a group (without changing the person's fold) and scroll its row into view. */
export function revealInList(group: GroupId, id: string | null): void {
  const prev = projectListStore.getState().reveal;
  projectListStore.setState({ reveal: { group, id, seq: (prev?.seq ?? 0) + 1 } });
}

/** Scroll the Project tab so its TOOLS caption is at the top. */
export function requestToolsScroll(): void {
  projectListStore.setState((s) => ({ toolsSeq: s.toolsSeq + 1 }));
}

export function useProjectList<T>(selector: (s: ProjectListState) => T): T {
  return useStore(projectListStore, selector);
}
