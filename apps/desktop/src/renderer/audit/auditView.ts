import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { shell } from '../shell';

/** Whether the Audit trail is open (it shows in the Reports screen's viewer). */
export const auditView = createStore<{ open: boolean }>(() => ({ open: false }));

export function useAuditOpen(): boolean {
  return useStore(auditView, (s) => s.open);
}

/** Project menu or Reports: open the Audit trail of the open project. */
export function openAuditTrail(): void {
  auditView.setState({ open: true });
  shell.getState().go('reports');
}

export function closeAuditTrail(): void {
  auditView.setState({ open: false });
}
