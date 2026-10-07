import { issueEditor, useAnnotateReadOnly } from '@aio/annotate';
import { brand } from '@aio/brand';
import type { AuditEntry, Issue, RecordRef } from '@aio/schema';
import { announce, getLocale, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { auditApi, type AuditApi } from './api';
import {
  actorLabel,
  actorsSeen,
  entryLabel,
  fieldLabel,
  fieldList,
  flatten,
  formatValue,
  formatWhen,
  howLabel,
  redactedLabel,
  restorePlan,
  restoreText,
  stateLabel,
  touches,
  type RestorePlan,
} from './auditModel';
import './audit.css';

/** Most entries one History panel reads (a busy issue has dozens, not thousands). */
const HISTORY_LIMIT = 500;

/** The locale for dates and lists: British English for the English catalogue. */
export function uiLocale(): string {
  const l = getLocale();
  return l === 'en' ? 'en-GB' : l;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; entries: AuditEntry[]; off: boolean }
  | { status: 'error'; error: string };

/** Read and keep fresh the History of one record (journal:history, newest first). */
export function useHistory(projectId: string, target: RecordRef, api: AuditApi): Load {
  const { rec, id } = target;
  const key = `${projectId}
${rec}
${id}`;
  // the answer is kept with the record it is for: another record reads "loading" until it lands
  const [state, setState] = useState<{ key: string; load: Load } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    let latest = 0;
    const reload = () => {
      const mine = ++latest;
      void api
        .call('journal:history', {
          projectId,
          filter: { target: { rec, id } },
          limit: HISTORY_LIMIT,
        })
        .then((res) => {
          if (!live || mine !== latest) return;
          const r = flatten(res);
          setState({
            key,
            load: r.ok
              ? { status: 'ready', entries: r.value.entries, off: r.value.off === true }
              : { status: 'error', error: r.error },
          });
        });
    };
    reload();
    const stopChanged = api.onJournalChanged((e) => {
      if (e.projectId === projectId && touches(e.records, { rec, id })) reload();
    });
    const stopSaved = rec === 'issue' ? api.onIssuesSaved(reload) : () => undefined;
    return () => {
      live = false;
      stopChanged();
      stopSaved();
    };
  }, [api, projectId, rec, id, key]);

  return state?.key === key ? state.load : { status: 'loading' };
}

/** Put an entry's `before` values back through the issue editor, as a new change. */
export function applyRestore(issueId: string, plan: RestorePlan): string | null {
  if (Object.keys(plan.patch).length > 0) {
    const r = issueEditor.update(issueId, plan.patch);
    if (!r.ok) return r.error;
  }
  if (plan.status) {
    const r = issueEditor.setStatusMany([issueId], plan.status);
    const skipped = r.skipped[0];
    if (skipped) return skipped.error;
  }
  return null;
}

