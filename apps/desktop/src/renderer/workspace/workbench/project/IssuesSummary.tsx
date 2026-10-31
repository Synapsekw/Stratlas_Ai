/**
 * Project > Issues (UI revision D8): a summary, not a second register. Counts of open issues by
 * severity, the five most severe open ones (a click selects it on the stage and shows its card in
 * Selection) and "Open in Issues", which goes to the Issues screen, the one full register.
 */
import type { Issue } from '@aio/schema';
import { Button, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { shell } from '../../../shell';
import { workbench } from '../workbenchStore';
import './issuesSummary.css';

type Severity = Issue['severity'];

export interface IssuesSummaryModel {
  /** Open issues per severity, most severe first. */
  counts: { severity: Severity; count: number }[];
  /** The five most severe open issues, most severe first (ties: newest first). */
  top: Issue[];
  open: number;
}

/** "Uncertain" ranks below every graded severity. */
const rank = (s: Severity): number => (s === 'uncertain' ? -1 : s);

/** The summary of a project's issues (pure). Closed issues are left out. */
export function summariseIssues(issues: readonly Issue[], limit = 5): IssuesSummaryModel {
  const open = issues.filter((i) => i.status !== 'closed');
  const by = new Map<Severity, number>();
  for (const i of open) by.set(i.severity, (by.get(i.severity) ?? 0) + 1);
  const counts = [...by.entries()]
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => rank(b.severity) - rank(a.severity));
  const top = [...open]
    .sort((a, b) => rank(b.severity) - rank(a.severity) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
  return { counts, top, open: open.length };
}

export function IssuesSummary() {
  const t = useT();
  const issues = useWorkspace((s) => s.issues);
  const { counts, top, open } = summariseIssues(issues);
  const sev = (s: Severity) =>
    s === 'uncertain' ? t('wb.issues.uncertain') : t('wb.issues.severity', { n: s });
  return (
    <div className="wb-issues" data-testid="issues-summary">
      {open === 0 ? (
        <p className="wb-issues-none">{t('wb.issues.none')}</p>
      ) : (
        <>
          <p className="wb-issues-counts" aria-label={t('wb.issues.counts')}>
            {counts.map(({ severity, count }) => (
              <span key={String(severity)} className="wb-issues-count">
                {sev(severity)} <b>{count}</b>
              </span>
            ))}
          </p>
          <ul className="wb-issues-list">
            {top.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="wb-issues-row"
                  onClick={() => {
                    workspace.getState().select({ kind: 'issue', id: i.id });
                    workbench.getState().show('selection');
                  }}
                >
                  <span className="wb-issues-sev">{sev(i.severity)}</span>
                  <span className="mono">{i.code}</span>
                  <span className="wb-issues-title">{i.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button
        variant="quiet"
        onClick={() => {
          shell.getState().go('issues');
        }}
      >
        {t('wb.issues.open')}
      </Button>
    </div>
  );
}
