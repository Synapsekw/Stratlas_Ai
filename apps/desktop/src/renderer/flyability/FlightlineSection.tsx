import { Switch, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import {
  flightlineDisplay,
  MAX_WIDTH_PX,
  MIN_WIDTH_PX,
  useFlightlineDisplay,
  type FlightlineDisplay,
} from './flightlineDisplay';
import './flyability.css';

/**
 * Layers > Flight lines: how the active space's flight lines are drawn (width, one colour per
 * flight or a single colour, the selected flight only). View state kept on this computer; the
 * 3D view redraws from it (`SpacesMount`).
 */
/** The width slider writes the store this long after the last move (and on release). */
export const WIDTH_DEBOUNCE_MS = 100;

export function FlightlineSection() {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const display = useFlightlineDisplay(projectId);
  // a flight line layer is the selection: "selected flight only" has something to show
  const flightSelected = useWorkspace((s) => {
    const sel = s.selection;
    if (sel?.kind !== 'layer') return false;
    return (s.project?.manifest.layers ?? []).some(
      (l) => l.kind === 'flightline' && l.id === sel.id,
    );
  });
  // the slider shows its value at once; the store (and the redraw) follow after a pause
  const [drag, setDrag] = useState<number | null>(null);
  const width = drag ?? display.widthPx;
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<number | null>(null);
  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const w = pending.current;
    pending.current = null;
    if (w !== null && projectId !== null)
      flightlineDisplay().getState().patch(projectId, { widthPx: w });
  };
  const release = () => {
    flush();
    setDrag(null);
  };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (change: Partial<FlightlineDisplay>) => {
    if (projectId !== null) flightlineDisplay().getState().patch(projectId, change);
  };
  return (
    <div className="fly-display" data-testid="flightline-section">
      <label className="fly-display-row">
        <span className="faint">{t('fly.display.width')}</span>
        <input
          type="range"
          min={MIN_WIDTH_PX}
          max={MAX_WIDTH_PX}
          step={1}
          value={width}
          aria-label={t('fly.display.width')}
          data-testid="flightline-width"
          onChange={(e) => {
            const w = Number(e.target.value);
            setDrag(w);
            pending.current = w;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(release, WIDTH_DEBOUNCE_MS);
          }}
          onPointerUp={release}
          onKeyUp={release}
        />
      </label>
      <div className="fly-display-row">
        <span className="faint">{t('fly.display.colour')}</span>
        <div className="seg" role="group" aria-label={t('fly.display.colour')}>
          <button
            type="button"
            aria-pressed={display.colourMode === 'flight'}
            data-testid="flightline-colour-flight"
            onClick={() => {
              set({ colourMode: 'flight' });
            }}
          >
            {t('fly.display.byFlight')}
          </button>
          <button
            type="button"
            aria-pressed={display.colourMode === 'one'}
            data-testid="flightline-colour-one"
            onClick={() => {
              set({ colourMode: 'one' });
            }}
          >
            {t('fly.display.oneColour')}
          </button>
        </div>
      </div>
      <div className="fly-display-row">
        <span className="faint">{t('fly.display.activeOnly')}</span>
        <Switch
          checked={display.activeOnly}
          label={t('fly.display.activeOnly')}
          onChange={(activeOnly) => {
            set({ activeOnly });
          }}
        />
      </div>
      {display.activeOnly && !flightSelected && (
        <p className="fly-display-hint faint" data-testid="flightline-hint">
          {t('fly.display.selectHint')}
        </p>
      )}
    </div>
  );
}
