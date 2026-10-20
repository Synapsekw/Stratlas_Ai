/**
 * Bulk selection (M11 G4, PRD SRV-1): running totals of the selected measurements' comparisons
 * (best with one template, so the items line up), and one change for all of them: a side of an
 * item, or the units. Totals add current results only; stale or refused ones are counted apart.
 *
 * Given `inventory` (the volumes view), it shows the total of the piles shown on the latest survey
 * date instead: that date's row of the site inventory (`inventorySeries`), so the total and the
 * chart come from one function. What is not counted is named with why, never added, and a total
 * with nothing counted shows no figure (never 0). A selection of volumes is totalled the same way
 * (`useInventory`), so the selection and the volumes view cannot disagree.
 */
import { formatQuantity, localeOf, unitName } from '@aio/geo';
import { AreaUnit, VolumeUnit, type SurfaceRef, type SurveyMeasurement } from '@aio/schema';
import {
  bulkTotals,
  effectiveUnits,
  isBase,
  polygonAreas,
  setSideForAll,
  setUnitsForAll,
  sideFor,
  sideOptions,
  type BulkSide,
  type NotCounted,
  type StackRow,
} from '@aio/survey';
import { Button, t as tr, useT } from '@aio/ui';
import { useMemo, useState, type ReactElement } from 'react';
import { computeAll, isStale, useCompare } from './compareStore';
import { knownTemplates, replaceMeasurement, useMeasure } from './measureStore';
import { useInventory } from './useInventory';

const NO_PILES: readonly SurveyMeasurement[] = [];

/** Why a pile is not in a total, in words ("stale", "could not compute: …"). */
export function notCountedReason(n: NotCounted): string {
  switch (n.reason) {
    case 'stale':
      return tr('vol.notCounted.stale');
    case 'no-data':
      return tr('vol.notCounted.noData');
    case 'not-computed':
      return tr('vol.notCounted.notComputed');
    case 'failed':
      return n.detail
        ? tr('vol.notCounted.failedWhy', { reason: n.detail })
        : tr('vol.notCounted.failed');
    case 'no-comparison':
      return tr('vol.notCounted.noComparison');
  }
}

/** The piles left out of a total, each with why: "Pile 1 (stale), Pile 2 (no survey data)". */
export function notCountedList(
  list: readonly NotCounted[],
  names: ReadonlyMap<string, string>,
): string {
  return list
    .map((n) =>
      tr('vol.view.notCountedEntry', {
        name: names.get(n.id) ?? n.id,
        reason: notCountedReason(n),
      }),
    )
    .join(', ');
}

export interface InventoryTotalsProps {
  /** The piles shown (their outlines give the area). */
  piles: readonly SurveyMeasurement[];
  /** The site inventory's row of the latest survey date. */
  row: StackRow | undefined;
  names: ReadonlyMap<string, string>;
}

export function BulkTotals(p: { inventory?: InventoryTotalsProps } = {}): ReactElement | null {
  return p.inventory ? <InventoryTotals {...p.inventory} /> : <SelectionTotals />;
}

/** A figure no pile is counted for: never shown as 0. */
const NONE = '-';

/**
 * One inventory row's figures: cut, fill and net of the counted piles, and the area of those same
 * piles. `none` when nothing is counted (or there is no row): the figures are then not shown.
 */
function rowFigures(row: StackRow | undefined, piles: readonly SurveyMeasurement[]) {
  const counted = new Set(row?.parts.map((p) => p.id) ?? []);
  return {
    none: counted.size === 0,
    cutM3: row?.cutM3 ?? 0,
    fillM3: row?.fillM3 ?? 0,
    netM3: row?.totalM3 ?? 0,
    areaM2: piles
      .filter((m) => counted.has(m.id))
      .reduce((sum, m) => sum + polygonAreas(m.points).horizontalM2, 0),
  };
}

/** The piles left out of a row's total, and those partly outside the survey, in words. */
function RowNotes({
  row,
  piles,
  names,
}: {
  row: StackRow | undefined;
  piles: readonly SurveyMeasurement[];
  names: ReadonlyMap<string, string>;
}) {
  const t = useT();
  // no row: no survey date at all, so no pile has survey data
  const left: readonly NotCounted[] =
    row?.notCounted ?? (row ? [] : piles.map((m) => ({ id: m.id, reason: 'no-data' as const })));
  const partial = row?.partial ?? [];
  return (
    <>
      {left.length > 0 && (
        <p className="small faint" data-testid="survey-bulk-not-counted">
          {t('vol.view.notCountedOn', { count: left.length })}: {notCountedList(left, names)}
        </p>
      )}
      {partial.length > 0 && (
        <p className="small faint" data-testid="survey-bulk-partial">
          {t('vol.view.partial', { names: partial.map((id) => names.get(id) ?? id).join(', ') })}
        </p>
      )}
    </>
  );
}

