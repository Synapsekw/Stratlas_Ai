import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import {
  BUDGETS,
  COLOUR_MODES,
  SIZE_RANGE,
  pointcloudSettings,
  type PointcloudSettings,
} from './settings';
import { usePointcloudCounts } from './stats';

export interface PointCloudControlsProps {
  className?: string;
  /** Defaults to the app-wide settings store. */
  store?: StoreApi<PointcloudSettings>;
  /** Whether the clouds carry RGB colour; defaults to what the loaded clouds report. */
  rgb?: boolean;
}

export const NO_RGB_HINT = 'This point cloud has no colour (RGB), only intensity';

const millions = (n: number) => `${(n / 1e6).toFixed(n >= 1e7 || n % 1e6 === 0 ? 0 : 1)} M`;

const s = {
  root: {
    display: 'grid',
    gap: 'var(--s3, 12px)',
    font: 'var(--t-12, 12px) var(--f-ui, system-ui)',
    color: 'var(--fg-1, #d6dbe3)',
  },
  row: { display: 'grid', gap: 'var(--s1, 4px)' },
  label: { color: 'var(--fg-3, #8a94a6)' },
  seg: { display: 'flex', gap: 2, flexWrap: 'wrap' as const },
  btn: (on: boolean, disabled = false) => ({
    padding: '4px 8px',
    opacity: disabled ? 0.45 : 1,
    border: '1px solid var(--line, #2a3240)',
    borderRadius: 'var(--r-4, 4px)',
    background: on ? 'var(--acc-a20, rgba(90,176,255,.2))' : 'transparent',
    color: on ? 'var(--fg-0, #fff)' : 'var(--fg-2, #aab3c2)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    font: 'inherit',
  }),
  inline: { display: 'flex', alignItems: 'center', gap: 'var(--s2, 8px)' },
  readout: { color: 'var(--fg-3, #8a94a6)', fontFamily: 'var(--f-mono, monospace)' },
};

/** Point-cloud display controls for the UI stream to place (colour, size, budget, EDL). */
export function PointCloudControls({
  className,
  store = pointcloudSettings,
  rgb,
}: PointCloudControlsProps) {
  const colourMode = useStore(store, (x) => x.colourMode);
  const sizeScale = useStore(store, (x) => x.sizeScale);
  const budget = useStore(store, (x) => x.budget);
  const edl = useStore(store, (x) => x.edl);
  const counts = usePointcloudCounts();
  const st = store.getState();
  const hasRgb = rgb ?? (counts.layers === 0 || counts.rgb);
  // intensity-only clouds draw the RGB choice as their intensity view
  const shown = colourMode === 'rgb' && !hasRgb ? 'intensity' : colourMode;

  return (
    <div className={className} style={s.root} data-component="pointcloud-controls">
      <div style={s.row} role="group" aria-label="Colour by">
        <span style={s.label}>Colour by</span>
        <div style={s.seg}>
          {COLOUR_MODES.map((m) => {
            const off = m.id === 'rgb' && !hasRgb;
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={shown === m.id}
                disabled={off}
                title={off ? NO_RGB_HINT : m.hint}
                style={s.btn(shown === m.id, off)}
                onClick={() => {
                  st.setColourMode(m.id);
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
      <label style={s.row}>
        <span style={s.label}>Point size</span>
        <span style={s.inline}>
          <input
            type="range"
            min={Math.log2(SIZE_RANGE[0])}
            max={Math.log2(SIZE_RANGE[1])}
            step={0.25}
            value={Math.log2(sizeScale)}
            onChange={(e) => {
              st.setSizeScale(2 ** Number(e.currentTarget.value));
            }}
          />
          <span style={s.readout}>{sizeScale.toFixed(2)}x</span>
        </span>
      </label>
      <label style={s.row}>
        <span style={s.label}>Point budget</span>
        <select
          value={budget}
          onChange={(e) => {
            st.setBudget(Number(e.currentTarget.value));
          }}
        >
          {BUDGETS.map((b) => (
            <option key={b} value={b}>
              {millions(b)}
            </option>
          ))}
        </select>
      </label>
      <label style={s.inline}>
        <input
          type="checkbox"
          checked={edl}
          onChange={(e) => {
            st.setEdl(e.currentTarget.checked);
          }}
        />
        <span>Eye-dome lighting</span>
      </label>
      {counts.layers > 0 && (
        <span style={s.readout} aria-live="polite">
          {millions(counts.loaded)} of {millions(counts.total)} points shown
          {counts.loading > 0 ? `, loading ${counts.loading}` : ''}
        </span>
      )}
    </div>
  );
}
