/**
 * Compliance to design (M11 G6, DSN-3): the tolerance (plus and minus), its heat map stops and the
 * two comparison presets for a design surface, **Cut/Fill to design** and **Remaining to design**.
 * The comparison itself is G4's: a preset is handed to whoever registered in `DESIGN_PRESET_SINKS`
 * (the comparison UI), and the in-tolerance share comes with its result (`toleranceShare`).
 */
import type { ComparisonItem, DesignEntry } from '@aio/schema';
import {
  DESIGN_PRESET_LABELS,
  designComparisonItem,
  toleranceHeatmap,
  type DesignPreset,
} from '@aio/survey';
import { useState } from 'react';

/** Receivers of a design preset (G4's comparison UI registers one). */
export const DESIGN_PRESET_SINKS: ((item: ComparisonItem, toleranceM: number) => void)[] = [];

const PRESETS: DesignPreset[] = ['cut-fill-to-design', 'remaining-to-design'];

export function ComplianceSection({ designs }: { designs: readonly DesignEntry[] }) {
  const surfaces = designs.flatMap((d) =>
    d.layers
      .filter((l) => l.kind === 'surface' && !l.archived)
      .map((l) => ({
        ref: `${d.id}/${l.id}`,
        label: `${d.name}: ${l.name}`,
        design: d.id,
        layer: l.id,
      })),
  );
  const [ref, setRef] = useState(surfaces[0]?.ref ?? '');
  const [mm, setMm] = useState('50');
  const [note, setNote] = useState<string | null>(null);
  const tol = Number(mm) / 1000;
  const valid = Number.isFinite(tol) && tol > 0 && tol <= 10;
  const pick = surfaces.find((s) => s.ref === ref) ?? surfaces[0];
  if (!pick) return null;
  const stops = valid ? toleranceHeatmap(tol).stops : [];
  return (
    <section className="pop-form" aria-label="Compliance to design" data-testid="compliance">
      <h4>Compliance to design</h4>
      <label className="pop-row">
        <span>Design surface</span>
        <select
          value={pick.ref}
          onChange={(e) => {
            setRef(e.target.value);
          }}
        >
          {surfaces.map((s) => (
            <option key={s.ref} value={s.ref}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="pop-row">
        <span>Tolerance, plus or minus (mm)</span>
        <input
          type="number"
          min={1}
          step="any"
          value={mm}
          onChange={(e) => {
            setMm(e.target.value);
          }}
        />
      </label>
      {valid && (
        <div className="pop-row" aria-label="Heat map" data-testid="tolerance-heatmap">
          {stops.map((s, i) => (
            <span key={s.value} title={String(s.value)}>
              <span
                aria-hidden
                style={{ display: 'inline-block', width: 10, height: 10, background: s.color }}
              />{' '}
              {i === 0 ? 'Cut' : i === 1 ? `Within ${mm} mm` : 'Fill'}
            </span>
          ))}
        </div>
      )}
      <div className="pop-row">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={!valid}
            onClick={() => {
              const item = designComparisonItem(p, {
                id: `${p}-${pick.layer}`.slice(0, 80),
                design: pick.design,
                layer: pick.layer,
                toleranceM: tol,
              });
              for (const sink of DESIGN_PRESET_SINKS) sink(item, tol);
              setNote(
                DESIGN_PRESET_SINKS.length
                  ? `${DESIGN_PRESET_LABELS[p]} added to the comparison.`
                  : 'Open Volumes and comparisons to compute it.',
              );
            }}
          >
            {DESIGN_PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {note && <p className="pop-note">{note}</p>}
    </section>
  );
}
