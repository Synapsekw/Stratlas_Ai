/**
 * Calculators of a volume measurement (M11 G4, PRD SRV-6): the measurement's material (a site
 * material, `SurveyMeasurement.material`), and from the stored volume, at display time only:
 * loose and compacted volumes (swell), tonnes (density), and the density a typed tonnage achieved
 * (the landfill compaction figure: 63,000 t over 70,104 m3 is 0.899 t/m3). Nothing here changes
 * the stored volume.
 */
import { formatQuantity, toSI, unitLabel } from '@aio/geo';
import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { DENSITY_DECIMALS, effectiveUnits, materialReadout } from '@aio/survey';
import { useState } from 'react';
import { openCompareDialog, setTonnes, useCompare } from './compareStore';
import { updateMeasurement, useMeasure } from './measureStore';

type Basis = 'net' | 'fill' | 'cut';

const volumeOf = (r: ComparisonResult, basis: Basis) =>
  basis === 'fill' ? r.fillM3 : basis === 'cut' ? r.cutM3 : Math.abs(r.netM3);

export function Calculators({ m }: { m: SurveyMeasurement }) {
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const typed = useCompare((s) => s.tonnes[m.id] ?? null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis>('net');
  const [text, setText] = useState(typed === null ? '' : String(typed));
  if (m.family !== 'polygon') return null;
  const units = effectiveUnits(settings.units, m.units);
  const material = settings.materials.find((x) => x.id === m.material) ?? null;
  const item = m.items.find((x) => x.id === itemId) ?? m.items[0];
  const r = item ? m.results.find((x) => x.item === item.id) : undefined;
  const usable = r && r.status !== 'refused' ? r : null;
  const bank = usable ? volumeOf(usable, basis) : null;
  const tonnesTyped = typed;
  const out = bank !== null ? materialReadout(bank, material, tonnesTyped) : null;
  const vol = (x: number) => formatQuantity(x, 'volume', units, settings.precision);
  // mass is SI kilograms in @aio/geo
  const mass = (t: number) => formatQuantity(t * 1000, 'mass', units, settings.precision);
  const density = (d: number) => formatQuantity(d, 'density', units, DENSITY_DECIMALS);
  return (
    <details className="sv-sec" open data-testid="survey-calculators">
      <summary>Material and calculators</summary>
      <div className="sv-row sv-wrap">
        <label className="sv-field sv-grow">
          <span>Material</span>
          <select
            className="sv-input"
            value={m.material ?? ''}
            disabled={readOnly}
            data-testid="survey-material"
            onChange={(e) => {
              const id = e.target.value;
              updateMeasurement(m.id, (x) => {
                const next = { ...x };
                if (id) next.material = id;
                else delete next.material;
                return next;
              });
            }}
          >
            <option value="">No material</option>
            {settings.materials.map((x) => (
              <option key={x.id} value={x.id}>
                {x.code ? `${x.name} (${x.code})` : x.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn sm"
          data-testid="survey-materials-open"
          onClick={() => {
            openCompareDialog('materials');
          }}
        >
          Site materials
        </button>
      </div>
      {m.items.length > 1 && (
        <label className="sv-field">
          <span>Volume of</span>
          <select
            className="sv-input"
            value={item?.id ?? ''}
            onChange={(e) => {
              setItemId(e.target.value);
            }}
          >
            {m.items.map((it, k) => (
              <option key={it.id} value={it.id}>
                {it.label ?? `Comparison ${String(k + 1)}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="sv-row" role="group" aria-label="Volume used">
        {(['net', 'fill', 'cut'] as const).map((b) => (
          <button
            key={b}
            type="button"
            className="btn sm"
            aria-pressed={basis === b}
            onClick={() => {
              setBasis(b);
            }}
          >
            {b === 'net' ? 'Net' : b === 'fill' ? 'Fill' : 'Cut'}
          </button>
        ))}
      </div>
      {out === null ? (
        <p className="small faint">The calculators work once a comparison is computed.</p>
      ) : (
        <table className="sv-readout" data-testid="survey-calc">
          <caption className="sr-only">Calculators</caption>
          <tbody>
            <tr data-key="bank">
              <th scope="row">Volume (bank)</th>
              <td className="mono">{vol(out.bankM3)}</td>
            </tr>
            <tr data-key="loose">
              <th scope="row">Loose</th>
              <td className="mono">
                {out.looseM3 === null ? 'No swell factors' : vol(out.looseM3)}
              </td>
            </tr>
            <tr data-key="compacted">
              <th scope="row">Compacted</th>
              <td className="mono">
                {out.compactedM3 === null ? 'No swell factors' : vol(out.compactedM3)}
              </td>
            </tr>
            <tr data-key="tonnes">
              <th scope="row">Weight</th>
              <td className="mono" data-testid="survey-calc-tonnes">
                {out.tonnes === null
                  ? 'No density'
                  : `${mass(out.tonnes)} at ${density(material?.densityTPerM3 ?? 0)}`}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <label className="sv-field">
        <span>Weighed tonnage ({unitLabel(units.mass)})</span>
        <input
          className="sv-input mono"
          type="number"
          min={0}
          step="1"
          value={text}
          aria-label={`Weighed tonnage (${unitLabel(units.mass)})`}
          data-testid="survey-weight"
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            setTonnes(
              m.id,
              e.target.value !== '' && Number.isFinite(v)
                ? toSI(v, 'mass', units.mass) / 1000
                : null,
            );
          }}
        />
      </label>
      {out?.achievedTPerM3 !== null && out?.achievedTPerM3 !== undefined && (
        <p className="small" data-testid="survey-achieved-density">
          Achieved density <b className="mono">{density(out.achievedTPerM3)}</b>
        </p>
      )}
      <p className="small faint">Calculated for display only; the stored volume does not change.</p>
    </details>
  );
}
