/**
 * The volumes view (volumetric parity W3 and W4), the Volumes bench's body: every volume
 * measurement, or one folder's, as live cards in rows (a click focuses one in the detail card
 * under them), the current totals from the engine's results (`BulkTotals`, unchanged maths) and
 * the site inventory over time, the piles stacked per survey date with a table. A date where a pile
 * has no figure names it and never counts it as zero. Without a volume measurement it says so and
 * offers Draw volume and Detect piles.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatQuantity, localeOf } from '@aio/geo';
import { volumeSeriesCsv } from '@aio/project/export';
import type { SurveyMeasurement } from '@aio/schema';
import { inventoryPiles, inventorySeries, pileSeries, type StackRow } from '@aio/survey';
import { Button, EmptyState, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import { TimeChart } from '../charts/TimeChart';
import { processing } from '../processing/store';
import { bridge, useShell } from '../shell';
import { BulkTotals } from './BulkTotals';
import { CardActions, CardMenu, cardModel, MeasureCard } from './card';
import { VolumeDetail } from './card/VolumeDetail';
import { computeSeries, useCompare } from './compareStore';
import { fileBase } from './exportHelpers';
import {
  knownTemplates,
  measureFolders,
  renameMeasurement,
  select,
  startTool,
  useMeasure,
} from './measureStore';
import './compare.css';
import './volumesView.css';

/** The filter's value for every pile (folders are never empty, so it cannot clash). */
const ALL = '';

export function VolumesView({ className }: { className?: string }): ReactElement {
  const t = useT();
  const file = useMeasure((s) => s.file);
  const settings = useMeasure((s) => s.settings);
  const templates = useMeasure((s) => s.templates);
  const focus = useMeasure((s) => s.focus);
  const fileReadOnly = useMeasure((s) => s.readOnly);
  const readOnly = useAnnotateReadOnly() || fileReadOnly;
  const status = useCompare((s) => s.status);
  const captures = useCompare((s) => s.captures);
  const root = useWorkspace((s) => s.project?.root ?? null);
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
  const stack = useMemo(
    () => inventorySeries(piles, captures, { folder: shown }),
    [piles, captures, shown],
  );
  const names = useMemo(() => new Map(piles.map((m) => [m.id, m.label])), [piles]);

  // each pile's volume per survey date, worked out when shown (carried piles keep the kit's)
  const seriesKey = piles.map((m) => `${m.id}@${m.updatedAt ?? m.createdAt}`).join(',');
  useEffect(() => {
    if (status !== 'ready' || readOnly || captures.length === 0 || seriesKey === '') return;
    const run = { gone: false };
    void (async () => {
      for (const id of seriesKey.split(',').map((k) => k.slice(0, k.lastIndexOf('@')))) {
        if (run.gone) return;
        // each card says why its own dates failed; the inventory shows the dates it has
        await computeSeries(id).catch((e: unknown) => {
          console.warn(`The volume over time of ${id} could not be worked out`, e);
        });
      }
    })();
    return () => {
      run.gone = true;
    };
  }, [status, readOnly, captures.length, seriesKey]);

  if (allPiles.length === 0)
    return (
      <div className={['vv', className].filter(Boolean).join(' ')} data-testid="volumes-view">
        <EmptyState
          icon="pile"
          title={t('empty.volumes.title')}
          body={t('empty.volumes.hint')}
          action={
            <>
              <Button
                variant="primary"
                icon="polygon"
                disabled={readOnly}
                data-testid="volumes-draw"
                onClick={() => {
                  startTool('volume');
                }}
              >
                {t('mcard.drawVolume')}
              </Button>
              <Button
                icon="pile"
                disabled={readOnly || pkg || root === null}
                data-testid="volumes-detect"
                onClick={() => {
                  if (root !== null)
                    processing
                      .getState()
                      .openDialog({ pipeline: 'volumetric.build', project: root, values: {} });
                }}
              >
                {t('mcard.detectPiles')}
              </Button>
            </>
          }
        />
      </div>
    );

  const focused = piles.find((m) => m.id === focus) ?? null;
  const ctx = { settings, templates: knownTemplates({ templates, settings }), captures };
  const units = settings.units;
  const locale = settings.locale ?? localeOf(units.distance);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);

  const exportCsv = async () => {
    setCsvError(null);
    // the stored result stands for its own date, as on the cards and in the chart
    const ms = piles.map((m) => ({ ...m, series: pileSeries(m) }));
    const density = (m: SurveyMeasurement) =>
      settings.materials.find((x) => x.id === m.material)?.densityTPerM3 ?? null;
    const data = volumeSeriesCsv(ms, captures, units, settings.precision, { densityOf: density });
    const name = shown === ALL ? t('vol.inventory') : `${t('vol.inventory')} ${shown}`;
    const r = await bridge.call('dialog:saveFile', { defaultName: `${fileBase(name)}.csv`, data });
    if (!r.ok) setCsvError(r.error);
    else if (r.value.error) setCsvError(r.value.error);
  };

  return (
    <div className={['vv', className].filter(Boolean).join(' ')} data-testid="volumes-view">
      <div className="vv-bar">
        <select
          className="sv-input"
          aria-label={t('layerProps.folder')}
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
              m={m}
              pressed={m.id === focused?.id}
              onPick={() => {
                select([m.id], m.id);
              }}
            >
              <MeasureCard model={cardModel(m, ctx)} variant="live" measureId={m.id} />
            </PileRow>
          </li>
        ))}
      </ul>

      {focused && (
        <div className="vv-detail">
          <MeasureCard
            model={cardModel(focused, ctx)}
            variant="detail"
            measureId={focused.id}
            testId="volumes-detail"
            slots={{ detail: <VolumeDetail m={focused} /> }}
            menu={<CardMenu id={focused.id} />}
            actions={<CardActions id={focused.id} />}
            {...(readOnly
              ? {}
              : {
                  onRename: (name: string) => {
                    renameMeasurement(focused.id, name);
                  },
                })}
          />
        </div>
      )}

      <BulkTotals piles={piles} />

      {stack.length > 0 && (
        <section className="vd-time vv-inventory" data-testid="volumes-inventory">
          <h4 className="vd-sub">{t('vol.inventory')}</h4>
          <TimeChart
            data={{ kind: 'stack', rows: stack, names }}
            units={units}
            precision={settings.precision}
            testId="volumes-inventory-chart"
          />
          <InventoryTable rows={stack} names={names} v={v} />
        </section>
      )}
    </div>
  );
}

