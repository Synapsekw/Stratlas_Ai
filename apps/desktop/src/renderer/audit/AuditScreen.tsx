import { useAnnotateReadOnly } from '@aio/annotate';
import { brand } from '@aio/brand';
import type {
  AuditEntry,
  AuditExportFormat,
  AuditFilter,
  ChangeHow,
  VerifyReport,
} from '@aio/schema';
import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { auditApi, type AuditApi } from './api';
import {
  actorsSeen,
  buildFilter,
  COUNT_KEYS,
  EMPTY_FILTER_FORM,
  flatten,
  formatWhen,
  groupLabel,
  HOW_FILTERS,
  howFilterLabel,
  KIND_GROUP_IDS,
  matchesRecordText,
  problemText,
  recordLabel,
  verifyClean,
  verifyHeadline,
  type AuditFilterForm,
  type KindGroup,
} from './auditModel';
import { EntryBody, uiLocale } from './HistoryPanel';
import './audit.css';

/** Entries per page of the Audit trail. */
const PAGE = 100;
/** Typing in the Record box waits this long before the list reloads. */
const RECORD_DELAY_MS = 300;

type List =
  | { status: 'loading' }
  | { status: 'ready'; entries: AuditEntry[]; cursor: string | null; off: boolean; more: boolean }
  | { status: 'error'; error: string };

type Verify =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; report: VerifyReport }
  | { status: 'error'; error: string };

type Exported = { kind: 'saved'; text: string } | { kind: 'error'; text: string } | null;

