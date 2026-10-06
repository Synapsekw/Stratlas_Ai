import { useWorkspace } from '@aio/workspace';
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
  /** Whether a cloud carries ASPRS classes; defaults to what the loaded clouds report. */
  classes?: boolean;
  /**
   * The clouds' automatic elevation range and full height extent, local Y; defaults to what the
   * loaded clouds report.
   */
  heights?: { range: readonly [number, number]; extent: readonly [number, number] } | null;
  /** Local Y to the elevation shown, metres; defaults to the open project's origin height + Y. */
  toElevation?: (y: number) => number;
}

export const NO_RGB_HINT = 'This point cloud has no colour (RGB), only intensity';
export const NO_CLASS_HINT = 'These point clouds have no classification (COPC and LAS clouds do)';

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
  classes,
  heights,
  toElevation,
}: PointCloudControlsProps) {
  const colourMode = useStore(store, (x) => x.colourMode);
  const sizeScale = useStore(store, (x) => x.sizeScale);
  const budget = useStore(store, (x) => x.budget);
  const cap = useStore(store, (x) => x.budgetCap);
  const edl = useStore(store, (x) => x.edl);
  const counts = usePointcloudCounts();
  const st = store.getState();
  const hasRgb = rgb ?? (counts.layers === 0 || counts.rgb);
  const hasClass = classes ?? (counts.classes !== null && counts.classes !== undefined);
  // intensity-only clouds draw the RGB choice as their intensity view
  const shown = colourMode === 'rgb' && !hasRgb ? 'intensity' : colourMode;
  const auto =
    heights !== undefined
      ? heights
      : counts.heightRange && counts.heightExtent
        ? { range: counts.heightRange, extent: counts.heightExtent }
        : null;

  return (
    <div className={className} style={s.root} data-component="pointcloud-controls">
      <div style={s.row} role="group" aria-label="Colour by">
        <span style={s.label}>Colour by</span>
        <div style={s.seg}>
          {COLOUR_MODES.map((m) => {
            const noRgb = m.id === 'rgb' && !hasRgb;
            const noClass = m.id === 'classification' && !hasClass && shown !== m.id;
            const off = noRgb || noClass;
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={shown === m.id}
                disabled={off}
                title={noRgb ? NO_RGB_HINT : noClass ? NO_CLASS_HINT : m.hint}
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
      {shown === 'height' && auto && (
        <ElevationRange store={store} auto={auto} toElevation={toElevation} />
      )}
      <label style={s.row}>
        <span style={s.label}>Point size</span>
        <span style={s.inline}>
          <input
            type="range"
            aria-label="Point size"
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
          value={Math.min(budget, cap)}
          onChange={(e) => {
            st.setBudget(Number(e.currentTarget.value));
          }}
        >
          {BUDGETS.map((b) => (
            // above the graphics preset's memory limit: Settings, Graphics raises it
            <option key={b} value={b} disabled={b > cap}>
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

const elevText = (v: number) => `${v.toFixed(1)} m`;

/** Bottom and top of the elevation ramp: automatic (1st to 99th percentile) or set by hand. */
function ElevationRange({
  store,
  auto,
  toElevation,
}: {
  store: StoreApi<PointcloudSettings>;
  auto: { range: readonly [number, number]; extent: readonly [number, number] };
  toElevation: ((y: number) => number) | undefined;
}) {
  const manual = useStore(store, (x) => x.heightRange);
  const originH = useWorkspace((w) => w.project?.manifest.origin[2] ?? 0);
  const elev = toElevation ?? ((y: number) => originH + y);
  const [lo, hi] = manual ?? auto.range;
  // the sliders span every sampled height (and a hand-set range beyond it), in 10 cm steps
  const min = Math.floor(Math.min(auto.extent[0], lo) * 10) / 10;
  const max = Math.ceil(Math.max(auto.extent[1], hi) * 10) / 10;
  const gap = 0.1;
  const st = store.getState();
  const slider = (which: 'bottom' | 'top', value: number) => (
    <span style={s.inline}>
      <input
        type="range"
        aria-label={`Elevation ramp ${which}`}
        min={min}
        max={max}
        step={0.1}
        value={value}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          st.setHeightRange(
            which === 'bottom' ? [Math.min(v, hi - gap), hi] : [lo, Math.max(v, lo + gap)],
          );
        }}
      />
      <span style={s.readout}>{elevText(elev(value))}</span>
    </span>
  );
  return (
    <div style={s.row} role="group" aria-label="Elevation range" data-testid="elevation-range">
      <span style={{ ...s.inline, justifyContent: 'space-between' }}>
        <span style={s.label}>Elevation range</span>
        <button
          type="button"
          aria-pressed={!manual}
          title="Fit the ramp to the clouds: 1st to 99th percentile of their heights"
          style={s.btn(!manual)}
          onClick={() => {
            st.setHeightRange(null);
          }}
        >
          Auto
        </button>
      </span>
      {slider('top', hi)}
      {slider('bottom', lo)}
    </div>
  );
}
