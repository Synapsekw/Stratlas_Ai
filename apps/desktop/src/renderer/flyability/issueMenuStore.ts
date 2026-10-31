import { createStore } from 'zustand';

export interface IssueMenuAt {
  x: number;
  y: number;
  ids: string[];
  clicked: string;
}

/** The issue register's right-click menu: where it opened (null closed) and how many mounts show it. */
export const issueMenu = createStore<{ at: IssueMenuAt | null; mounted: number }>()(() => ({
  at: null,
  mounted: 0,
}));

/** Open the menu for the right-clicked issues; false when nothing is mounted to show it. */
export function openIssueMenu(at: IssueMenuAt): boolean {
  if (issueMenu.getState().mounted === 0) return false;
  issueMenu.setState({ at });
  return true;
}
