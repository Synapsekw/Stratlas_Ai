/**
 * The volumes view (volumetric parity W3 and W4), the Volumes bench's body: every volume
 * measurement, or one folder's, as live cards in rows (a click opens one in the pile panel in
 * their place, with "‹ Inventory" back: volumetrics redesign, spec section 3), the total on the latest survey date (`BulkTotals`) and the site inventory over time,
 * the piles stacked per survey date with a table. Both totals are rows of one `inventorySeries`, so
 * they agree: a total adds current figures only, and every pile left out is named with why (stale,
 * no survey data, not computed yet, could not compute, no comparison), never counted as zero.
 * Without a volume measurement it says so and offers Draw volume and Detect piles.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatQuantity, localeOf } from '@aio/geo';
import { volumeSeriesCsv } from '@aio/project/export';
import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import {
  inventoryPiles,
  pileMaterial,
  pileSeries,
  surfacesStamp,
  type StackRow,
} from '@aio/survey';
import { Button, EmptyState, Tip, useT } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { TimeChart } from '../charts/TimeChart';
import { processing } from '../processing/store';
import { bridge, useShell } from '../shell';
import { BulkTotals, notCountedList } from './BulkTotals';
import { cardModel, MeasureCard } from './card';
import { computeSeries, isStale, seriesStale, useCompare } from './compareStore';
import { fileBase } from './exportHelpers';
import { useTimeline } from '../workspace/timeline';
import { captureInFocus } from './measureRows';
import { knownTemplates, measureFolders, select, startTool, useMeasure } from './measureStore';
import { PilePanel } from './pile/PilePanel';
import { setSeriesFailed, useInventory } from './useInventory';
import { pickInVolumesView } from './volumesPick';
import './compare.css';
import './volumesView.css';

/** The filter's value for every pile (folders are never empty, so it cannot clash). */
const ALL = '';
/** The stockpile job file the pile detection runs from (written by the new project wizard). */
export const PILE_JOB = 'volumetric/job.json';

/** What a pile's dates were last worked out for: its edits and its comparisons. */
const stampOf = (m: SurveyMeasurement) =>
  `${m.updatedAt ?? m.createdAt}|${JSON.stringify(m.items)}|${String(m.points.length)}`;