function VerifyResult({ verify }: { verify: Verify }) {
  const t = useT();
  if (verify.status === 'idle') return null;
  if (verify.status === 'running')
    return (
      <p className="aud-quiet" role="status" data-testid="audit-verify-result">
        {t('audit.verifying')}
      </p>
    );
  if (verify.status === 'error')
    return (
      <p className="aud-quiet" role="status" data-testid="audit-verify-result">
        {verify.error}
      </p>
    );
  const { report } = verify;
  const clean = verifyClean(report);
  return (
    <section
      className={`aud-verify ${clean ? 'ok' : 'bad'}`}
      data-testid="audit-verify-result"
      aria-labelledby="aud-verify-h"
    >
      <h3 id="aud-verify-h" className="sr-only">
        {t('audit.verify.title')}
      </h3>
      <p className="aud-verify-head" role="status">
        <Icon name={clean ? 'check' : 'bell'} size={14} />
        {verifyHeadline(report)}
      </p>
      {!clean && (
        <dl className="aud-counts">
          {(Object.keys(COUNT_KEYS) as (keyof typeof COUNT_KEYS)[]).map((k) => (
            <div key={k}>
              <dt>{t(COUNT_KEYS[k])}</dt>
              <dd className="mono">{report.counts[k]}</dd>
            </div>
          ))}
        </dl>
      )}
      {report.problems.length > 0 && (
        <ol className="aud-problems" aria-label={t('audit.verify.problemList')}>
          {report.problems.map((p, i) => (
            <li
              key={`${p.code}-${p.file ?? ''}-${String(p.line ?? i)}`}
              data-testid="audit-problem"
            >
              <span className="aud-code mono">{p.code}</span>{' '}
              <span dir="auto">{problemText(p)}</span>
              {p.message && <span className="aud-detail faint">{p.message}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="faint small">
        {t('audit.verify.checked', { date: formatWhen(report.checkedAt, uiLocale()) })}
      </p>
    </section>
  );
}

function RedactDialog({
  onCancel,
  onConfirm,
  busy,
  error,
}: {
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true, { onEscape: onCancel });
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="aud-redact-h"
        aria-describedby="aud-redact-text"
        data-testid="audit-redact-dialog"
      >
        <div className="dlg-h">
          <Icon name="x" size={16} />
          <h2 id="aud-redact-h">{t('audit.redact.title')}</h2>
        </div>
        <div className="dlg-b">
          <p id="aud-redact-text" className="help">
            {t('audit.redact.text')}
          </p>
          <label className="aud-field-l">
            <span>{t('audit.redact.reason')}</span>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </label>
          {error && (
            <p className="prov-err" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
            {t('audit.redact.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            data-testid="audit-redact-confirm"
            onClick={() => {
              onConfirm(reason.trim());
            }}
          >
            {t('audit.redact.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The project's Audit trail: every journal entry, filtered by who, what, record, time and how,
 * paged with the response cursor; Verify; CSV and JSON exports of the current filter.
 */
export function AuditScreen({
  projectId,
  onClose,
  api = auditApi(),
}: {
  projectId: string;
  onClose?: () => void;
  api?: AuditApi;
}) {
  const t = useT();
  const issues = useWorkspace((s) => s.issues);
  const projectName = useWorkspace((s) => s.project?.manifest.name);
  const readOnly = useAnnotateReadOnly();

  const [form, setForm] = useState<AuditFilterForm>(EMPTY_FILTER_FORM);
  // the Record box reloads after a short pause in typing
  const [recordText, setRecordText] = useState('');
  useEffect(() => {
    if (recordText === form.record) return;
    const timer = setTimeout(() => {
      setForm((f) => ({ ...f, record: recordText }));
    }, RECORD_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [recordText, form.record]);

  const filter = useMemo(() => buildFilter(form, issues), [form, issues]);
  const filterKey = JSON.stringify(filter);

  const listKey = `${projectId}
${filterKey}`;
  // pages are kept with the filter they answer: a new filter reads "loading" until it lands
  const [state, setState] = useState<{ key: string; list: List } | null>(null);
  const list: List = state?.key === listKey ? state.list : { status: 'loading' };
  const [actors, setActors] = useState<Map<string, string>>(new Map());
  /** Load the first page (null) or the page after a cursor; set by the effect below. */
  const loadPage = useRef<(cursor: string | null) => void>(() => undefined);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    let latest = 0;
    const load = (cursor: string | null) => {
      const mine = ++latest;
      void api
        .call('journal:history', {
          projectId,
          filter: JSON.parse(filterKey) as AuditFilter,
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        })
        .then((res) => {
          if (!live || mine !== latest) return;
          const r = flatten(res);
          if (!r.ok) {
            setState({ key: listKey, list: { status: 'error', error: r.error } });
            return;
          }
          const { entries, cursor: next, off } = r.value;
          setActors((a) => actorsSeen(entries, a));
          setState((prev) => {
            const before = prev?.key === listKey && prev.list.status === 'ready' ? prev.list : null;
            return {
              key: listKey,
              list: {
                status: 'ready',
                entries: cursor && before ? [...before.entries, ...entries] : entries,
                cursor: next,
                off: off === true,
                more: false,
              },
            };
          });
        });
    };
    loadPage.current = load;
    load(null);
    const stopChanged = api.onJournalChanged((e) => {
      if (e.projectId === projectId) load(null);
    });
    const stopSaved = api.onIssuesSaved(() => {
      load(null);
    });
    return () => {
      live = false;
      loadPage.current = () => undefined;
      stopChanged();
      stopSaved();
    };
  }, [api, projectId, filterKey, listKey]);

  const [verify, setVerify] = useState<Verify>({ status: 'idle' });
  const runVerify = () => {
    setVerify({ status: 'running' });
    void api.call('journal:verify', { projectId }).then((res) => {
      const r = flatten(res);
      setVerify(
        r.ok ? { status: 'done', report: r.value.report } : { status: 'error', error: r.error },
      );
    });
  };

  const [exporting, setExporting] = useState<AuditExportFormat | null>(null);
  const [exported, setExported] = useState<Exported>(null);
  const runExport = (format: AuditExportFormat) => {
    setExporting(format);
    setExported(null);
    void api.call('audit:export', { projectId, format, filter }).then((res) => {
      setExporting(null);
      const r = flatten(res);
      if (!r.ok) setExported({ kind: 'error', text: r.error });
      else if (r.value.path)
        setExported({
          kind: 'saved',
          text: t('audit.export.saved', { count: r.value.count, path: r.value.path }),
        });
    });
  };

  const [redacting, setRedacting] = useState<AuditEntry | null>(null);
  const [redactBusy, setRedactBusy] = useState(false);
  const [redactError, setRedactError] = useState<string | null>(null);
  const redact = (reason: string) => {
    if (!redacting) return;
    setRedactBusy(true);
    setRedactError(null);
    void api
      .call('journal:redact', {
        projectId,
        op: redacting.op,
        ...(reason ? { reason } : {}),
      })
      .then((res) => {
        setRedactBusy(false);
        const r = flatten(res);
        if (!r.ok) {
          setRedactError(r.error);
          return;
        }
        setRedacting(null);
        loadPage.current(null);
      });
  };

  const set = <K extends keyof AuditFilterForm>(key: K, value: AuditFilterForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };
  const filtered = recordText !== '' || Object.values(form).some((v) => v !== '');
  const shown =
    list.status === 'ready'
      ? list.entries.filter((e) => matchesRecordText(e, form.record, issues))
      : [];
  const product = brand.productName;

  return (
    <section className="aud-screen" data-testid="audit-screen" aria-labelledby="aud-screen-h">
      <div className="panel-h">
        <h2 id="aud-screen-h">
          <Icon name="history" size={14} />
          {t('audit.title')}
        </h2>
        {projectName && (
          <span className="sub" dir="auto">
            {projectName}
          </span>
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn sm"
          data-testid="audit-verify"
          disabled={verify.status === 'running'}
          onClick={runVerify}
        >
          <Icon name="check" size={14} />
          {t('audit.verify')}
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="audit-export-csv"
          disabled={exporting !== null}
          onClick={() => {
            runExport('audit-csv');
          }}
        >
          <Icon name="download" size={14} />
          {exporting === 'audit-csv' ? t('audit.exporting') : t('audit.export.csv')}
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="audit-export-json"
          disabled={exporting !== null}
          onClick={() => {
            runExport('audit-json');
          }}
        >
          <Icon name="download" size={14} />
          {exporting === 'audit-json' ? t('audit.exporting') : t('audit.export.json')}
        </button>
        {onClose && (
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('audit.close')}
            title={t('audit.close')}
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div className="aud-body">
        <p className="muted aud-lead">{t('audit.lead')}</p>
        <div className="aud-status" aria-live="polite">
          {exported && (
            <p
              className={exported.kind === 'saved' ? 'aud-saved' : 'aud-quiet'}
              data-testid="audit-export-result"
            >
              {exported.text}
            </p>
          )}
        </div>
        <VerifyResult verify={verify} />
        <fieldset className="aud-filters">
          <legend className="caps">{t('audit.filters')}</legend>
          <label>
            <span>{t('audit.filter.who')}</span>
            <select
              className="input"
              data-testid="audit-filter-who"
              value={form.who}
              onChange={(e) => {
                set('who', e.target.value);
              }}
            >
              <option value="">{t('audit.filter.anyone')}</option>
              {[...actors].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('audit.filter.what')}</span>
            <select
              className="input"
              data-testid="audit-filter-what"
              value={form.what}
              onChange={(e) => {
                set('what', e.target.value as KindGroup | '');
              }}
            >
              <option value="">{t('audit.filter.anything')}</option>
              {KIND_GROUP_IDS.map((g) => (
                <option key={g} value={g}>
                  {groupLabel(g)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('audit.filter.record')}</span>
            <input
              className="input"
              type="search"
              data-testid="audit-filter-record"
              placeholder={t('audit.filter.recordHint')}
              value={recordText}
              onChange={(e) => {
                setRecordText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set('record', recordText);
              }}
            />
          </label>
          <label>
            <span>{t('audit.filter.from')}</span>
            <input
              className="input"
              type="date"
              data-testid="audit-filter-from"
              value={form.from}
              max={form.to || undefined}
              onChange={(e) => {
                set('from', e.target.value);
              }}
            />
          </label>
          <label>
            <span>{t('audit.filter.to')}</span>
            <input
              className="input"
              type="date"
              data-testid="audit-filter-to"
              value={form.to}
              min={form.from || undefined}
              onChange={(e) => {
                set('to', e.target.value);
              }}
            />
          </label>
          <label>
            <span>{t('audit.filter.how')}</span>
            <select
              className="input"
              data-testid="audit-filter-how"
              value={form.how}
              onChange={(e) => {
                set('how', e.target.value as ChangeHow | '');
              }}
            >
              <option value="">{t('audit.filter.anyHow')}</option>
              {HOW_FILTERS.map((h) => (
                <option key={h} value={h}>
                  {howFilterLabel(h, product)}
                </option>
              ))}
            </select>
          </label>
          {filtered && (
            <button
              type="button"
              className="btn ghost sm aud-clear"
              onClick={() => {
                setRecordText('');
                setForm(EMPTY_FILTER_FORM);
              }}
            >
              {t('audit.filter.clear')}
            </button>
          )}
        </fieldset>

        {list.status === 'loading' && <p className="aud-quiet">{t('audit.loading')}</p>}
        {list.status === 'error' && (
          <p className="aud-quiet" data-testid="audit-error">
            {list.error}
          </p>
        )}
        {list.status === 'ready' && list.off && (
          <p className="aud-quiet">{t('audit.history.off')}</p>
        )}
        {list.status === 'ready' && !list.off && shown.length === 0 && (
          <p className="aud-quiet" data-testid="audit-empty">
            {t('audit.empty')}
          </p>
        )}
        {shown.length > 0 && (
          <>
            <p className="faint small" aria-live="polite">
              {t('audit.shown', { count: shown.length })}
            </p>
            <ol className="aud-list" aria-label={t('audit.list')}>
              {shown.map((e) => (
                <li key={e.op} className="aud-row" data-testid="audit-entry">
                  <EntryBody entry={e} names={actors} record={recordLabel(e.target, issues)} />
                  {!readOnly && !e.redacted && e.kind !== 'op.redact' && (
                    <div className="aud-acts">
                      <button
                        type="button"
                        className="btn ghost sm"
                        data-testid="audit-redact"
                        onClick={() => {
                          setRedactError(null);
                          setRedacting(e);
                        }}
                      >
                        {t('audit.redact')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        {list.status === 'ready' && list.cursor && (
          <button
            type="button"
            className="btn aud-more"
            data-testid="audit-load-more"
            disabled={list.more}
            onClick={() => {
              setState({ key: listKey, list: { ...list, more: true } });
              loadPage.current(list.cursor);
            }}
          >
            {t('audit.loadMore')}
          </button>
        )}
      </div>
      {redacting && (
        <RedactDialog
          busy={redactBusy}
          error={redactError}
          onCancel={() => {
            if (!redactBusy) setRedacting(null);
          }}
          onConfirm={redact}
        />
      )}
    </section>
  );
}
