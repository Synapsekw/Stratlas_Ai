import type { ChangeItem, ChangeKind, ChangeVerdict } from '@aio/schema';
import { useT, type MessageKey } from '@aio/ui';
import { useEffect, useMemo, useState } from 'react';
import { VERDICT_COLOR } from './overlay';
import { changeProducers, type ChangePairContext } from './producers';
import { registerRows, verdictCounts, type RegisterRow, type ReviewStatus } from './register';
import { changeStore, setsOfPair, useChange } from './store';

/**
 * The Changes panel (FUS-12): the register of the chosen date pair with filters and sort, the
 * "Find changes" run and one "Run ..." action per registered producer (C2 to C4), and a person's
 * review of each item. What a review does to issues is the app's (`actions`): nothing here
 * changes an issue.
 */

export interface ChangeRowActions {
  /** Confirm the item (matched issues get one track). Returns an error or null. */
  confirm(row: RegisterRow): Promise<string | null>;
  /** "Resolved" confirmed by the person: close the issue on the later date. */
  closeResolved(row: RegisterRow): Promise<string | null>;
  makeIssue(row: RegisterRow): Promise<string | null>;
  openIssue(issueId: string): void;
  canMakeIssue(item: ChangeItem): boolean;
  /** Issue code and status by id, for the row text. */
  issueCode(id: string | undefined): { code: string; status: string } | null;
  author(): string;
}

export interface ChangePanelProps {
  /** The project's captures, oldest first, with what the panel calls them. */
  captures: readonly { id: string; label: string }[];
  /** The pair to start on (the dates Compare dates shows). */
  defaultPair?: { from: string; to: string } | null | undefined;
  /** What C2 to C4's producers need to know of the pair; null when unknown. */
  context: (pair: { from: string; to: string }) => ChangePairContext | null;
  actions: ChangeRowActions;
  className?: string | undefined;
}

const KINDS: readonly ChangeKind[] = [
  'issue',
  'detection',
  'vector',
  'region',
  'component',
  'frame',
];
const STATUSES: readonly ReviewStatus[] = ['open', 'confirmed', 'dismissed'];

const css = `
.chg-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--bg-1); color: var(--fg-1); font: 400 var(--t-13)/1.4 var(--f-ui); }
.chg-h { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line); flex: none; }
.chg-h h3 { margin: 0; font: 600 var(--t-12)/1 var(--f-ui); letter-spacing: .06em; text-transform: uppercase; color: var(--fg-2); }
.chg-h .sub { font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-3); }
.chg-h .acts { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.chg-bar { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); align-items: center; flex: none; }
.chg-bar label { display: inline-flex; align-items: center; gap: 4px; font: 400 var(--t-11)/1 var(--f-ui); color: var(--fg-3); }
.chg-btn { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-1); font: 500 var(--t-12)/1 var(--f-ui); cursor: pointer; }
.chg-btn:hover:not(:disabled) { background: var(--bg-3); border-color: var(--line-strong); }
.chg-btn:disabled { opacity: .45; cursor: default; }
.chg-btn.primary { background: var(--acc); border-color: var(--acc); color: var(--acc-ink); }
.chg-btn.ghost { background: transparent; border-color: transparent; }
.chg-btn:focus-visible, .chg-row:focus-visible, .chg-input:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.chg-input { height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-0); font: 400 var(--t-12)/1 var(--f-ui); min-width: 0; }
.chg-input.grow { flex: 1; }
textarea.chg-input { height: auto; min-height: 48px; padding: 6px 8px; line-height: 1.45; resize: vertical; width: 100%; box-sizing: border-box; }
.chg-chips { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 6px 12px; border-bottom: 1px solid var(--line-soft); font: 400 var(--t-11)/1.3 var(--f-mono); color: var(--fg-2); flex: none; }
.chg-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.chg-dot.ghost { background: transparent !important; border: 1.5px solid var(--fg-3); box-sizing: border-box; }
.chg-list { flex: 1; min-height: 0; overflow-y: auto; }
.chg-row { display: grid; grid-template-columns: 10px 84px minmax(0, 1fr) auto; gap: 2px 8px; padding: 7px 12px; border-bottom: 1px solid var(--line-soft); cursor: pointer; align-items: center; }
.chg-row:hover { background: var(--bg-2); }
.chg-row[aria-selected='true'] { background: var(--acc-a12, var(--bg-2)); }
.chg-row .v { font: 600 var(--t-11)/1 var(--f-ui); text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); }
.chg-row .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg-row .st { font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-3); }
.chg-row .m { grid-column: 3 / 5; font: 400 var(--t-11)/1.3 var(--f-mono); color: var(--fg-3); }
.chg-row[data-status='dismissed'] .l { text-decoration: line-through; color: var(--fg-3); }
.chg-detail { padding: 8px 12px 10px; border-bottom: 1px solid var(--line); background: var(--bg-2); display: flex; flex-direction: column; gap: 6px; }
.chg-detail .acts { display: flex; flex-wrap: wrap; gap: 4px; }
.chg-note { font: 400 var(--t-12)/1.4 var(--f-ui); color: var(--fg-2); }
.chg-msg { padding: 8px 12px; font: 400 var(--t-12)/1.4 var(--f-ui); color: var(--fg-3); }
.chg-err { padding: 6px 12px; font: 400 var(--t-12)/1.4 var(--f-ui); color: var(--danger); }
.chg-ok { padding: 6px 12px; font: 400 var(--t-12)/1.4 var(--f-ui); color: var(--ok); }
.chg-ask { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font: 500 var(--t-12)/1.4 var(--f-ui); }
.chg-tag { font: 500 var(--t-11)/1 var(--f-ui); color: var(--fg-3); border: 1px solid var(--line); border-radius: var(--r-4); padding: 3px 6px; }
`;

