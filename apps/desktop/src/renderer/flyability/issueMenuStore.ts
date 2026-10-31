import { createStore } from 'zustand';

export interface IssueMenuAt {
  x: number;
  y: number;
  ids: string[];
  clicked: string;
}

/** The issue register's right-click menu: where it opened (null closed). `IssueMenuMount` shows it. */
export const issueMenu = createStore<{ at: IssueMenuAt | null }>()(() => ({ at: null }));

export function openIssueMenu(at: IssueMenuAt): void {
  issueMenu.setState({ at });
}

export function closeIssueMenu(): void {
  issueMenu.setState({ at: null });
}
