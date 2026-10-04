import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { legendEntries } from './classes';
import { pointcloudSettings, type PointcloudSettings } from './settings';
import { usePointcloudCounts } from './stats';

export interface ClassificationLegendProps {
  /** Points per ASPRS class among the shown points; nothing renders without it. */
  counts: Readonly<Record<number, number>> | null | undefined;
  /** Hidden class codes. */
  hidden: readonly number[];
  /** Show or hide one class; without it the rows are static. */
  onToggle?: (code: number) => void;
  className?: string;
}

const s = {
  root: {
    display: 'grid',
    gap: 2,
    padding: '8px 10px',
    minWidth: 180,
    font: 'var(--t-11, 11px) var(--f-ui, system-ui)',
    color: 'var(--fg-2, #aab3c2)',
  },
  title: { marginBottom: 4, color: 'var(--fg-1, #d6dbe3)' },
  row: (shown: boolean) => ({
    display: 'grid',
    gridTemplateColumns: '10px 1fr auto',
    alignItems: 'center',
    gap: 8,
    padding: '2px 4px',
    border: 0,
    borderRadius: 'var(--r-4, 4px)',
    background: 'transparent',
    color: shown ? 'var(--fg-1, #d6dbe3)' : 'var(--fg-3, #8a94a6)',
    textDecoration: shown ? 'none' : 'line-through',
    font: 'inherit',
    textAlign: 'left' as const,
    cursor: 'pointer',
  }),
  swatch: (colour: string, shown: boolean) => ({
    width: 10,
    height: 10,
    borderRadius: 2,
    background: shown ? colour : 'transparent',
    border: `1px solid ${colour}`,
  }),
  share: { fontFamily: 'var(--f-mono, monospace)' },
};

const percent = (x: number) =>
  x >= 0.1 ? `${Math.round(x * 100)} %` : `${(x * 100).toFixed(1)} %`;

/** The ASPRS classes present in the shown points, with their share; click a row to hide it. */
export function ClassificationLegend({
  counts,
  hidden,
  onToggle,
  className,
}: ClassificationLegendProps) {
  if (!counts) return null;
  const entries = legendEntries(counts);
  if (!entries.length) return null;
  return (
    <div
      className={className}
      style={s.root}
      role="group"
      aria-label="Point classes"
      data-component="classification-legend"
    >
      <span style={s.title}>Classification</span>
      {entries.map((e) => {
        const shown = !hidden.includes(e.code);
        return (
          <button
            key={e.code}
            type="button"
            style={s.row(shown)}
            aria-pressed={shown}
            aria-label={`${shown ? 'Hide' : 'Show'} ${e.name}`}
            title={`Class ${e.code}: ${e.name}, ${e.points.toLocaleString('en')} points shown`}
            onClick={() => onToggle?.(e.code)}
          >
            <span style={s.swatch(e.colour, shown)} aria-hidden />
            <span>{e.name}</span>
            <span style={s.share}>{percent(e.share)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Legend data while the clouds are coloured by classification (null otherwise). */
export function useClassificationLegend(store: StoreApi<PointcloudSettings> = pointcloudSettings): {
  counts: Readonly<Record<number, number>> | null;
  hidden: readonly number[];
} {
  const mode = useStore(store, (x) => x.colourMode);
  const hidden = useStore(store, (x) => x.hiddenClasses);
  const counts = usePointcloudCounts();
  return {
    counts: mode === 'classification' && counts.loaded > 0 ? (counts.classes ?? null) : null,
    hidden,
  };
}
