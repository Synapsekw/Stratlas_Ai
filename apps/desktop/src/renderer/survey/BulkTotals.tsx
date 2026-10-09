/**
 * Bulk selection (M11 G4, PRD SRV-1): running totals of the selected measurements' comparisons
 * (best with one template, so the items line up), and one change for all of them: a side of an
 * item, or the units. Totals add current results only; stale or refused ones are counted apart.
 */
import { formatQuantity } from '@aio/geo';
import { VolumeUnit, AreaUnit, type SurfaceRef } from '@aio/schema';
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
} from '@aio/survey';
import { unitName } from '@aio/geo';
import { useMemo, useState } from 'react';
import { computeAll, isStale, useCompare } from './compareStore';
import { knownTemplates, replaceMeasurement, useMeasure } from './measureStore';

export function BulkTotals() {
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
  if (selected.length < 2 || ms.length === 0) return null;
  const t = bulkTotals(
    ms,
    (m) => polygonAreas(m.points).horizontalM2,
    (m, item) => {
      const r = m.results.find((x) => x.item === item);
      return r ? !isStale({ current }, m, r) : false;
    },
  );
  const units = effectiveUnits(settings.units, ms[0]?.units);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision);
  const a = (x: number) => formatQuantity(x, 'area', units, settings.precision);
  const tplName = t.template
    ? (knownTemplates({ templates, settings }).find((x) => x.id === t.template)?.name ?? t.template)
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
    <section
      className="sv-card sv-panel"
      aria-label="Selected measurements"
      data-testid="survey-bulk"
    >
      <header className="sv-head" role="none">
        <h2>
          {ms.length} measurements{tplName ? `: ${tplName}` : ''}
        </h2>
      </header>
      {t.mixed && (
        <p className="notice warn small" role="note">
          The selection mixes templates: items are added by their position.
        </p>
      )}
      <table className="sv-readout" data-testid="survey-bulk-totals">
        <caption className="sr-only">Running totals</caption>
        <thead>
          <tr>
            <th scope="col">Comparison</th>
            <th scope="col">Cut</th>
            <th scope="col">Fill</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.index} data-key={`row-${String(r.index)}`}>
              <th scope="row">
                {r.label}
                {r.missing > 0 && (
                  <small className="faint"> ({r.missing} not current, left out)</small>
                )}
              </th>
              <td className="mono">{v(r.cutM3)}</td>
              <td className="mono">{v(r.fillM3)}</td>
              <td className="mono" data-testid="survey-bulk-net">
                {v(r.netM3)}
              </td>
            </tr>
          ))}
          <tr data-key="area">
            <th scope="row">Horizontal area</th>
            <td className="mono" colSpan={3}>
              {a(t.areaM2)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="sv-row sv-wrap">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          data-testid="survey-bulk-recompute"
          onClick={() => {
            setBusy(true);
            void computeAll(ms.map((m) => m.id)).finally(() => {
              setBusy(false);
            });
          }}
        >
          {busy ? 'Computing…' : 'Recompute all'}
        </button>
      </div>
      {!readOnly && t.rows.length > 0 && (
        <fieldset className="sv-sub">
          <legend>Change for all</legend>
          <div className="sv-row sv-wrap">
            <select
              className="sv-input"
              aria-label="Comparison to change"
              value={index}
              onChange={(e) => {
                setIndex(Number(e.target.value));
              }}
            >
              {t.rows.map((r) => (
                <option key={r.index} value={r.index}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              className="sv-input"
              aria-label="Side to change"
              value={side}
              onChange={(e) => {
                setSide(e.target.value === 'from' ? 'from' : 'to');
              }}
            >
              <option value="from">From</option>
              <option value="to">To</option>
            </select>
            <select
              className="sv-input sv-grow"
              aria-label="New surface"
              value={key}
              data-testid="survey-bulk-side"
              onChange={(e) => {
                setKey(e.target.value);
              }}
            >
              <option value="">Choose a surface or base</option>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.group === 'Bases' ? `Base: ${o.label}` : o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sm"
              disabled={!key}
              data-testid="survey-bulk-apply"
              onClick={apply}
            >
              Apply to all
            </button>
          </div>
          {key && isBase(options.find((o) => o.key === key)?.ref ?? { kind: 'current' }) && (
            <p className="small faint">
              A base is set only where the other side is a surface; each polygon keeps its own
              vertices and levels.
            </p>
          )}
          <div className="sv-row sv-wrap">
            <label className="sv-field">
              <span>Volume unit for all</span>
              <select
                className="sv-input"
                value=""
                data-testid="survey-bulk-volume-unit"
                onChange={(e) => {
                  if (e.target.value) setUnits({ volume: e.target.value });
                }}
              >
                <option value="">Choose</option>
                {VolumeUnit.options.map((u) => (
                  <option key={u} value={u}>
                    {unitName(u)}
                  </option>
                ))}
              </select>
            </label>
            <label className="sv-field">
              <span>Area unit for all</span>
              <select
                className="sv-input"
                value=""
                onChange={(e) => {
                  if (e.target.value) setUnits({ area: e.target.value });
                }}
              >
                <option value="">Choose</option>
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
