/**
 * "Search this project" (M1 fact index) in the Project tab: one field over the project's fact
 * index (`facts:query`), results as a compact list, each opening its history inline
 * (`facts:history` on the fact's subject: linked records with their relation, then the journal's
 * changes, oldest first). The index is derived and kept by main; its state comes from the fact
 * store (`useFactIndex`), and "Rebuild index" builds it again from the project's files. Reads
 * only: nothing here changes project data.
 */
import { formatQuantity, localeOf, type Quantity } from '@aio/geo';
import type {
  Fact,
  FactHistory,
  FactIndexStatus,
  FactsUnavailable,
  SurveySettings,
} from '@aio/schema';
import { Button, formatDate, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { bridge } from '../shell';
import { useMeasure } from '../survey/measureStore';
import { factIndex, useFactIndex } from './factStore';
import './projectSearch.css';

/** How long the field waits after the last key before it asks main. */
export const SEARCH_DEBOUNCE_MS = 200;
/** Results asked for at once. */
export const SEARCH_LIMIT = 30;
/** The longest search main is asked (main refuses longer text). */
export const SEARCH_MAX_CHARS = 200;

/** The status words the index stores, each with its own string; others show as stored. */
const STATUS_WORDS = [
  'accepted',
  'draft',
  'rejected',
  'reviewed',
  'approved',
  'closed',
  'pass',
  'fail',
  'hold',
  'released',
  'unchecked',
  'ok',
  'partial',
  'refused',
  'stale',
  'warning',
  'proposed',
  'confirmed',
  'dismissed',
  'open',
  'candidate',
] as const;
type StatusWord = (typeof STATUS_WORDS)[number];
const isStatusWord = (s: string): s is StatusWord =>
  (STATUS_WORDS as readonly string[]).includes(s);

/** A fact's status in the user's language, or the stored word when it has no string. */
export function statusText(status: string, t: ReturnType<typeof useT>): string {
  return isStatusWord(status) ? t(`facts.status.${status}`) : status;
}

/** Why main could not answer, in the user's language; main's own text when it gives no reason. */
interface Failed {
  error: string;
  reason?: FactsUnavailable;
}
const failedOf = (v: { error: string; reason?: FactsUnavailable | undefined }): Failed => ({
  error: v.error,
  ...(v.reason ? { reason: v.reason } : {}),
});
function failureText(
  f: Failed,
  t: ReturnType<typeof useT>,
  otherwise: (error: string) => string,
): string {
  return f.reason ? t(`facts.unavailable.${f.reason}`) : otherwise(f.error);
}

const QUANTITY: Readonly<Record<string, Quantity>> = {
  m: 'distance',
  m2: 'area',
  'mÂ²': 'area',
  m3: 'volume',
  'mÂ³': 'volume',
};

/** The site's units, precision and number style, as the cards format with them. */
export type FactUnits = Pick<SurveySettings, 'units' | 'precision' | 'locale'>;

/** A fact's figure: lengths, areas and volumes in the site's units, anything else as stored. */
export function factValue(fact: Fact, u: FactUnits): string | null {
  if (fact.value === undefined || !Number.isFinite(fact.value)) return null;
  const q = fact.unit ? QUANTITY[fact.unit] : undefined;
  if (q)
    return formatQuantity(
      fact.value,
      q,
      u.units,
      u.precision,
      u.locale ?? localeOf(u.units.distance),
    );
  const n = Number.isInteger(fact.value) ? String(fact.value) : fact.value.toFixed(2);
  return fact.unit ? `${n} ${fact.unit}` : n;
}

/** The day a fact is of: its survey date, else the day it happened. */
function factDay(fact: Fact): string | null {
  const d = fact.date ?? fact.at;
  return d ? formatDate(d) : null;
}

type Results =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'done'; facts: Fact[]; total: number }
  | ({ state: 'failed' } & Failed);

type History =
  { state: 'loading' } | { state: 'done'; history: FactHistory } | ({ state: 'failed' } & Failed);

