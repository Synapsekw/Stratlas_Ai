/**
 * The Volumes tab's header (volumetrics redesign, spec section 6, board 1): "Stockpile inventory",
 * the date in focus under it, Export on the right (every pile's volume over time as CSV), then
 * three tiles: Volume with the pile count, Tonnes by material, and the change since the previous
 * survey in m³ and %. The piles left out of the figures are named under them with why, so a figure
 * never shows without its status.
 */
import { localeOf } from '@aio/geo';
import { volumeSeriesCsv } from '@aio/project/export';
import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { densityOn, effectiveUnits, pileMaterial, pileSeries } from '@aio/survey';
import { Button, formatDate, useT } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { bridge } from '../../shell';
import { notCountedList } from '../BulkTotals';
import { isStale, seriesStale, useCompare } from '../compareStore';
import { fileBase } from '../exportHelpers';
import { useMeasure } from '../measureStore';
import { useInventory } from '../useInventory';
import { captureDateOf } from './surveyDates';
import { useTimelapseSurveys } from '../../workspace/dates/timelapse';
import { massParts, pctText, volumeParts } from '../pile/PileHeader';
import { minusSigned } from '../pile/pileView';
import type { InventoryModel } from './inventory';

export interface VolumesHeaderProps {
  /** The figures on the date in focus; null without a survey date. */
  model: InventoryModel | null;
  /** Every pile (Export writes them all). */
  piles: readonly SurveyMeasurement[];
}