/** One pile in the list: its live card, pressed when it is the one in the detail card. */
function PileRow({
  m,
  pressed,
  onPick,
  children,
}: {
  m: SurveyMeasurement;
  pressed: boolean;
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
      aria-pressed={pressed}
      aria-label={m.label}
      data-testid="volumes-pile"
      data-id={m.id}
      onClick={onPick}
      onKeyDown={onKey}
    >
      {children}
    </div>
  );
}

/** The inventory per date: the total, the change since the date before, and who has no figure. */
function InventoryTable({
  rows,
  names,
  v,
}: {
  rows: readonly StackRow[];
  names: ReadonlyMap<string, string>;
  v: (x: number) => string;
}) {
  const t = useT();
  const latest = rows.findLast((r) => r.parts.length > 0);
  // each date's total (null without a figure) and the change since the last date with one
  const lines = rows.reduce<{ r: StackRow; value: number | null; change: number | null }[]>(
    (out, r) => {
      const value = r.parts.length > 0 ? r.totalM3 : null;
      const prev = out.findLast((x) => x.value !== null)?.value ?? null;
      out.push({ r, value, change: value !== null && prev !== null ? value - prev : null });
      return out;
    },
    [],
  );
  return (
    <table className="vd-time-table" data-testid="volumes-inventory-table">
      <caption className="sr-only">{t('vol.inventory')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('chart.date')}</th>
          <th scope="col">{t('chart.volume')}</th>
          <th scope="col">{t('vol.change')}</th>
          <th scope="col">{t('mcard.noData')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map(({ r, value, change }) => {
          return (
            <tr
              key={r.capture}
              data-latest={r === latest ? '' : undefined}
              aria-current={r === latest ? 'date' : undefined}
            >
              <th scope="row">{r.label}</th>
              <td>{value !== null ? v(value) : t('mcard.noData')}</td>
              <td>{change !== null ? `${change > 0 ? '+' : ''}${v(change)}` : ''}</td>
              <td className="vv-missing">
                {r.missing.map((id) => names.get(id) ?? id).join(', ')}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