function HistoryBody({
  id,
  fact,
  history,
}: {
  id: string;
  fact: Fact;
  history: History;
}): ReactElement {
  const t = useT();
  const kind = (f: Fact) => t(`facts.kind.${f.kind}`);
  let body: ReactElement;
  if (history.state === 'loading') body = <p className="fs-note">{t('facts.history.loading')}</p>;
  else if (history.state === 'failed')
    body = (
      <p className="fs-note" data-tone="error">
        {failureText(history, t, (error) => t('facts.history.failed', { error }))}
      </p>
    );
  else {
    const { facts, linked, events } = history.history;
    const own = facts.filter((f) => f.id !== fact.id);
    const rows = [
      ...own.map((f) => ({ key: f.id, tag: kind(f), fact: f })),
      ...linked.map((l) => ({
        key: `${l.rel}:${l.fact.id}`,
        tag: `${t(`facts.rel.${l.rel}`)} Â· ${kind(l.fact)}`,
        fact: l.fact,
      })),
    ];
    body =
      rows.length === 0 && events.length === 0 ? (
        <p className="fs-note">{t('facts.history.empty')}</p>
      ) : (
        <>
          {rows.length > 0 && (
            <>
              <h4 className="fs-sub caps">{t('facts.history.linked')}</h4>
              <ul className="fs-hlist" data-testid="project-search-linked">
                {rows.map((r) => (
                  <li key={r.key} className="fs-hrow">
                    <span className="fs-htag">{r.tag}</span>
                    <span className="fs-hlabel">{r.fact.label}</span>
                    <span className="fs-hdate">{factDay(r.fact)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {events.length > 0 && (
            <>
              <h4 className="fs-sub caps">{t('facts.history.events')}</h4>
              <ul className="fs-hlist" data-testid="project-search-events">
                {events.map((e) => (
                  <li key={e.id} className="fs-hrow">
                    <span className="fs-hlabel">{e.label}</span>
                    <span className="fs-hdate">{factDay(e)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      );
  }
  return (
    <div
      className="fs-history"
      id={id}
      role="region"
      aria-label={t('facts.history', { label: fact.label })}
      data-testid="project-search-history"
    >
      {body}
    </div>
  );
}

function ResultRow({
  fact,
  open,
  history,
  onToggle,
}: {
  fact: Fact;
  open: boolean;
  history: History | undefined;
  onToggle: () => void;
}): ReactElement {
  const t = useT();
  const units = useMeasure((s) => s.settings);
  const historyId = useId();
  const value = factValue(fact, units);
  const day = factDay(fact);
  return (
    <li className="fs-row" data-kind={fact.kind} data-testid="project-search-result">
      <button
        type="button"
        className="fs-line"
        aria-expanded={open}
        aria-controls={open ? historyId : undefined}
        onClick={onToggle}
      >
        <span className="fs-kind">{t(`facts.kind.${fact.kind}`)}</span>
        <span className="fs-label">{fact.label}</span>
        <span className="fs-meta">
          {day && <span>{day}</span>}
          {value && <span className="fs-value">{value}</span>}
          {fact.status && <span className="fs-status">{statusText(fact.status, t)}</span>}
        </span>
      </button>
      {open && history && <HistoryBody id={historyId} fact={fact} history={history} />}
    </li>
  );
}

/** The state line: what the index is doing while it cannot answer. */
function stateLine(status: FactIndexStatus | null, t: ReturnType<typeof useT>): string | null {
  if (!status) return t('facts.state.loading');
  if (status.state === 'building') return t('facts.state.building');
  if (status.state === 'none') return t('facts.state.none');
  if (status.state === 'error') return t('facts.state.error', { error: status.error ?? '' });
  return null;
}

export function ProjectSearch(): ReactElement | null {
  const t = useT();
  const fieldId = useId();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const status = useFactIndex((s) => (s.projectId === projectId ? s.status : null));
  const ready = status?.state === 'ready';
  const builtAt = status?.builtAt;
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // the last answer, with the project and words it was for
  const [answer, setAnswer] = useState<{ words: string; result: Results } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // histories by subject, read from one build of the index (a newer build reads them anew)
  const [histories, setHistories] = useState<{
    built: string | undefined;
    by: Record<string, History>;
  }>({ built: undefined, by: {} });
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const words = projectId && ready && query !== '' ? `${projectId}\n${query}` : null;

  // the field settles before main is asked
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(text.trim().slice(0, SEARCH_MAX_CHARS));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
    };
  }, [text]);

  // ask again when the words change or the index does (an update or a rebuild)
  useEffect(() => {
    if (!projectId || words === null) return;
    let live = true;
    void bridge
      .call('facts:query', { projectId, query: { text: query, limit: SEARCH_LIMIT } })
      .then((r) => {
        if (!live) return;
        const result: Results = !r.ok
          ? { state: 'failed', error: r.error }
          : !r.value.ok
            ? { state: 'failed', ...failedOf(r.value) }
            : { state: 'done', facts: r.value.facts, total: r.value.total };
        setAnswer({ words, result });
      });
    return () => {
      live = false;
    };
  }, [projectId, words, query, builtAt]);

  // the answer for these words (the last one stays up while a newer build of the index is asked)
  const results: Results =
    words === null
      ? { state: 'idle' }
      : answer?.words === words
        ? answer.result
        : { state: 'searching' };
  const historyOf = (subject: string): History | undefined =>
    histories.built === builtAt ? histories.by[subject] : undefined;

  const toggle = (fact: Fact) => {
    if (open === fact.id) {
      setOpen(null);
      return;
    }
    setOpen(fact.id);
    if (!projectId || historyOf(fact.subject)) return;
    const built = builtAt;
    const put = (h: History) => {
      setHistories((was) => ({
        built,
        by: { ...(was.built === built ? was.by : {}), [fact.subject]: h },
      }));
    };
    put({ state: 'loading' });
    void bridge.call('facts:history', { projectId, subject: fact.subject }).then((r) => {
      put(
        !r.ok
          ? { state: 'failed', error: r.error }
          : !r.value.ok
            ? { state: 'failed', ...failedOf(r.value) }
            : { state: 'done', history: r.value.history },
      );
    });
  };

  const rebuild = () => {
    if (!projectId || rebuilding) return;
    setRebuilding(true);
    setRebuildError(null);
    // main reports `building` and then the new status (`facts:changed`); its answer is the last
    void bridge.call('facts:rebuild', { projectId }).then((r) => {
      setRebuilding(false);
      if (!r.ok) setRebuildError(t('facts.rebuildFailed', { error: r.error }));
      else if (!r.value.ok)
        setRebuildError(
          failureText(failedOf(r.value), t, (error) => t('facts.rebuildFailed', { error })),
        );
      else if (factIndex.getState().projectId === projectId)
        factIndex.setState({ status: r.value.status });
    });
  };

  if (!projectId) return null;
  const line = stateLine(status, t);
  const indexed = status ? Object.values(status.counts).reduce((a, b) => a + b, 0) : 0;
  let count: string | null = null;
  if (results.state === 'done' && results.facts.length > 0)
    count =
      results.total > results.facts.length
        ? t('facts.countOf', { shown: results.facts.length, total: results.total })
        : t('facts.count', { count: results.facts.length });
  else if (ready && query === '') count = t('facts.indexed', { count: indexed });

  return (
    <div className="fs" data-testid="project-search">
      <label className="sr-only" htmlFor={fieldId}>
        {t('facts.field')}
      </label>
      <input
        id={fieldId}
        className="input fs-field"
        type="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={SEARCH_MAX_CHARS}
        placeholder={t('facts.placeholder')}
        value={text}
        data-testid="project-search-field"
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text !== '') {
            e.stopPropagation();
            setText('');
          }
        }}
      />
      <div className="fs-status-line" role="status" aria-live="polite">
        {line !== null && (
          <p
            className="fs-note"
            data-tone={status?.state === 'error' ? 'error' : undefined}
            data-testid="project-search-state"
          >
            {line}
          </p>
        )}
        {line === null && count !== null && (
          <p className="fs-note" data-testid="project-search-count">
            {count}
          </p>
        )}
        {results.state === 'searching' && <p className="fs-note">{t('facts.searching')}</p>}
        {results.state === 'failed' && (
          <p className="fs-note" data-tone="error">
            {failureText(results, t, (error) => t('facts.queryFailed', { error }))}
          </p>
        )}
        {results.state === 'done' && results.facts.length === 0 && (
          <p className="fs-note" data-testid="project-search-empty">
            {t('facts.empty', { text: query })}
          </p>
        )}
        {rebuildError !== null && (
          <p className="fs-note" data-tone="error">
            {rebuildError}
          </p>
        )}
      </div>
      {ready && query === '' && <p className="fs-hint">{t('facts.hint')}</p>}
      {results.state === 'done' && results.facts.length > 0 && (
        <ul className="fs-list" data-testid="project-search-results">
          {results.facts.map((f) => (
            <ResultRow
              key={f.id}
              fact={f}
              open={open === f.id}
              history={historyOf(f.subject)}
              onToggle={() => {
                toggle(f);
              }}
            />
          ))}
        </ul>
      )}
      <div className="fs-foot">
        <Button
          variant="quiet"
          size="sm"
          disabled={rebuilding || status?.state === 'building' || status?.state === 'none'}
          data-testid="project-search-rebuild"
          onClick={rebuild}
        >
          {rebuilding ? t('facts.rebuilding') : t('facts.rebuild')}
        </Button>
      </div>
    </div>
  );
}
