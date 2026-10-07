import { createElement, useSyncExternalStore, type ComponentType } from 'react';
import { issueEditor, useIssueEditorState } from '../runtime';

/** What the app's History component receives for one issue. */
export interface IssueHistoryProps {
  projectId: string;
  issueId: string;
}

let registered: ComponentType<IssueHistoryProps> | null = null;
const listeners = new Set<() => void>();

/**
 * The app hands its journal-backed History (M9) to the issue detail here; this package cannot
 * import the app. Null puts the session-only list back.
 */
export function registerIssueHistory(component: ComponentType<IssueHistoryProps> | null): void {
  registered = component;
  for (const l of listeners) l();
}

function useRegistered(): ComponentType<IssueHistoryProps> | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => registered,
    () => registered,
  );
}

/** The editor's changes to one issue in this session (no journal: tests, tools, old builds). */
function SessionHistory({ issueId }: { issueId: string }) {
  // re-render on every editor commit
  useIssueEditorState();
  const audit = issueEditor.audit(issueId);
  if (audit.length === 0) return null;
  return (
    <>
      <div className="ann-faint">History this session</div>
      <ol className="ann-audit">
        {audit.map((a, i) => (
          <li key={i}>
            {a.at.slice(11, 19)} {a.author}: {a.action}
          </li>
        ))}
      </ol>
    </>
  );
}

/** History of one issue: the app's registered component, else this session's edits. */
export function IssueHistory({ projectId, issueId }: IssueHistoryProps) {
  const registeredHistory = useRegistered();
  // registered once at startup, so the component type is stable across renders
  if (registeredHistory) return createElement(registeredHistory, { projectId, issueId });
  return <SessionHistory issueId={issueId} />;
}