export function VolumesView({ className }: { className?: string }): ReactElement {
  const t = useT();
  const file = useMeasure((s) => s.file);
  const settings = useMeasure((s) => s.settings);
  const kitDensityOf = useMeasure((s) => s.kitDensity);
  const templates = useMeasure((s) => s.templates);
  const focus = useMeasure((s) => s.focus);
  const fileReadOnly = useMeasure((s) => s.readOnly);
  const read = useMeasure((s) => s.status === 'ready');
  const lookOnly = useAnnotateReadOnly();
  const readOnly = lookOnly || fileReadOnly;
  const status = useCompare((s) => s.status);
  const captures = useCompare((s) => s.captures);
  const surfaces = useCompare((s) => s.surfaces);
  const current = useCompare((s) => s.current);
  const root = useWorkspace((s) => s.project?.root ?? null);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const pkg = useShell((s) => s.pkg !== null);
  const [folder, setFolder] = useState(ALL);
  const [csvError, setCsvError] = useState<string | null>(null);

  const allPiles = useMemo(() => inventoryPiles(file.measurements), [file]);
  const folders = useMemo(
    () => measureFolders({ ...file, measurements: allPiles }),
    [file, allPiles],
  );
  // a folder emptied or renamed elsewhere falls back to every pile
  const shown = folder !== ALL && folders.includes(folder) ? folder : ALL;
  const piles = useMemo(() => inventoryPiles(allPiles, shown), [allPiles, shown]);
  const stack = useInventory(piles);
  // the date in focus (the notch's), else the latest: the cards and the total read it
  const timelineFocus = useTimeline((st) => st.focus);
  const inFocus = captureInFocus(timelineFocus, { captures });
  const shownRow = stack.find((r) => r.capture === inFocus) ?? stack.at(-1);
  const names = useMemo(() => new Map(piles.map((m) => [m.id, m.label])), [piles]);
  // a pile opened from anywhere (3D, the map, the sidebar) opens here even when the folder filter
  // hides it: the filter goes back to every pile, so the inventory behind it holds it too
  const focused = allPiles.find((m) => m.id === focus) ?? null;
  const outside = focused !== null && !piles.some((m) => m.id === focused.id);
  // (set while rendering, React's way to follow a prop: no effect, no frame of the old filter)
  if (outside && folder !== ALL) setFolder(ALL);

  // each pile's volume per survey date, worked out when shown (carried piles keep the kit's);
  // only the piles changed since their last run are run again, every pile once the dates or the
  // prepared surfaces change (a run made before Prepare surfaces is redone)
  const ran = useRef(new Map<string, string>());
  const ranFor = useRef('');
  const runFor = `${status}|${String(lookOnly)}|${captures.map((c) => c.id).join(',')}|${surfacesStamp(surfaces)}`;
  useEffect(() => {
    if (ranFor.current !== runFor) {
      ran.current.clear();
      ranFor.current = runFor;
    }
    // a read-only project works its dates out too, held in memory and never written
    if (status !== 'ready' || lookOnly || captures.length === 0) return;
    const todo = piles.filter((m) => m.items.length > 0 && ran.current.get(m.id) !== stampOf(m));
    if (todo.length === 0) return;
    const run = { gone: false };
    void (async () => {
      for (const m of todo) {
        if (run.gone) return;
        const stamp = stampOf(m);
        try {
          await computeSeries(m.id);
          setSeriesFailed(m.id, null);
        } catch (e) {
          // the card says it too; every total names the pile as not counted, with why
          console.warn(`The volume over time of ${m.id} could not be worked out`, e);
          setSeriesFailed(m.id, e instanceof Error ? e.message : String(e));
        }
        ran.current.set(m.id, stamp);
      }
    })();
    return () => {
      run.gone = true;
    };
  }, [status, lookOnly, captures.length, piles, runFor]);

  // Detect piles runs from the stockpile job file: offered only when the project has one, looked
  // for once the measurements are read and none is a pile (a project with piles fetches nothing)
  const [hasJob, setHasJob] = useState<boolean | null>(null);
  useEffect(() => {
    if (projectId === null || !read || allPiles.length > 0) return;
    let gone = false;
    void fetch(assetUrl(projectId, { path: PILE_JOB }))
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        if (!gone) setHasJob(ok);
      });
    return () => {
      gone = true;
    };
  }, [projectId, read, allPiles.length]);

  if (allPiles.length === 0) {
    const detectWhy = readOnly
      ? t('actions.reason.readOnly')
      : pkg
        ? t('actions.reason.package')
        : root === null || hasJob === false
          ? t('vol.view.noJob')
          : undefined;
    return (
      <div className={['vv', className].filter(Boolean).join(' ')} data-testid="volumes-view">
        <EmptyState
          icon="pile"
          title={t('empty.volumes.title')}
          body={t('vol.view.emptyHint')}
          action={
            <>
              <Button
                variant="primary"
                icon="polygon"
                disabledReason={readOnly ? t('actions.reason.readOnly') : undefined}
                data-testid="volumes-draw"
                onClick={() => {
                  startTool('volume');
                }}
              >
                {t('mcard.drawVolume')}
              </Button>
              <Button
                icon="pile"
                disabled={hasJob === null}
                disabledReason={detectWhy}
                data-testid="volumes-detect"
                onClick={() => {
                  if (root !== null)
                    processing.getState().openDialog({
                      pipeline: 'volumetric.build',
                      project: root,
                      values: { job: PILE_JOB },
                    });
                }}
              >
                {t('mcard.detectPiles')}
              </Button>
            </>
          }
        />
      </div>
    );
  }

  // the focused pile opens in the pile panel, stepping through the piles in this view's order
  if (focused)
    return (
      <div
        className={['vv', 'vv-open', className].filter(Boolean).join(' ')}
        data-testid="volumes-view"
      >
        <PilePanel id={focused.id} order={(outside ? allPiles : piles).map((m) => m.id)} />
      </div>
    );
  // the cards read each pile's figure on the date in focus, as the sidebar and the labels do
  const ctx = {
    settings,
    templates: knownTemplates({ templates, settings }),
    captures,
    capture: inFocus ?? undefined,
  };
  const units = settings.units;
  const locale = settings.locale ?? localeOf(units.distance);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);

  const exportCsv = async () => {
    setCsvError(null);
    // the stored result stands for its own date, as on the cards and in the chart
    const stored = new Map<string, ComparisonResult | undefined>();
    const ms = piles.map((m) => {
      const over = pileSeries(m);
      stored.set(m.id, over.stored);
      return { ...m, series: over.series };
    });
    const density = (m: SurveyMeasurement) =>
      pileMaterial(m, settings.materials, kitDensityOf)?.densityTPerM3 ?? null;
    // the card's stale rule: the stored figure by the fingerprints, a dated one by the series
    const staleRow = (m: SurveyMeasurement, r: ComparisonResult) =>
      r.status === 'stale' ||
      (r === stored.get(m.id) ? isStale({ current }, m, r) : seriesStale(m, r));
    const data = volumeSeriesCsv(ms, captures, units, settings.precision, {
      densityOf: density,
      isStale: staleRow,
    });
    const name = shown === ALL ? t('vol.inventory') : `${t('vol.inventory')} ${shown}`;
    const r = await bridge.call('dialog:saveFile', { defaultName: `${fileBase(name)}.csv`, data });
    if (!r.ok) setCsvError(r.error);
    else if (r.value.error) setCsvError(r.value.error);
  };
  // the chart draws the dates with counted piles (a date with none is in the table, never a 0 bar)
  const charted = stack.filter((r) => r.parts.length > 0);

  return (
    <div className={['vv', className].filter(Boolean).join(' ')} data-testid="volumes-view">
      <div className="vv-bar">
        <select
          className="sv-input"
          aria-label={t('vol.view.folder')}
          value={shown}
          data-testid="volumes-folder"
          onChange={(e) => {
            setFolder(e.currentTarget.value);
          }}
        >
          <option value={ALL}>{t('mcard.allPiles')}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <Button
          variant="quiet"
          icon="download"
          disabled={captures.length === 0}
          data-testid="volumes-csv"
          onClick={() => {
            void exportCsv();
          }}
        >
          {t('chart.csv')}
        </Button>
      </div>
      {csvError && (
        <p className="notice warn small" role="alert">
          {csvError}
        </p>
      )}

      <ul className="vv-piles" aria-label={t('mcard.allPiles')}>
        {piles.map((m) => (
          <li key={m.id}>
            <PileRow
              id={m.id}
              onPick={() => {
                // opened in the pile panel here: the sidebar stays on this view
                pickInVolumesView(m.id);
                select([m.id], m.id);
              }}
            >
              <MeasureCard model={cardModel(m, ctx)} variant="live" measureId={m.id} />
            </PileRow>
          </li>
        ))}
      </ul>

      {/* the date in focus's row (the latest without one), the same the table marks current */}
      <BulkTotals inventory={{ piles, row: shownRow, names }} />

      {stack.length > 0 && (
        <section className="vd-time vv-inventory" data-testid="volumes-inventory">
          <h3 className="vd-sub">{t('vol.inventory')}</h3>
          {charted.length > 0 && (
            <TimeChart
              data={{ kind: 'stack', rows: charted, names }}
              units={units}
              precision={settings.precision}
              locale={locale}
              testId="volumes-inventory-chart"
            />
          )}
          <InventoryTable rows={stack} current={shownRow} names={names} v={v} />
        </section>
      )}
    </div>
  );
}