/** The volumes view's total: the latest date's row, in the site's units. */
function InventoryTotals({ piles, row, names }: InventoryTotalsProps) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const [busy, setBusy] = useState(false);
  if (piles.length === 0) return null;
  const units = settings.units;
  const locale = settings.locale ?? localeOf(units.distance);
  const f = rowFigures(row, piles);
  const v = (x: number) =>
    f.none ? NONE : formatQuantity(x, 'volume', units, settings.precision, locale);
  const a = (x: number) =>
    f.none ? NONE : formatQuantity(x, 'area', units, settings.precision, locale);
  return (
    <section
      className="sv-card sv-panel"
      aria-label={row ? t('vol.view.totalOn', { date: row.label }) : t('vol.card.total')}
      data-testid="survey-bulk"
      data-inventory=""
    >
      <header className="sv-head" role="none">
        <h2>{row ? t('vol.view.totalOn', { date: row.label }) : t('vol.card.total')}</h2>
      </header>
      <table className="sv-readout" data-testid="survey-bulk-totals">
        <caption className="sr-only">{t('bulk.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">{t('vol.card.total')}</span>
            </th>
            <th scope="col">{t('bulk.col.cut')}</th>
            <th scope="col">{t('bulk.col.fill')}</th>
            <th scope="col">{t('bulk.col.net')}</th>
          </tr>
        </thead>
        <tbody>
          <tr data-key="total">
            <th scope="row">{t('vol.card.total')}</th>
            <td className="mono">{v(f.cutM3)}</td>
            <td className="mono">{v(f.fillM3)}</td>
            <td className="mono" data-testid="survey-bulk-net">
              {v(f.netM3)}
            </td>
          </tr>
          <tr data-key="area">
            <th scope="row">{t('bulk.area')}</th>
            <td className="mono" colSpan={3} data-testid="survey-bulk-area">
              {a(f.areaM2)}
            </td>
          </tr>
        </tbody>
      </table>
      <RowNotes row={row} piles={piles} names={names} />
      {!readOnly && (
        <div className="sv-row sv-wrap">
          <Button
            busy={busy}
            data-testid="survey-bulk-recompute"
            onClick={() => {
              setBusy(true);
              void computeAll(piles.map((m) => m.id)).finally(() => {
                setBusy(false);
              });
            }}
          >
            {busy ? t('bulk.computing') : t('bulk.recomputeAll')}
          </Button>
        </div>
      )}
    </section>
  );
}

function SelectionTotals() {
  const t = useT();
  const selected = useMeasure((s) => s.selected);
  const file = useMeasure((s) => s.file);
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const templates = useMeasure((s) => s.templates);
  const current = useCompare((s) => s.current);
  const surfaces = useCompare((s) => s.surfaces);
  const designs = useCompare((s) => s.designs);
  const captures = useCompare((s) => s.captures);
  const [index, setIndex] = useState(0);
  const [side, setSide] = useState<BulkSide>('to');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const ms = useMemo(
    () => file.measurements.filter((m) => selected.includes(m.id) && m.family === 'polygon'),
    [file, selected],
  );
  const options = useMemo(
    () => sideOptions({ surfaces, captures, designs }),
    [surfaces, captures, designs],
  );
  // a selection of volumes is totalled by the volumes view's rule (the same function): the pile
  // figure of the latest survey date, current figures only, the rest named
  const volumes = ms.length > 0 && ms.every((m) => m.tool === 'volume');
  const stack = useInventory(volumes ? ms : NO_PILES);
  const names = useMemo(() => new Map(ms.map((m) => [m.id, m.label])), [ms]);
  if (selected.length < 2 || ms.length === 0) return null;
  const totals = bulkTotals(
    ms,
    (m) => polygonAreas(m.points).horizontalM2,
    (m, item) => {
      const r = m.results.find((x) => x.item === item);
      return r ? !isStale({ current }, m, r) : false;
    },
  );
  const pileRow = volumes ? stack.at(-1) : undefined;
  const pile = volumes ? rowFigures(pileRow, ms) : null;
  // a volume total is in the site's units, as in the volumes view
  const units = volumes ? settings.units : effectiveUnits(settings.units, ms[0]?.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const fmt = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);
  const a = (x: number) =>
    pile?.none ? NONE : formatQuantity(x, 'area', units, settings.precision, locale);
  /** The first comparison of volumes: the pile figure, "-" when no pile is counted. */
  const v = (x: number, index: number) => (index === 0 && pile?.none ? NONE : fmt(x));
  const rows = totals.rows.map((r) =>
    r.index === 0 && pile
      ? { ...r, cutM3: pile.cutM3, fillM3: pile.fillM3, netM3: pile.netM3, missing: 0 }
      : r,
  );
  const areaM2 = pile ? pile.areaM2 : totals.areaM2;
  const tplName = totals.template
    ? (knownTemplates({ templates, settings }).find((x) => x.id === totals.template)?.name ??
      totals.template)
    : null;
  const apply = () => {
    const o = options.find((x) => x.key === key);
    if (!o) return;
    const make = (m: (typeof ms)[number]): SurfaceRef => {
      const it = m.items[index];
      return sideFor(o, m.points, it ? it[side] : undefined);
    };
    const next = setSideForAll(ms, index, side, make);
    next.forEach((n, k) => {
      if (n !== ms[k]) replaceMeasurement(n);
    });
  };
  const setUnits = (patch: { volume?: string; area?: string }) => {
    const parsed = {
      ...(patch.volume ? { volume: VolumeUnit.parse(patch.volume) } : {}),
      ...(patch.area ? { area: AreaUnit.parse(patch.area) } : {}),
    };
    for (const n of setUnitsForAll(ms, { ...(ms[0]?.units ?? {}), ...parsed }))
      replaceMeasurement(n);
  };
  return (
    <section className="sv-card sv-panel" aria-label={t('bulk.label')} data-testid="survey-bulk">
      <header className="sv-head" role="none">
        <h2>
          {tplName
            ? t('bulk.titleTemplate', { count: ms.length, template: tplName })
            : t('bulk.title', { count: ms.length })}
        </h2>
      </header>
      {totals.mixed && (
        <p className="notice warn small" role="note">
          {t('bulk.mixed')}
        </p>
      )}
      <table className="sv-readout" data-testid="survey-bulk-totals">
        <caption className="sr-only">{t('bulk.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('bulk.col.comparison')}</th>
            <th scope="col">{t('bulk.col.cut')}</th>
            <th scope="col">{t('bulk.col.fill')}</th>
            <th scope="col">{t('bulk.col.net')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index} data-key={`row-${String(r.index)}`}>
              <th scope="row">
                {r.label}
                {r.index === 0 && pileRow && (
                  <small className="faint"> {t('vol.view.totalOn', { date: pileRow.label })}</small>
                )}
                {r.missing > 0 && (
                  <small className="faint"> {t('bulk.leftOut', { count: r.missing })}</small>
                )}
              </th>
              <td className="mono">{v(r.cutM3, r.index)}</td>
              <td className="mono">{v(r.fillM3, r.index)}</td>
              <td className="mono" data-testid="survey-bulk-net">
                {v(r.netM3, r.index)}
              </td>
            </tr>
          ))}
          <tr data-key="area">
            <th scope="row">{t('bulk.area')}</th>
            <td className="mono" colSpan={3} data-testid="survey-bulk-area">
              {a(areaM2)}
            </td>
          </tr>
        </tbody>
      </table>
      {volumes && <RowNotes row={pileRow} piles={ms} names={names} />}
      <div className="sv-row sv-wrap">
        <Button
          busy={busy}
          data-testid="survey-bulk-recompute"
          onClick={() => {
            setBusy(true);
            void computeAll(ms.map((m) => m.id)).finally(() => {
              setBusy(false);
            });
          }}
        >
          {busy ? t('bulk.computing') : t('bulk.recomputeAll')}
        </Button>
      </div>
      {!readOnly && totals.rows.length > 0 && (
        <fieldset className="sv-sub">
          <legend>{t('bulk.changeForAll')}</legend>
          <div className="sv-row sv-wrap">
            <select
              className="sv-input"
              aria-label={t('bulk.whichComparison')}
              value={index}
              onChange={(e) => {
                setIndex(Number(e.target.value));
              }}
            >
              {totals.rows.map((r) => (
                <option key={r.index} value={r.index}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              className="sv-input"
              aria-label={t('bulk.whichSide')}
              value={side}
              onChange={(e) => {
                setSide(e.target.value === 'from' ? 'from' : 'to');
              }}
            >
              <option value="from">{t('vol.from')}</option>
              <option value="to">{t('vol.to')}</option>
            </select>
            <select
              className="sv-input sv-grow"
              aria-label={t('bulk.newSurface')}
              value={key}
              data-testid="survey-bulk-side"
              onChange={(e) => {
                setKey(e.target.value);
              }}
            >
              <option value="">{t('bulk.chooseSurface')}</option>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.group === 'Bases' ? t('bulk.baseOption', { label: o.label }) : o.label}
                </option>
              ))}
            </select>
            <Button disabled={!key} data-testid="survey-bulk-apply" onClick={apply}>
              {t('bulk.applyAll')}
            </Button>
          </div>
          {key && isBase(options.find((o) => o.key === key)?.ref ?? { kind: 'current' }) && (
            <p className="small faint">{t('bulk.baseNote')}</p>
          )}
          <div className="sv-row sv-wrap">
            <label className="sv-field">
              <span>{t('bulk.volumeUnit')}</span>
              <select
                className="sv-input"
                value=""
                data-testid="survey-bulk-volume-unit"
                onChange={(e) => {
                  if (e.target.value) setUnits({ volume: e.target.value });
                }}
              >
                <option value="">{t('bulk.choose')}</option>
                {VolumeUnit.options.map((u) => (
                  <option key={u} value={u}>
                    {unitName(u)}
                  </option>
                ))}
              </select>
            </label>
            <label className="sv-field">
              <span>{t('bulk.areaUnit')}</span>
              <select
                className="sv-input"
                value=""
                onChange={(e) => {
                  if (e.target.value) setUnits({ area: e.target.value });
                }}
              >
                <option value="">{t('bulk.choose')}</option>
                {AreaUnit.options.map((u) => (
                  <option key={u} value={u}>
                    {unitName(u)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
      )}
    </section>
  );
}
