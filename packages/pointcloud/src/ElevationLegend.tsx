import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { elevationColour, elevationGradient } from './ramp';
import { pointcloudSettings, type PointcloudSettings } from './settings';
import { usePointcloudCounts } from './stats';

export { elevationColour, elevationGradient };

export interface ElevationLegendProps {
  /** Height range of the coloured points in the local frame (Y up); nothing renders without it. */
  range: readonly [number, number] | null;
  /** Local Y to the elevation shown (metres in the project's vertical datum). */
  toElevation?: (y: number) => number;
  className?: string;
}

const s = {
  root: {
    display: 'grid',
    gridTemplateColumns: 'auto auto',
    columnGap: 'var(--s2, 8px)',
    alignItems: 'stretch',
    padding: '8px 10px',
    font: 'var(--t-11, 11px) var(--f-ui, system-ui)',
    color: 'var(--fg-2, #aab3c2)',
  },
  title: { gridColumn: '1 / -1', marginBottom: 6, color: 'var(--fg-1, #d6dbe3)' },
  bar: {
    width: 10,
    height: 96,
    borderRadius: 2,
    border: '1px solid var(--line, #2a3240)',
    background: elevationGradient(),
  },
  ticks: {
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
    fontFamily: 'var(--f-mono, monospace)',
    color: 'var(--fg-1, #d6dbe3)',
  },
};

const metres = (v: number) => `${v.toFixed(1)} m`;

/** The elevation colour ramp with the top and bottom of the coloured range, in metres. */
export function ElevationLegend({
  range,
  toElevation = (y) => y,
  className,
}: ElevationLegendProps) {
  if (!range) return null;
  const lo = toElevation(range[0]);
  const hi = toElevation(range[1]);
  return (
    <div
      className={className}
      style={s.root}
      role="img"
      aria-label={`Elevation colour ramp from ${metres(lo)} to ${metres(hi)}`}
      data-component="elevation-legend"
    >
      <span style={s.title}>Elevation</span>
      <span style={s.bar} aria-hidden />
      <span style={s.ticks}>
        <span>{metres(hi)}</span>
        <span>{metres((lo + hi) / 2)}</span>
        <span>{metres(lo)}</span>
      </span>
    </div>
  );
}

/** The range the legend shows: the clouds' height range while they are coloured by elevation. */
export function useElevationRange(
  store: StoreApi<PointcloudSettings> = pointcloudSettings,
): readonly [number, number] | null {
  const mode = useStore(store, (x) => x.colourMode);
  const counts = usePointcloudCounts();
  return mode === 'height' && counts.loaded > 0 ? counts.heightRange : null;
}