/** One pile in the list: its live card (read out as it is); a click opens it in the pile panel. */
function PileRow({
  id,
  onPick,
  children,
}: {
  id: string;
  onPick: () => void;
  children: ReactElement;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick();
    }
  };
  return (
    <div
      className="vv-pile"
      role="button"
      tabIndex={0}
      data-testid="volumes-pile"
      data-id={id}
      onClick={onPick}
      onKeyDown={onKey}
    >
      {children}
    </div>
  );
}

/**
 * The inventory per date: the total of the counted piles (partly outside the survey marked), the
 * change over the piles counted on both dates, and every pile not counted with why.
 */
function InventoryTable({
  rows,
  current,
  names,
  v,
}: {
  rows: readonly StackRow[];
  /** The row the total above shows (the date in focus): marked current. */
  current: StackRow | undefined;
  names: ReadonlyMap<string, string>;
  v: (x: number) => string;
}) {
  const t = useT();
  // the latest survey date (counted piles or not)
  const latest = rows.at(-1);
  const nameList = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? id).join(', ');
  return (
    <table className="vd-time-table" data-testid="volumes-inventory-table">
      <caption className="sr-only">{t('vol.inventory')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('chart.date')}</th>
          <th scope="col">{t('chart.volume')}</th>
          <th scope="col">{t('vol.change')}</th>
          <th scope="col">{t('vol.view.notCounted')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const counted = r.parts.length > 0;
          const partial = r.partial ?? [];
          const change = r.change ?? null;
          const partialNote =
            partial.length > 0 ? t('vol.view.partial', { names: nameList(partial) }) : '';
          return (
            <tr
              key={r.capture}
              data-capture={r.capture}
              data-latest={r === latest ? '' : undefined}
              data-partial={partial.length > 0 ? '' : undefined}
              aria-current={r === current ? 'date' : undefined}
            >
              <th scope="row">{r.label}</th>
              <td data-testid="volumes-inventory-value">
                {!counted ? (
                  t('vol.view.notCounted')
                ) : partial.length > 0 ? (
                  <Tip content={partialNote} placement="top">
                    <span className="vv-partial" tabIndex={0}>
                      {v(r.totalM3)}
                      <span className="sr-only">. {partialNote}</span>
                    </span>
                  </Tip>
                ) : (
                  v(r.totalM3)
                )}
              </td>
              <td data-testid="volumes-inventory-change">
                {change === null
                  ? ''
                  : `${change.m3 > 0 ? '+' : ''}${v(change.m3)}${
                      change.piles < change.of
                        ? ` (${t('vol.view.ofPiles', { n: change.piles, count: change.of })})`
                        : ''
                    }`}
              </td>
              <td className="vv-missing" data-testid="volumes-inventory-left">
                {notCountedList(r.notCounted ?? [], names)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
