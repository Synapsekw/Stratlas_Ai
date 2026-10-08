/**
 * Crops (M11 G8, PRD SRV-11): cut a surface to a boundary, copied from a measurement or from
 * another survey's extent. Crops join the surface's terrain edits (`survey/cleanups.json`) and run
 * with its cleanups into the cleaned surface; the delivered surface never changes.
 */
import type { SurveyMeasurement } from '@aio/schema';
import { useState } from 'react';
import { editFrom, extentRing, ringOf } from './qaHelpers';
import { addEdit, useQa } from './qaStore';

export function CropSection({
  surface,
  polygons,
}: {
  surface: string;
  polygons: readonly SurveyMeasurement[];
}) {
  const surfaces = useQa((s) => s.surfaces);
  const others = surfaces.filter((s) => s.id !== surface && s.capture);
  const [from, setFrom] = useState('');
  return (
    <div className="qa-crop" data-testid="crop-section">
      <span className="pop-title">Crop</span>
      <ul className="qa-edits" aria-label="Crop to a measurement">
        {polygons.map((m) => (
          <li key={m.id} className="sv-row">
            <span className="qa-grow small">{m.label}</span>
            <button
              type="button"
              className="btn sm"
              data-testid={`crop-copy-${m.id}`}
              onClick={() => {
                void addEdit(editFrom('crop', surface, ringOf(m), m.label));
              }}
            >
              Copy as crop
            </button>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div className="sv-row">
          <select
            className="sv-input qa-grow"
            value={from}
            aria-label="Crop to the extent of another survey"
            onChange={(e) => {
              setFrom(e.target.value);
            }}
          >
            <option value="">Crop to another survey's extent</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn sm"
            disabled={!from}
            onClick={() => {
              const s = others.find((x) => x.id === from);
              if (s) void addEdit(editFrom('crop', surface, extentRing(s), `Extent of ${s.name}`));
            }}
          >
            Add crop
          </button>
        </div>
      )}
    </div>
  );
}
