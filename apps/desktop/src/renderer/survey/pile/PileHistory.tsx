/**
 * The pile panel's History (spec section 3, board 3): "Volume and tonnes over time" with m³ | t |
 * Both, one bar per survey date with its value and the change in %, then the table (newest first:
 * date, volume, density, tonnes, change, "first" on the earliest; a kit figure the standard-base
 * figure replaced shows as "was" under its date), the density note, Export CSV and Add to report.
 */
import { formatNumber, fromSI, unitLabel } from '@aio/geo';
import { volumeSeriesCsv } from '@aio/project/export';
import type { ComparisonResult } from '@aio/schema';
import { pileSeries, seriesDate, type TimeRow } from '@aio/survey';
import { Button, useT } from '@aio/ui';
import { useMemo, useState, type ReactElement } from 'react';
import { TimeChart, type TimeValueOf } from '../../charts/TimeChart';
import { addToReport } from '../../report/templateStore';
import { bridge } from '../../shell';
import { useCompare } from '../compareStore';
import { fileBase } from '../exportHelpers';
import { massParts, volumeParts } from './PileHeader';
import type { PileData } from './PilePanel';
import { minusSigned, usePileView, wasFigure, type HistoryUnit } from './pileView';

const DENSITY_DECIMALS = 2;

export function PileHistory({ data }: { data: PileData }): ReactElement {
  const t = useT();
  const { m, settings, units, locale, material, rows } = data;
  const unit = usePileView((s) => s.historyUnit);
  const setUnit = usePileView((s) => s.setHistoryUnit);
  const captures = useCompare((s) => s.captures);
  const [done, setDone] = useState<{ text: string; warn: boolean } | null>(null);
  const decimals = settings.precision.volume;
  const vol = (x: number) => volumeParts(x, units, decimals, locale).num;
  const mass = (x: number) => massParts(x, units, locale).num;
  const density = material?.densityTPerM3;
  const was = wasFigure(m);
  const firstWithValue = rows.find((r) => r.valueM3 !== null);
  const shownRows = [...rows].reverse();

  const tonnes: TimeValueOf = useMemo(
    () => ({
      // tonnes in the site's mass unit (the formatter's mass is SI kilograms)
      value: (r: TimeRow) =>
        r.tonnes === null ? null : fromSI(r.tonnes * 1000, 'mass', units.mass),
      format: (x: number) => formatNumber(x, 0, locale),
    }),
    [units.mass, locale],
  );
  const axisTitle = (label: string, u: string) => t('chart.axisTitle', { label, unit: u });
  const volumeChart = (
    <TimeChart
      data={{ kind: 'volume', rows }}
      bars
      yTitle={axisTitle(t('chart.volume'), unitLabel(units.volume))}
      units={units}
      precision={settings.precision}
      locale={locale}
      height={196}
      testId="pile-history-chart"
    />
  );
  const tonnesChart =
    density !== undefined ? (
      <TimeChart
        data={{ kind: 'volume', rows }}
        bars
        values={tonnes}
        yTitle={axisTitle(t('pile.tonnes'), unitLabel(units.mass))}
        units={units}
        precision={settings.precision}
        locale={locale}
        height={196}
        testId="pile-history-chart"
      />
    ) : (
      <p className="small faint">{t('pile.pickMaterial')}</p>
    );

  const exportCsv = async () => {
    setDone(null);
    const over = pileSeries(m);
    const staleOf = new Map(rows.map((r) => [r.capture, r.stale]));
    const csv = volumeSeriesCsv(
      [{ ...m, series: over.series }],
      captures,
      units,
      settings.precision,
      {
        densityOf: () => density ?? null,
        isStale: (_m, r: ComparisonResult) =>
          r.status === 'stale' || staleOf.get(seriesDate(r)) === true,
      },
    );
    const r = await bridge.call('dialog:saveFile', {
      defaultName: `${fileBase(m.label)}.csv`,
      data: csv,
    });
    if (!r.ok) setDone({ text: r.error, warn: true });
    else if (r.value.error) setDone({ text: r.value.error, warn: true });
  };
  const report = () => {
    setDone(null);
    addToReport(m.id).then(
      (r) => {
        setDone({ text: t(r === 'added' ? 'report.added' : 'report.already'), warn: false });
      },
      (e: unknown) => {
        setDone({ text: e instanceof Error ? e.message : String(e), warn: true });
      },
    );
  };

  const units3: { id: HistoryUnit; label: string }[] = [
    { id: 'm3', label: unitLabel(units.volume) },
    { id: 't', label: unitLabel(units.mass) },
    { id: 'both', label: t('pile.history.both') },
  ];

  return (
    <div className="pp-history" data-testid="pile-history">
      <div className="pp-row">
        <h3 className="pp-sub" data-testid="pile-history-title">
          {t('pile.history.title')}
        </h3>
        <div
          className="seg"
          role="group"
          aria-label={t('pile.history.title')}
          data-testid="pile-history-unit"
        >
          {units3.map((u) => (
            <button
              key={u.id}
              type="button"
              aria-pressed={unit === u.id}
              onClick={() => {
                setUnit(u.id);
              }}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>

      {unit !== 't' && volumeChart}
      {unit !== 'm3' && tonnesChart}

      <table className="pp-table" data-testid="pile-history-table">
        <caption className="sr-only">{t('pile.history.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.date')}</th>
            <th scope="col">{`${t('chart.volume')} ${unitLabel(units.volume)}`}</th>
            <th scope="col">{t('pile.density')}</th>
            <th scope="col">{t('pile.tonnes')}</th>
            <th scope="col">{t('vol.change')}</th>
          </tr>
        </thead>
        <tbody>
          {shownRows.map((r) => (
            <tr
              key={r.capture}
              data-capture={r.capture}
              data-latest={r.latest ? '' : undefined}
              data-stale={r.stale ? '' : undefined}
              aria-current={r.latest ? 'date' : undefined}
            >
              <th scope="row">{r.label}</th>
              <td>
                {r.valueM3 !== null ? vol(r.valueM3) : t('mcard.notMeasured')}
                {was?.capture === r.capture && (
                  <span className="pp-was" data-testid="pile-history-was">
                    {t('pile.history.was', { value: vol(was.netM3) })}
                  </span>
                )}
              </td>
              <td>
                {density !== undefined && r.valueM3 !== null
                  ? formatNumber(density, DENSITY_DECIMALS, locale)
                  : ''}
              </td>
              <td>{r.tonnes !== null ? mass(r.tonnes) : ''}</td>
              <td data-sign={r.changeM3 === null ? undefined : r.changeM3 < 0 ? 'loss' : 'gain'}>
                {r === firstWithValue
                  ? t('pile.history.first')
                  : r.changeM3 !== null
                    ? minusSigned(vol(r.changeM3), r.changeM3)
                    : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {material && firstWithValue && density !== undefined && (
        <p className="pp-note" data-testid="pile-history-note">
          {t('pile.history.note', {
            density: formatNumber(density, DENSITY_DECIMALS, locale),
            material: material.name,
            date: firstWithValue.label,
          })}
        </p>
      )}

      <div className="pp-actions">
        <Button
          icon="download"
          data-testid="pile-history-csv"
          disabled={rows.length === 0}
          onClick={() => {
            void exportCsv();
          }}
        >
          {`${t('chart.export')} ${t('chart.csv')}`}
        </Button>
        <Button variant="primary" icon="report" data-testid="pile-history-report" onClick={report}>
          {t('chart.addToReport')}
        </Button>
      </div>
      {done && (
        <p
          className={done.warn ? 'notice warn small' : 'small faint'}
          role={done.warn ? 'alert' : 'status'}
          data-testid="pile-history-done"
        >
          {done.text}
        </p>
      )}
    </div>
  );
}
