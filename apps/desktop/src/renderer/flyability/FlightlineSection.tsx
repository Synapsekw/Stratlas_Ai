import { Switch, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
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
export function FlightlineSection() {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const display = useFlightlineDisplay(projectId);
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
          value={display.widthPx}
          aria-label={t('fly.display.width')}
          data-testid="flightline-width"
          onChange={(e) => {
            set({ widthPx: Number(e.target.value) });
          }}
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
    </div>
  );
}
