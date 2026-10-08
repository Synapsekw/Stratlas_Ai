/**
 * Alignments of the site's designs (M11 G6, DSN-4): **Activate alignment** makes the cursor
 * readout show station and offset (`stationReadout`), **Edit station intervals** sets the label
 * interval of an alignment layer (kept in `designs.json`, never in the imported files).
 */
import type { DesignEntry, DesignLayer } from '@aio/schema';
import { useState } from 'react';
import { activateAlignment, patchLayer, useDesigns } from './designsStore';

export function AlignmentControls({
  design,
  layer,
  readOnly,
}: {
  design: DesignEntry;
  layer: DesignLayer;
  readOnly: boolean;
}) {
  const ref = `${design.id}/${layer.id}`;
  const active = useDesigns((s) => s.file?.activeAlignment === ref);
  const interval = (layer as { intervalM?: unknown }).intervalM;
  const [draft, setDraft] = useState(typeof interval === 'number' ? String(interval) : '20');
  const [error, setError] = useState<string | null>(null);
  const value = Number(draft);
  const valid = Number.isFinite(value) && value > 0 && value <= 10_000;
  return (
    <div className="pop-form" data-testid={`alignment-${layer.id}`}>
      <div className="pop-row">
        <button
          type="button"
          aria-pressed={active}
          disabled={readOnly || layer.archived}
          onClick={() => {
            void activateAlignment(active ? null : ref).then(setError);
          }}
        >
          {active ? 'Deactivate alignment' : 'Activate alignment'}
        </button>
      </div>
      <label className="pop-row">
        <span>Station interval (m)</span>
        <input
          type="number"
          min={0.01}
          step="any"
          value={draft}
          disabled={readOnly}
          aria-label="Station interval in metres"
          onChange={(e) => {
            setDraft(e.target.value);
          }}
        />
        <button
          type="button"
          disabled={readOnly || !valid}
          onClick={() => {
            void patchLayer(design.id, layer.id, { intervalM: value }).then(setError);
          }}
        >
          Set interval
        </button>
      </label>
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The active alignment's name for the panel header, or nothing. */
export function ActiveAlignmentNote() {
  const active = useDesigns((s) => s.active);
  if (!active) return null;
  return (
    <p className="pop-note" data-testid="active-alignment">
      Station and offset from {active.name} show in the cursor readout.
    </p>
  );
}