export function VolumesHeader({ model, piles }: VolumesHeaderProps): ReactElement {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const kitDensityOf = useMeasure((s) => s.kitDensity);
  const captures = useCompare((s) => s.captures);
  const current = useCompare((s) => s.current);
  const [csvError, setCsvError] = useState<string | null>(null);
  // playing through the dates: the figures are the last survey passed's, never between surveys
  const playing = useTimelapseSurveys();
  const rows = useInventory(piles);
  const units = effectiveUnits(settings.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const vol = (m3: number) => volumeParts(m3, units, settings.precision.volume, locale);

  const exportCsv = async () => {
    setCsvError(null);
    // the stored result stands for its own date, as on the cards and in the chart
    const stored = new Map<string, ComparisonResult | undefined>();
    const ms = piles.map((m) => {
      const over = pileSeries(m);
      stored.set(m.id, over.stored);
      return { ...m, series: over.series };
    });
    // each date at the density its material had then
    const dateOf = captureDateOf(captures);
    const density = (m: SurveyMeasurement, capture: string) => {
      const material = pileMaterial(m, settings.materials, kitDensityOf);
      return material ? densityOn(material, capture, dateOf) : null;
    };
    // the card's stale rule: the stored figure by the fingerprints, a dated one by the series
    const staleRow = (m: SurveyMeasurement, r: ComparisonResult) =>
      r.status === 'stale' ||
      (r === stored.get(m.id) ? isStale({ current }, m, r) : seriesStale(m, r));
    const data = volumeSeriesCsv(ms, captures, units, settings.precision, {
      densityOf: density,
      isStale: staleRow,
    });
    const r = await bridge.call('dialog:saveFile', {
      defaultName: `${fileBase(t('volumes.title'))}.csv`,
      data,
    });
    if (!r.ok) setCsvError(r.error);
    else if (r.value.error) setCsvError(r.value.error);
  };

  const on = model?.on;
  const capture = captures.find((c) => c.id === on?.capture);
  const day = on ? formatDate(on.date) : '';
  // the date's own name when it has one ("drone survey"), after the date; never the date again
  const source =
    capture && !day.startsWith(capture.label) && !capture.label.startsWith(day)
      ? capture.label
      : null;

  // nothing counted on the date: no figure, never a zero (the status line says why)
  const volume = model && model.piles > 0 ? vol(model.volumeM3) : null;
  const tonnes = model?.tonnes != null ? massParts(model.tonnes, units, locale) : null;
  const change = model?.change ?? null;
  const changeParts = change ? vol(change.m3) : null;
  const sign = change && change.m3 < 0 ? 'loss' : change && change.m3 > 0 ? 'gain' : undefined;

  // the Next survey tile while playing: the change the next survey brings, by the inventory's
  // rule (since the nearest earlier date with counted piles, over the piles counted on both)
  const nextDay = playing?.next ?? null;
  const nextChange = nextDay
    ? (rows.find((r) => r.capture === nextDay.capture)?.change?.m3 ?? null)
    : null;
  const nextParts = nextChange !== null ? vol(nextChange) : null;
  const nextSign =
    nextChange !== null && nextChange < 0
      ? 'loss'
      : nextChange && nextChange > 0
        ? 'gain'
        : undefined;

  const names = new Map(piles.map((m) => [m.id, m.label]));
  const left = model?.notCounted ?? [];
  const partial = model?.partial ?? [];

  return (
    <header className="vh-head" data-testid="volumes-header">
      <div className="vh-top">
        <div className="vh-titles">
          <h3 className="vh-cap">{t('volumes.title')}</h3>
          {on && (
            <p className="vh-date" data-testid="volumes-date">
              {playing ? (
                t('timelapse.lastPassed', { date: day })
              ) : source ? (
                <>
                  {day} <span className="vh-src">· {source}</span>
                </>
              ) : (
                day
              )}
            </p>
          )}
        </div>
        <Button
          icon="download"
          disabled={captures.length === 0 || piles.length === 0}
          data-testid="volumes-csv"
          onClick={() => {
            void exportCsv();
          }}
        >
          {t('volumes.export')}
        </Button>
      </div>
      {csvError && (
        <p className="notice warn small" role="alert">
          {csvError}
        </p>
      )}

      {model && (
        <dl className="vh-kpi" data-testid="volumes-kpi">
          <div className="vh-tile">
            <dt className="vh-tcap">{t('volumes.kpi.volume')}</dt>
            <dd>
              <b data-testid="volumes-kpi-volume">
                {volume ? (
                  <>
                    {volume.num} <small>{volume.unit}</small>
                  </>
                ) : (
                  '-'
                )}
              </b>
              <em>{t('volumes.piles', { count: model.piles })}</em>
            </dd>
          </div>
          <div className="vh-tile">
            <dt className="vh-tcap">{t('volumes.kpi.tonnes')}</dt>
            <dd>
              <b data-testid="volumes-kpi-tonnes">
                {tonnes ? (
                  <>
                    {tonnes.num} <small>{tonnes.unit}</small>
                  </>
                ) : (
                  '-'
                )}
              </b>
              <em>{t('volumes.byMaterial')}</em>
            </dd>
          </div>
          {nextDay ? (
            <div className="vh-tile" data-testid="volumes-kpi-next">
              <dt className="vh-tcap">{t('strip.next')}</dt>
              <dd data-sign={nextSign}>
                <b>
                  {nextChange !== null && nextParts ? minusSigned(nextParts.num, nextChange) : '-'}
                </b>
                <em>{[...(nextParts ? [nextParts.unit] : []), nextDay.short].join(' · ')}</em>
              </dd>
            </div>
          ) : (
            <div className="vh-tile">
              <dt className="vh-tcap">
                {model.previous
                  ? t('volumes.vs', { date: formatDate(model.previous.date, { year: false }) })
                  : t('vol.change')}
              </dt>
              <dd data-sign={sign}>
                <b data-testid="volumes-kpi-change">
                  {change && changeParts ? minusSigned(changeParts.num, change.m3) : '-'}
                </b>
                <em>
                  {change && changeParts
                    ? [
                        changeParts.unit,
                        ...(change.pct !== null ? [pctText(change.pct, locale)] : []),
                      ].join(' · ')
                    : model.previous
                      ? ''
                      : t('pile.first')}
                </em>
              </dd>
            </div>
          )}
        </dl>
      )}

      {(left.length > 0 || partial.length > 0) && (
        <div className="vh-status" role="status" data-testid="volumes-status">
          {left.length > 0 && (
            <p>
              <b>{t('vol.view.notCountedOn', { count: left.length })}</b>:{' '}
              {notCountedList(left, names)}
            </p>
          )}
          {partial.length > 0 && (
            <p>
              {t('vol.view.partial', {
                names: partial.map((id) => names.get(id) ?? id).join(', '),
              })}
            </p>
          )}
        </div>
      )}
    </header>
  );
}
