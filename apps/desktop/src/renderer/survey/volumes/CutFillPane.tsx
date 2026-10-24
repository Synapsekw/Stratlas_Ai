/**
 * The Volumes tab's Cut & fill pane (volumetrics redesign, spec section 6, board 4): From → To
 * (the app's one compare pair, shared with the dates strip's compare band), Export, Inside piles |
 * Whole site, "Ignore under [0.10] m", the Cut, Fill and Net figures, the whole-site line, the
 * per-pile diverging bars (13, the rest folded) and the note on why the inventory change differs.
 *
 * Figures: inside piles, one surface-to-surface comparison per pile ring with the threshold as
 * deadband; whole site, the engine's site comparison with the same threshold. Both run in the
 * survey engine worker. A pile the engine could not compute is named, never counted as zero; a date
 * without a prepared surface is waited for, not estimated.
 */
import { formatNumber, fromSI, localeOf, unitLabel, type NumberLocale } from '@aio/geo';
import type { SurveyUnits } from '@aio/schema';
import { foldSmall, inventoryPiles } from '@aio/survey';
import { Button, formatDate, useT } from '@aio/ui';
import { dateTags, useWorkspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { bridge } from '../../shell';
import { compareDates, defaultPair } from '../../workspace/dates/compareDates';
import { engineClient, useCompare } from '../compareStore';
import { fileBase } from '../exportHelpers';
import { useMeasure } from '../measureStore';
import { useFocusCapture } from '../qaHelpers';
import { useCounted } from '../useInventory';
import {
  captureRef,
  cutFillByPile,
  cutFillCsv,
  cutFillPrefs,
  cutFillTotals,
  inventoryChange,
  pairKey,
  pileRunKey,
  parseThreshold,
  siteCellM,
  useCutFillPrefs,
  wholeSiteCutFill,
  type CutFillArea,
  type CutFillRow,
  type PileRun,
} from './cutFill';
import './cutFill.css';

/** Typing in "Ignore under" recomputes after this pause (leaving the field recomputes at once). */
const THRESHOLD_PAUSE_MS = 400;

export interface CutFillPaneProps {
  className?: string;
  /** A by-pile bar was clicked (the Volumes bench opens the pile panel). */
  onPile?: (id: string) => void;
}

interface Figures {
  /** What the figures are for, so an older answer is never shown for a newer question. */
  key: string;
  /** Inside piles only (whole site runs no pile). */
  rows: CutFillRow[];
  site: { cutM3: number; fillM3: number; netM3: number } | null;
  /** The whole-site run has answered (or failed): nothing more is coming. */
  siteDone: boolean;
}

const cancelledRun = (e: unknown) =>
  e instanceof Error && (e.name === 'RunCancelled' || e.name === 'AbortError');

/** The engine's per-pile run through the worker; a newer run of the same pile cancels the older. */
const workerRun: PileRun = async (ring, item, capture, id) => {
  const r = await engineClient().run(
    { ring, items: [item], ...(capture !== undefined ? { capture } : {}) },
    `cutfill:${id ?? ''}`,
  );
  const first = r.results[0];
  if (!first) throw new Error('The comparison gave no result.');
  return first;
};

/** A volume in the site's unit with the Unicode minus (and a plus on a gain when `signed`). */
function volumeText(
  m3: number,
  units: SurveyUnits,
  decimals: number,
  locale: NumberLocale,
  signed = false,
): string {
  const v = fromSI(m3, 'volume', units.volume);
  const bare = formatNumber(Math.abs(v), decimals, locale);
  if (!/[1-9]/.test(bare)) return bare;
  return v < 0 ? `−${bare}` : signed ? `+${bare}` : bare;
}

export function CutFillPane({ className, onPile }: CutFillPaneProps): ReactElement {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const manifestCaptures = useWorkspace((s) => s.project?.manifest.captures);
  const focus = useFocusCapture();
  const surfaces = useCompare((s) => s.surfaces);
  const engineReady = useCompare((s) => s.status) === 'ready';
  const settings = useMeasure((s) => s.settings);
  const measurements = useMeasure((s) => s.file.measurements);
  const pairFrom = useStore(compareDates, (s) => s.from);
  const pairTo = useStore(compareDates, (s) => s.to);
  const thresholdM = useCutFillPrefs((s) => s.thresholdM);
  const area = useCutFillPrefs((s) => s.area);

  const units = settings.units;
  const locale = settings.locale ?? localeOf(units.distance);
  const decimals = settings.precision.volume;
  const unit = unitLabel(units.volume);
  const vol = (m3: number, signed = false) => volumeText(m3, units, decimals, locale, signed);

  useEffect(() => {
    cutFillPrefs.getState().load(projectId);
  }, [projectId]);

  // the dated surveys, oldest first; an undated capture is never part of a pair
  const dated = useMemo(
    () =>
      (manifestCaptures ?? [])
        .filter((c) => c.date && Number.isFinite(Date.parse(c.date)))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [manifestCaptures],
  );
  const tags = useMemo(() => dateTags(manifestCaptures ?? []), [manifestCaptures]);
  const timeOf = useCallback(
    (capture: string) => {
      const c = dated.find((x) => x.id === capture);
      return c ? Date.parse(c.date) : null;
    },
    [dated],
  );

  // the shared pair when it names two of the surveys, else the default for the date in focus
  const known = (id: string | null): id is string => id !== null && dated.some((c) => c.id === id);
  const fallback = useMemo(
    () =>
      defaultPair(
        focus,
        dated.map((c) => ({ capture: c.id, t: Date.parse(c.date) })),
      ),
    [focus, dated],
  );
  const pair =
    known(pairFrom) && known(pairTo) && pairFrom !== pairTo
      ? { from: pairFrom, to: pairTo }
      : fallback;
  useEffect(() => {
    if (!fallback) return;
    const s = compareDates.getState();
    if (!known(s.from) || !known(s.to) || s.from === s.to) s.set(fallback.from, fallback.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `known` reads `dated`
  }, [fallback, dated]);

  const choose = (side: 'from' | 'to', id: string) => {
    if (!pair) return;
    const next = side === 'from' ? { from: id, to: pair.to } : { from: pair.from, to: id };
    if (next.from === next.to) {
      // the same survey on both sides: the other side takes the one this side had
      const other = side === 'from' ? pair.from : pair.to;
      if (side === 'from') next.to = other;
      else next.from = other;
    }
    compareDates.getState().set(next.from, next.to, timeOf);
  };

  const piles = useMemo(() => inventoryPiles(measurements), [measurements]);
  // the inventory's one counting rule, for the note's change
  const isCounted = useCounted(piles);
  const fromRef = pair ? captureRef(surfaces, pair.from) : null;
  const toRef = pair ? captureRef(surfaces, pair.to) : null;
  const dateOf = (id: string) => dated.find((c) => c.id === id)?.date ?? '';
  const waitingFor = pair && engineReady ? (!fromRef ? pair.from : !toRef ? pair.to : null) : null;

  // ---------------------------------------------------------------- computing
  const [figures, setFigures] = useState<Figures | null>(null);
  /** A problem, for the question it was asked for (a newer question hides it). */
  const [failure, setFailure] = useState<{ key: string | null; message: string } | null>(null);

  // what the runs read: the pair's surfaces with their fingerprints, the threshold, the area shown
  // and the piles' rings (never `updatedAt`: saving the measurements does not ask again)
  const pk = fromRef && toRef ? pairKey(surfaces, { from: fromRef, to: toRef }) : null;
  const cellM = siteCellM(surfaces);
  const runKey =
    pk !== null && engineReady
      ? JSON.stringify([
          pk,
          thresholdM,
          area,
          area === 'piles' ? piles.map((m) => [pileRunKey(m), m.label]) : null,
          cellM,
        ])
      : null;
  useEffect(() => {
    if (!runKey || !fromRef || !toRef || pk === null) return;
    const ac = new AbortController();
    const live = () => !ac.signal.aborted;
    const refs = { from: fromRef, to: toRef };
    const siteRun = async (): Promise<Figures['site']> => {
      try {
        return await wholeSiteCutFill(
          refs,
          thresholdM,
          cellM,
          (req, key) => engineClient().site(req, key),
          { pair: pk, signal: ac.signal },
        );
      } catch (e) {
        if (cancelledRun(e)) throw e;
        return null;
      }
    };
    void (async () => {
      try {
        // only the area shown runs: inside piles, the piles and then the whole-site line under
        // the tiles; whole site, the site comparison alone. Answers are kept (`cutFill.ts`), so
        // switching back asks nothing again.
        if (area === 'piles') {
          const rows = await cutFillByPile(piles, refs, thresholdM, workerRun, ac.signal, {
            pair: pk,
          });
          if (ac.signal.aborted) return;
          setFigures({ key: runKey, rows, site: null, siteDone: false });
          const site = await siteRun();
          if (live()) setFigures({ key: runKey, rows, site, siteDone: true });
        } else {
          const site = await siteRun();
          if (!ac.signal.aborted) setFigures({ key: runKey, rows: [], site, siteDone: true });
        }
      } catch (e) {
        if (ac.signal.aborted || cancelledRun(e)) return;
        setFailure({ key: runKey, message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      ac.abort();
    };
    // runKey names every input the run reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  const current = figures?.key === runKey ? figures : null;
  const error = failure?.key === runKey ? failure.message : null;
  const computing = runKey !== null && !current?.siteDone && error === null;

  // ---------------------------------------------------------------- the threshold field
  // what is typed, for the threshold it was typed over (a new threshold shows itself instead)
  const [typed, setTyped] = useState<{ text: string; over: number } | null>(null);
  const draft = typed?.over === thresholdM ? typed.text : formatNumber(thresholdM, 2, 'metric');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const commit = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const v = parseThreshold(text);
    if (v !== null && v !== cutFillPrefs.getState().thresholdM) {
      cutFillPrefs.getState().setThreshold(v);
    }
  };
  const draftBad = parseThreshold(draft) === null;

  // ---------------------------------------------------------------- what shows
  const rows = current?.rows ?? [];
  const counted = rows.filter((r) => r.status !== 'refused');
  const refused = rows.filter((r) => r.status === 'refused');
  const partial = rows.filter((r) => r.status === 'partial');
  const pileTotals = cutFillTotals(rows);
  const shownTotals = area === 'site' ? (current?.site ?? null) : current ? pileTotals : null;
  const folded = foldSmall(counted);
  const maxBar = Math.max(1e-9, ...folded.shown.map((r) => Math.max(r.cutM3, r.fillM3)));
  const invDelta = pair ? inventoryChange(piles, pair.from, pair.to, isCounted) : null;
  // the note says the inventory change is smaller: only shown when it is
  const noteDelta =
    shownTotals !== null &&
    area === 'piles' &&
    invDelta !== null &&
    Math.abs(invDelta) < Math.abs(pileTotals.netM3)
      ? invDelta
      : null;

  const exportCsv = async () => {
    if (!current || !pair) return;
    const sorted = [...current.rows].sort((a, b) => a.netM3 - b.netM3);
    const data = cutFillCsv(sorted, {
      pile: t('volumes.col.pile'),
      cut: `${t('cutfill.cut')} ${unit}`,
      fill: `${t('cutfill.fill')} ${unit}`,
      net: `${t('cutfill.net')} ${unit}`,
      total: t('volumes.siteTotal'),
    });
    const name = `${t('volumes.segment.cutFill')} ${dateOf(pair.from)} ${dateOf(pair.to)}`;
    const r = await bridge.call('dialog:saveFile', { defaultName: `${fileBase(name)}.csv`, data });
    const message = r.ok ? r.value.error : r.error;
    if (message) setFailure({ key: runKey, message });
  };

  const pairOptions = dated.map((c) => (
    <option key={c.id} value={c.id}>
      {formatDate(c.date)}
    </option>
  ));
  const dot = (id: string) => (
    <span
      className="cf-dot"
      aria-hidden="true"
      style={{ background: tags[id]?.colour ?? 'var(--fg-3)' }}
    />
  );

  return (
    <div
      className={['cf', className].filter(Boolean).join(' ')}
      data-testid="cutfill-pane"
      aria-busy={computing}
    >
      {pair ? (
        <>
          <div className="cf-pair">
            <span className="cf-pick">
              {dot(pair.from)}
              <select
                className="cf-select"
                aria-label={t('cutfill.from')}
                value={pair.from}
                onChange={(e) => {
                  choose('from', e.target.value);
                }}
              >
                {pairOptions}
              </select>
            </span>
            <span className="cf-arrow" aria-hidden="true">
              →
            </span>
            <span className="cf-pick">
              {dot(pair.to)}
              <select
                className="cf-select"
                aria-label={t('cutfill.to')}
                value={pair.to}
                onChange={(e) => {
                  choose('to', e.target.value);
                }}
              >
                {pairOptions}
              </select>
            </span>
            <Button
              className="cf-export"
              disabled={!current || current.rows.length === 0}
              onClick={() => {
                void exportCsv();
              }}
            >
              {t('volumes.export')}
            </Button>
          </div>

          <div className="cf-controls">
            <div className="seg cf-area">
              {(['piles', 'site'] as CutFillArea[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={area === a}
                  onClick={() => {
                    cutFillPrefs.getState().setArea(a);
                  }}
                >
                  {a === 'piles' ? t('cutfill.insidePiles') : t('cutfill.wholeSite')}
                </button>
              ))}
            </div>
            <label className="cf-ignore">
              {t('cutfill.ignoreUnder')}
              <input
                className="cf-ignore-input"
                inputMode="decimal"
                aria-label={t('cutfill.ignoreAria')}
                aria-invalid={draftBad || undefined}
                value={draft}
                onChange={(e) => {
                  const text = e.target.value;
                  setTyped({ text, over: thresholdM });
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(() => {
                    commit(text);
                  }, THRESHOLD_PAUSE_MS);
                }}
                onBlur={() => {
                  commit(draft);
                  if (parseThreshold(draft) !== null) setTyped(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(draft);
                }}
              />
              {unitLabel('m')}
            </label>
          </div>

          {waitingFor ? (
            <p className="cf-status" role="status">
              {t('strip.waiting', { date: formatDate(dateOf(waitingFor)) })}
            </p>
          ) : error ? (
            <p className="cf-status cf-error" role="alert">
              {error}
            </p>
          ) : computing ? (
            <p className="cf-status" role="status">
              {t('vol.status.computing')}
            </p>
          ) : null}

          {shownTotals && !waitingFor ? (
            <>
              <div className="cf-kpi">
                <div className="cf-tile" data-kpi="cut">
                  <span className="cf-cap">{t('cutfill.cut')}</span>
                  <b className="cf-cut">{vol(shownTotals.cutM3)}</b>
                  <em>{t('cutfill.removed', { value: unit })}</em>
                </div>
                <div className="cf-tile" data-kpi="fill">
                  <span className="cf-cap">{t('cutfill.fill')}</span>
                  <b className="cf-fill">{vol(shownTotals.fillM3)}</b>
                  <em>{t('cutfill.added', { value: unit })}</em>
                </div>
                <div className="cf-tile" data-kpi="net">
                  <span className="cf-cap">{t('cutfill.net')}</span>
                  <b>{vol(shownTotals.netM3, true)}</b>
                  <em>
                    {area === 'piles'
                      ? t('cutfill.netPiles', { value: unit, count: pileTotals.counted })
                      : unit}
                  </em>
                </div>
              </div>
              {area === 'piles' && current?.site ? (
                <p className="cf-site-line">
                  {t('cutfill.wholeSiteLine', {
                    cut: vol(current.site.cutM3),
                    fill: vol(current.site.fillM3),
                    net: `${vol(current.site.netM3, true)} ${unit}`,
                  })}
                </p>
              ) : null}
            </>
          ) : null}

          {current && !waitingFor && counted.length > 0 ? (
            <section className="cf-bars" aria-label={t('cutfill.byPile')}>
              <div className="cf-bar-top">
                <h3 className="cf-bar-title">{t('cutfill.byPile')}</h3>
                <span className="cf-bar-head">{t('cutfill.byPileHeader', { unit })}</span>
              </div>
              <ol className="cf-bar-list">
                {folded.shown.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="cf-bar"
                      data-sign={r.netM3 < 0 ? 'cut' : r.netM3 > 0 ? 'fill' : 'none'}
                      onClick={
                        onPile
                          ? () => {
                              onPile(r.id);
                            }
                          : undefined
                      }
                      disabled={!onPile}
                    >
                      <span className="cf-bar-label">{r.label}</span>
                      <span className="cf-bar-cut" aria-hidden="true">
                        <i style={{ inlineSize: `${(r.cutM3 / maxBar) * 100}%` }} />
                      </span>
                      <span className="cf-bar-fill" aria-hidden="true">
                        <i style={{ inlineSize: `${(r.fillM3 / maxBar) * 100}%` }} />
                      </span>
                      <span className="cf-bar-value">{vol(r.netM3, true)}</span>
                    </button>
                  </li>
                ))}
              </ol>
              {folded.folded ? (
                <p className="cf-folded">
                  {t('cutfill.folded', {
                    count: folded.folded.count,
                    value: `${formatNumber(fromSI(folded.folded.withinM3, 'volume', units.volume), 0, locale)} ${unit}`,
                  })}
                </p>
              ) : null}
              {partial.length > 0 ? (
                <p className="cf-quiet">
                  {t('vol.view.partial', { names: partial.map((r) => r.label).join(', ') })}
                </p>
              ) : null}
            </section>
          ) : null}

          {current && refused.length > 0 && !waitingFor ? (
            <p className="cf-not-counted cf-quiet">
              {t('vol.view.notCounted')}:{' '}
              {refused
                .map((r) =>
                  t('vol.view.notCountedEntry', {
                    name: r.label,
                    reason: r.reason
                      ? t('vol.notCounted.failedWhy', { reason: r.reason })
                      : t('vol.notCounted.failed'),
                  }),
                )
                .join(', ')}
            </p>
          ) : null}

          {noteDelta !== null ? (
            <p className="cf-note">
              <span className="cf-note-mark" aria-hidden="true">
                i
              </span>
              <span>
                {t('cutfill.note', {
                  delta: `${volumeText(noteDelta, units, 0, locale, true)} ${unit}`,
                })}
              </span>
            </p>
          ) : null}
        </>
      ) : (
        <p className="cf-status">{t('vol.status.none')}</p>
      )}
    </div>
  );
}