export function ChangeStyles() {
  return (
    <style href="aio-change" precedence="default">
      {css}
    </style>
  );
}

const vKey = (v: ChangeVerdict) => `change.verdict.${v}` as MessageKey;
const kKey = (k: ChangeKind) => `change.kind.${k}` as MessageKey;
const sKey = (s: ReviewStatus) => `change.status.${s}` as MessageKey;

function fmt(n: number | undefined): string {
  if (n === undefined) return '-';
  return Math.abs(n) >= 100 ? n.toFixed(0) : String(Math.round(n * 100) / 100);
}

/** One short line of what changed: sizes, counts, distances, how the dates were matched. */
function detailText(item: ChangeItem, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (item.kind === 'issue') {
    if (item.size)
      parts.push(
        t('change.size', {
          from: fmt(item.size.from),
          to: fmt(item.size.to),
          unit: item.size.unit === 'm2' ? 'm²' : 'm',
        }),
      );
    if (item.severity && item.severity.from !== item.severity.to)
      parts.push(
        t('change.severity', { from: fmt(item.severity.from), to: fmt(item.severity.to) }),
      );
  } else if (item.kind === 'detection' && item.count) {
    parts.push(t('change.counts', { from: fmt(item.count.from), to: fmt(item.count.to) }));
  } else if (item.kind === 'region' && item.volume) {
    parts.push(`cut ${fmt(item.volume.cutM3)} m³, fill ${fmt(item.volume.fillM3)} m³`);
  }
  if (item.method) parts.push(t('change.method', { method: item.method }));
  return parts.join(' · ');
}