function Changes({ changes }: { changes: NonNullable<AuditEntry['changes']> }) {
  const t = useT();
  return (
    <ul className="aud-changes">
      {changes.map((c, i) => {
        const before = formatValue(c.before);
        const after = formatValue(c.after);
        return (
          <li key={`${c.field}-${String(i)}`}>
            <span className="aud-field">{fieldLabel(c.field)}</span>{' '}
            <span className="aud-before mono" title={before} dir="auto">
              {before}
            </span>{' '}
            <span className="faint">{t('audit.change.to')}</span>{' '}
            <span className="aud-after mono" title={after} dir="auto">
              {after}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One History or Audit row: what, who, when, how, before and after, and its state. */
export function EntryBody({
  entry,
  names,
  record,
}: {
  entry: AuditEntry;
  names: ReadonlyMap<string, string>;
  /** The record's short name, shown on the Audit screen (History knows its record). */
  record?: string;
}) {
  const t = useT();
  const locale = uiLocale();
  const state = stateLabel(entry.state);
  return (
    <>
      <div className="aud-row-h">
        {record !== undefined && <span className="aud-record mono">{record}</span>}
        <b className="aud-label" dir="auto">
          {entryLabel(entry)}
        </b>
        {state && (
          <span
            className={`aud-badge ${entry.state}`}
            title={entry.state === 'quarantined' ? t('audit.state.quarantinedTip') : undefined}
          >
            {state}
          </span>
        )}
      </div>
      <div className="aud-meta">
        <span dir="auto">{actorLabel(entry.actor)}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={entry.at}>{formatWhen(entry.at, locale)}</time>
        <span aria-hidden="true"> · </span>
        <span>{howLabel(entry, brand.productName)}</span>
      </div>
      {entry.changes && entry.changes.length > 0 && <Changes changes={entry.changes} />}
      {entry.redacted && (
        <p className="aud-redacted">{redactedLabel(entry.redacted, names, locale)}</p>
      )}
    </>
  );
}

function RestoreButton({ entry, issue }: { entry: AuditEntry; issue: Issue }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const plan = restorePlan(entry.changes, issue);
  if (!plan) return null;
  const label = restoreText(issue.code, plan.fields, uiLocale());
  return (
    <div className="aud-acts">
      <button
        type="button"
        className="btn ghost sm"
        data-testid="history-restore"
        aria-label={label}
        title={t('audit.restore.tip')}
        onClick={() => {
          const failed = applyRestore(issue.id, plan);
          setError(failed);
          if (!failed) {
            announce(
              t('audit.restore.done', {
                code: issue.code,
                fields: fieldList(plan.fields, uiLocale()),
              }),
            );
          }
        }}
      >
        {t('audit.restore')}
      </button>
      {error && (
        <span className="aud-quiet" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * History of one record (issue, change item, detection pass, part), newest first. Issue rows can
 * be restored: the earlier values go back through the issue editor as a new change.
 */
export function HistoryPanel({
  projectId,
  target,
  api = auditApi(),
}: {
  projectId: string;
  target: RecordRef;
  api?: AuditApi;
}) {
  const t = useT();
  const load = useHistory(projectId, target, api);
  const readOnly = useAnnotateReadOnly();
  const issue = useWorkspace((s) =>
    target.rec === 'issue' ? s.issues.find((i) => i.id === target.id) : undefined,
  );
  const entries = load.status === 'ready' ? load.entries : null;
  const names = useMemo(() => actorsSeen(entries ?? []), [entries]);
  if (!projectId) return null;

  return (
    <section className="aud-history" data-testid="history-panel" aria-labelledby="aud-history-h">
      <h4 id="aud-history-h" className="aud-h">
        {t('audit.history.title')}
      </h4>
      {load.status === 'loading' && <p className="aud-quiet">{t('audit.history.loading')}</p>}
      {load.status === 'error' && (
        <p className="aud-quiet" data-testid="history-error">
          {load.error}
        </p>
      )}
      {load.status === 'ready' && load.off && (
        <p className="aud-quiet" data-testid="history-off">
          {t('audit.history.off')}
        </p>
      )}
      {load.status === 'ready' && !load.off && load.entries.length === 0 && (
        <p className="aud-quiet" data-testid="history-empty">
          {t('audit.history.empty')}
        </p>
      )}
      {load.status === 'ready' && load.entries.length > 0 && (
        <ol className="aud-list" aria-label={t('audit.history.list')}>
          {load.entries.map((e) => (
            <li key={e.op} className="aud-row" data-testid="history-entry">
              <EntryBody entry={e} names={names} />
              {issue && !readOnly && e.changes && e.changes.length > 0 && (
                <RestoreButton entry={e} issue={issue} />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The issue slot of `@aio/annotate` (`registerIssueHistory`): History of one issue. */
export function IssueHistoryPanel({ projectId, issueId }: { projectId: string; issueId: string }) {
  const target = useMemo(() => ({ rec: 'issue', id: issueId }), [issueId]);
  return <HistoryPanel projectId={projectId} target={target} />;
}
