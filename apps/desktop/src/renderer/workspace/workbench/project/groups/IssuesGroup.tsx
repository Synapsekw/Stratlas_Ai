/**
 * The Issues group of the "In this project" list: each issue with its code and title, severity and
 * status. A click (or the Open button) selects the issue, which brings the Selection tab with the
 * Issue card, as every other way into an issue does; there is no editor here, so an issue has one
 * place to be edited.
 */
import { severityLabel } from '@aio/annotate';
import type { Issue } from '@aio/schema';
import { EmptyState, IconButton, Row, useT, type MessageKey } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import type { ReactElement } from 'react';
import type { ProjectGroupDef } from '../groupRegistry';
import './groups.css';

const STATUS_KEYS: Record<Issue['status'], MessageKey> = {
  draft: 'card.status.draft',
  reviewed: 'card.status.reviewed',
  approved: 'card.status.approved',
  closed: 'card.status.closed',
};

function open(id: string): void {
  workspace.getState().select({ kind: 'issue', id });
}

function useSelectedIssue(): string | null {
  return useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
}

function Body(): ReactElement {
  const t = useT();
  const issues = useWorkspace((s) => s.issues);
  const models = useWorkspace((s) => s.project?.manifest.severityModels);
  const current = useSelectedIssue();
  if (issues.length === 0) return <EmptyState title={t('project.issues.none')} />;
  return (
    <ul className="pl-rows" data-testid="project-issues">
      {issues.map((i) => {
        const sev = severityLabel(
          models?.find((m) => m.id === i.severityModelId),
          i.severity,
        );
        return (
          <li key={i.id} data-row-id={i.id}>
            <Row
              kind="tree"
              icon="flag"
              label={
                <>
                  {`${i.code} ${i.title}`}
                  <span className="pl-sub">
                    {[sev, t(STATUS_KEYS[i.status])].filter((x) => x !== '').join(', ')}
                  </span>
                </>
              }
              selected={current === i.id}
              data-testid="project-issue-row"
              tabIndex={0}
              onClick={() => {
                open(i.id);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(i.id);
                }
              }}
              actions={
                <IconButton
                  icon="chev-r"
                  label={t('project.issues.open')}
                  onClick={(e) => {
                    e.stopPropagation();
                    open(i.id);
                  }}
                />
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

export const issuesGroup: ProjectGroupDef = {
  id: 'issues',
  title: 'project.group.issues',
  useCount: () => useWorkspace((s) => s.issues.length),
  useApplies: () => true,
  useSelected: useSelectedIssue,
  Body,
};