export function ChangePanel({
  captures,
  defaultPair,
  context,
  actions,
  className,
}: ChangePanelProps) {
  const t = useT();
  const s = useChange((x) => x);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  // start on the dates Compare dates shows, else the first and last survey
  const first = captures[0]?.id;
  const last = captures.at(-1)?.id;
  const wantPair =
    defaultPair ?? (first && last && first !== last ? { from: first, to: last } : null);
  useEffect(() => {
    const cur = changeStore.getState().pair;
    const known = (id: string | undefined) => captures.some((c) => c.id === id);
    if (wantPair && (!cur || !known(cur.from) || !known(cur.to) || defaultPair))
      if (cur?.from !== wantPair.from || cur.to !== wantPair.to)
        changeStore.getState().setPair(wantPair);
    // only when the wanted pair changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPair?.from, wantPair?.to]);

  const pairSets = useMemo(() => setsOfPair(s.sets, s.pair), [s.sets, s.pair]);
  const rows = useMemo(
    () => registerRows(pairSets, s.filter, s.sort),
    [pairSets, s.filter, s.sort],
  );
  const all = useMemo(() => registerRows(pairSets), [pairSets]);
  const counts = useMemo(() => verdictCounts(all), [all]);
  const open = all.filter((r) => r.status === 'open').length;
  const selectedRow = rows.find(
    (r) => r.setId === s.selected?.setId && r.item.id === s.selected.itemId,
  );
  // a newly picked item starts with its own note and no question open
  const rowKey = `${selectedRow?.setId ?? ''}/${selectedRow?.item.id ?? ''}/${selectedRow?.item.review?.note ?? ''}`;
  const [seenKey, setSeenKey] = useState(rowKey);
  if (seenKey !== rowKey) {
    setSeenKey(rowKey);
    setNote(selectedRow?.item.review?.note ?? '');
    setAsking(false);
  }

  // producers registered after mount (C2 to C4) show up
  useEffect(() => {
    const id = setInterval(() => {
      setTick((n) => n + 1);
    }, 2000);
    return () => {
      clearInterval(id);
    };
  }, []);

  if (captures.length < 2)
    return (
      <div className={`chg-panel ${className ?? ''}`} data-testid="change-panel">
        <ChangeStyles />
        <p className="chg-msg">{t('change.needTwo')}</p>
      </div>
    );

  const pair = s.pair;
  const ctx = pair ? context(pair) : null;
  const producers = changeProducers();
  const label = (id: string) => captures.find((c) => c.id === id)?.label ?? id;

  const act = async (fn: () => Promise<string | null>, ok?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const err = await fn();
      setNotice(err ? { ok: false, text: err } : ok ? { ok: true, text: ok } : null);
    } finally {
      setBusy(false);
    }
  };
  const review = (row: RegisterRow, status: ReviewStatus | null, extra: { note?: string } = {}) =>
    changeStore.getState().review(
      { setId: row.setId, itemId: row.item.id },
      status === null
        ? null
        : {
            ...row.item.review,
            status,
            by: actions.author(),
            at: new Date().toISOString(),
            ...extra,
          },
    );

  return (
    <div className={`chg-panel ${className ?? ''}`} data-testid="change-panel">
      <ChangeStyles />
      <div className="chg-h">
        <h3>{t('change.title')}</h3>
        <span className="sub" data-testid="change-summary">
          {t('change.count', { count: all.length })} · {t('change.open', { count: open })}
        </span>
        <span className="acts">
          {s.readOnly && (
            <span className="chg-tag" title={t('change.readOnlyTip')}>
              {t('change.readOnly')}
            </span>
          )}
        </span>
      </div>
      <div className="chg-bar">
        <label>
          {t('change.from')}
          <select
            className="chg-input"
            data-testid="change-from"
            value={pair?.from ?? ''}
            onChange={(e) => {
              const to = pair?.to ?? last ?? '';
              s.setPair({ from: e.target.value, to });
            }}
          >
            {captures.slice(0, -1).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('change.to')}
          <select
            className="chg-input"
            data-testid="change-to"
            value={pair?.to ?? ''}
            onChange={(e) => {
              s.setPair({ from: pair?.from ?? first ?? '', to: e.target.value });
            }}
          >
            {captures
              .filter(
                (c) =>
                  captures.findIndex((x) => x.id === c.id) >
                  captures.findIndex((x) => x.id === pair?.from),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </select>
        </label>
      </div>
      {!s.readOnly && (
        <div className="chg-bar">
          {s.run ? (
            <>
              <span className="sub" role="status" data-testid="change-running">
                {t('change.running', { phase: s.run.phase })}
              </span>
              <button type="button" className="chg-btn ghost" onClick={() => void s.cancel()}>
                {t('change.cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="chg-btn primary"
              data-testid="change-run"
              title={t('change.run')}
              disabled={!pair}
              onClick={() => void s.compute()}
            >
              {t('change.runShort')}
            </button>
          )}
          {producers.map((p) => {
            const ok = ctx ? p.available(ctx) : 'no dates';
            return (
              <button
                key={p.id}
                type="button"
                className="chg-btn"
                data-testid={`change-producer-${p.id}`}
                disabled={ok !== true || !!s.run}
                title={ok === true ? p.label : t('change.producerMissing', { why: ok })}
                onClick={() => {
                  if (ctx)
                    void act(async () => {
                      const r = await p.run(ctx);
                      if (r.ok && r.ids?.length) await changeStore.getState().load(ctx.projectId);
                      return r.ok ? null : r.error;
                    });
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="chg-bar">
        <select
          className="chg-input"
          aria-label={t('change.filter.kind')}
          data-testid="change-filter-kind"
          value={s.filter.kinds?.[0] ?? ''}
          onChange={(e) => {
            s.setFilter({ kinds: e.target.value ? [e.target.value as ChangeKind] : [] });
          }}
        >
          <option value="">
            {t('change.filter.kind')}: {t('change.filter.all')}
          </option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(kKey(k))}
            </option>
          ))}
        </select>
        <select
          className="chg-input"
          aria-label={t('change.filter.verdict')}
          data-testid="change-filter-verdict"
          value={s.filter.verdicts?.[0] ?? ''}
          onChange={(e) => {
            s.setFilter({ verdicts: e.target.value ? [e.target.value as ChangeVerdict] : [] });
          }}
        >
          <option value="">
            {t('change.filter.verdict')}: {t('change.filter.all')}
          </option>
          {(Object.keys(counts) as ChangeVerdict[]).map((v) => (
            <option key={v} value={v}>
              {t(vKey(v))}
            </option>
          ))}
        </select>
        <select
          className="chg-input"
          aria-label={t('change.filter.status')}
          value={s.filter.status?.[0] ?? ''}
          onChange={(e) => {
            s.setFilter({ status: e.target.value ? [e.target.value as ReviewStatus] : [] });
          }}
        >
          <option value="">
            {t('change.filter.status')}: {t('change.filter.all')}
          </option>
          {STATUSES.map((x) => (
            <option key={x} value={x}>
              {t(sKey(x))}
            </option>
          ))}
        </select>
        <select
          className="chg-input"
          aria-label={t('change.sort')}
          value={s.sort}
          onChange={(e) => {
            s.setSort(e.target.value as typeof s.sort);
          }}
        >
          {(['verdict', 'kind', 'score', 'label'] as const).map((x) => (
            <option key={x} value={x}>
              {t(`change.sort.${x}`)}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={s.filter.hideUnchanged === true}
            onChange={(e) => {
              s.setFilter({ hideUnchanged: e.target.checked });
            }}
          />
          {t('change.filter.hideUnchanged')}
        </label>
        <input
          className="chg-input grow"
          type="search"
          aria-label={t('change.filter.search')}
          placeholder={t('change.filter.search')}
          value={s.filter.text ?? ''}
          onChange={(e) => {
            s.setFilter({ text: e.target.value });
          }}
        />
      </div>
      {all.length > 0 && (
        <div className="chg-chips" data-testid="change-counts">
          {(Object.entries(counts) as [ChangeVerdict, number][]).map(([v, n]) => (
            <span key={v} data-verdict={v}>
              <span className="chg-dot" style={{ background: VERDICT_COLOR[v] }} /> {n} {t(vKey(v))}
            </span>
          ))}
        </div>
      )}
      {s.error && (
        <p className="chg-err" role="alert">
          {s.error}
        </p>
      )}
      {notice && (
        <p className={notice.ok ? 'chg-ok' : 'chg-err'} role="status" data-testid="change-notice">
          {notice.text}
        </p>
      )}
      {s.problems.length > 0 && (
        <p className="chg-msg" title={s.problems.map((p) => `${p.name}: ${p.error}`).join('\n')}>
          {t('change.problems', { count: s.problems.length })}
        </p>
      )}
      <div className="chg-list" role="listbox" aria-label={t('change.title')}>
        {all.length === 0 && <p className="chg-msg">{t('change.none')}</p>}
        {all.length > 0 && rows.length === 0 && <p className="chg-msg">{t('change.noMatch')}</p>}
        {rows.map((row) => {
          const on = row === selectedRow;
          const { item } = row;
          const text = detailText(item, t);
          const fromIssue = item.kind === 'issue' ? actions.issueCode(item.from) : null;
          const toIssue = item.kind === 'issue' ? actions.issueCode(item.to) : null;
          const codes =
            fromIssue || toIssue
              ? `${fromIssue?.code ?? '-'} (${label(pairSets.find((x) => x.id === row.setId)?.from ?? '')}) → ${toIssue?.code ?? '-'}`
              : '';
          return (
            <div key={`${row.setId}/${item.id}`}>
              <div
                className="chg-row"
                role="option"
                tabIndex={0}
                aria-selected={on}
                data-testid="change-row"
                data-id={item.id}
                data-kind={item.kind}
                data-verdict={item.verdict}
                data-status={row.status}
                onClick={() => {
                  s.select(on ? null : { setId: row.setId, itemId: item.id });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    s.select(on ? null : { setId: row.setId, itemId: item.id });
                  }
                }}
              >
                <span className="chg-dot" style={{ background: VERDICT_COLOR[item.verdict] }} />
                <span className="v">{t(vKey(item.verdict))}</span>
                <span className="l" title={item.label ?? item.id}>
                  {item.label ?? item.id}
                </span>
                <span className="st">{t(sKey(row.status))}</span>
                {(text || codes) && (
                  <span className="m">{[codes, text].filter(Boolean).join(' · ')}</span>
                )}
              </div>
              {on && (
                <div className="chg-detail" data-testid="change-detail">
                  {item.verdict === 'not-seen' && (
                    <p className="chg-note">{t('change.notSeenTip')}</p>
                  )}
                  {item.review?.note && <p className="chg-note">{item.review.note}</p>}
                  {!s.readOnly && (
                    <div className="acts">
                      {row.status !== 'confirmed' && item.verdict !== 'resolved' && (
                        <button
                          type="button"
                          className="chg-btn"
                          data-testid="change-confirm"
                          title={t('change.confirmTip')}
                          disabled={busy}
                          onClick={() => void act(() => actions.confirm(row))}
                        >
                          {t('change.confirm')}
                        </button>
                      )}
                      {item.kind === 'issue' &&
                        item.verdict === 'resolved' &&
                        row.status !== 'confirmed' &&
                        (asking ? (
                          <span className="chg-ask">
                            {t('change.closeResolvedAsk', {
                              code: fromIssue?.code ?? item.id,
                              date: label(pairSets.find((x) => x.id === row.setId)?.to ?? ''),
                            })}
                            <button
                              type="button"
                              className="chg-btn primary"
                              data-testid="change-close-yes"
                              disabled={busy}
                              onClick={() => void act(() => actions.closeResolved(row))}
                            >
                              {t('change.closeResolvedYes')}
                            </button>
                            <button
                              type="button"
                              className="chg-btn ghost"
                              onClick={() => {
                                setAsking(false);
                              }}
                            >
                              {t('change.cancel')}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="chg-btn"
                            data-testid="change-close-resolved"
                            title={t('change.closeResolvedTip')}
                            onClick={() => {
                              setAsking(true);
                            }}
                          >
                            {t('change.closeResolved')}
                          </button>
                        ))}
                      {actions.canMakeIssue(item) && (
                        <button
                          type="button"
                          className="chg-btn"
                          data-testid="change-make-issue"
                          title={t('change.makeIssueTip')}
                          disabled={busy}
                          onClick={() => void act(() => actions.makeIssue(row))}
                        >
                          {t('change.makeIssue')}
                        </button>
                      )}
                      {row.status === 'open' ? (
                        <button
                          type="button"
                          className="chg-btn ghost"
                          data-testid="change-dismiss"
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              (await review(row, 'dismissed'))
                                ? null
                                : changeStore.getState().error,
                            )
                          }
                        >
                          {t('change.dismiss')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="chg-btn ghost"
                          data-testid="change-reopen"
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              (await review(row, null)) ? null : changeStore.getState().error,
                            )
                          }
                        >
                          {t('change.reopen')}
                        </button>
                      )}
                      {(item.review?.issueId ??
                        (item.kind === 'issue' ? (item.to ?? item.from) : undefined)) && (
                        <button
                          type="button"
                          className="chg-btn ghost"
                          data-testid="change-open-issue"
                          onClick={() => {
                            const id =
                              item.review?.issueId ??
                              (item.kind === 'issue' ? (item.to ?? item.from) : undefined);
                            if (id) actions.openIssue(id);
                          }}
                        >
                          {t('change.openIssue')}
                        </button>
                      )}
                    </div>
                  )}
                  {!s.readOnly && (
                    <>
                      <textarea
                        className="chg-input"
                        aria-label={t('change.note')}
                        placeholder={t('change.notePlaceholder')}
                        value={note}
                        onChange={(e) => {
                          setNote(e.target.value);
                        }}
                      />
                      <div className="acts">
                        <button
                          type="button"
                          className="chg-btn ghost"
                          disabled={busy || note === (item.review?.note ?? '')}
                          onClick={() =>
                            void act(async () =>
                              (await review(row, row.status, note ? { note } : {}))
                                ? null
                                : changeStore.getState().error,
                            )
                          }
                        >
                          {t('change.saveNote')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
