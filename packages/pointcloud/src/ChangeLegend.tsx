import { getActiveScene, type SceneHandle } from '@aio/engine';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { changeGradient } from './changeRamp';
import { pickPoint } from './pick';
import { pointcloudSettings, type PointcloudSettings } from './settings';
import { usePointcloudCounts, type ScalarSummary } from './stats';

export interface ChangeLegendViewProps {
  /** The change field of the shown change clouds. */
  scalar: ScalarSummary;
  /** The value that gets the full colour (the half range when diverging). */
  range: number;
  /** Points closer than this are hidden. */
  threshold: number;
  onThreshold: (metres: number) => void;
  /** The value under the pointer; null when the pointer is not on a change point. */
  hover: number | null;
  className?: string | undefined;
  children?: ReactNode;
}

const s = {
  root: {
    display: 'grid',
    gap: 6,
    padding: '8px 10px',
    minWidth: 190,
    font: 'var(--t-11, 11px) var(--f-ui, system-ui)',
    color: 'var(--fg-2, #aab3c2)',
  },
  title: { color: 'var(--fg-1, #d6dbe3)' },
  bar: (gradient: string) => ({
    height: 10,
    borderRadius: 2,
    border: '1px solid var(--line, #2a3240)',
    background: gradient,
  }),
  ticks: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--f-mono, monospace)',
    color: 'var(--fg-1, #d6dbe3)',
  },
  row: { display: 'grid', gap: 2 },
  inline: { display: 'flex', alignItems: 'center', gap: 6 },
  mono: { fontFamily: 'var(--f-mono, monospace)', color: 'var(--fg-1, #d6dbe3)' },
};

/** A distance in metres for the legend: two decimals, a plus sign on signed ramps. */
export function formatChange(v: number, unit = 'm', signed = false): string {
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} ${unit}`;
}

/** The change ramp, its ends in metres, the threshold slider and the value under the pointer. */
export function ChangeLegendView({
  scalar,
  range,
  threshold,
  onThreshold,
  hover,
  className,
  children,
}: ChangeLegendViewProps) {
  const { unit, diverging } = scalar;
  const ticks = diverging ? [-range, 0, range] : [0, range / 2, range];
  const lo = formatChange(ticks[0] ?? 0, unit, diverging);
  const hi = formatChange(ticks[2] ?? 0, unit, diverging);
  return (
    <div
      className={className}
      style={s.root}
      role="group"
      aria-label="Change legend"
      data-component="change-legend"
    >
      <span style={s.title}>Change: {scalar.label.toLowerCase()} to the earlier date</span>
      <span
        style={s.bar(changeGradient(diverging))}
        role="img"
        aria-label={`Change colour ramp from ${lo} to ${hi}`}
      />
      <span style={s.ticks}>
        {ticks.map((t, i) => (
          <span key={i}>{formatChange(t, unit, diverging)}</span>
        ))}
      </span>
      <label style={s.row}>
        <span>Hide changes under</span>
        <span style={s.inline}>
          <input
            type="range"
            aria-label="Hide changes smaller than"
            min={0}
            max={Math.max(range, 0.01)}
            step={0.01}
            value={Math.min(threshold, range)}
            onChange={(e) => {
              onThreshold(Number(e.currentTarget.value));
            }}
          />
          <span style={s.mono}>{formatChange(threshold, unit)}</span>
        </span>
      </label>
      <output aria-live="off" data-testid="change-hover">
        {hover === null ? (
          'Point at the cloud to read its distance'
        ) : (
          <>
            Under the pointer: <span style={s.mono}>{formatChange(hover, unit, diverging)}</span>
          </>
        )}
      </output>
      {children}
    </div>
  );
}

/**
 * The change value under the pointer in a 3D view, at most once per frame; null off the change
 * clouds. Listens only while `active`.
 */
export function useScalarHover(
  scene: () => SceneHandle | null = getActiveScene,
  active = true,
): number | null {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const handle = scene();
    const el = (handle?.renderer as { domElement?: HTMLElement } | undefined)?.domElement;
    if (!handle || !el || typeof el.addEventListener !== 'function') return;
    let raf: number | null = null;
    let at: { x: number; y: number } | null = null;
    const read = () => {
      raf = null;
      if (!at) return;
      const hit = pickPoint(handle, at);
      setValue(hit?.scalar ?? null);
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      at = {
        x: ((e.clientX - r.left) / Math.max(r.width, 1)) * 2 - 1,
        y: -(((e.clientY - r.top) / Math.max(r.height, 1)) * 2 - 1),
      };
      raf ??= requestAnimationFrame(read);
    };
    const leave = () => {
      at = null;
      setValue(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [scene, active]);
  return active ? value : null;
}

export interface ChangeLegendProps {
  className?: string;
  /** Defaults to the app-wide settings store. */
  store?: StoreApi<PointcloudSettings>;
  /** The 3D view whose pointer reads the distance; defaults to the active scene. */
  scene?: () => SceneHandle | null;
  /** More about the same dates under the legend (the volume change). */
  children?: ReactNode;
}

/** The change legend while the clouds are coloured by change and a change cloud shows. */
export function ChangeLegend({
  className,
  store = pointcloudSettings,
  scene = getActiveScene,
  children,
}: ChangeLegendProps) {
  const mode = useStore(store, (x) => x.colourMode);
  const threshold = useStore(store, (x) => x.changeThreshold);
  const manual = useStore(store, (x) => x.changeRange);
  const scalar = usePointcloudCounts().scalar ?? null;
  const on = mode === 'change' && scalar !== null;
  const hover = useScalarHover(scene, on);
  if (!on) return null;
  return (
    <ChangeLegendView
      className={className}
      scalar={scalar}
      range={manual ?? scalar.range}
      threshold={threshold}
      onThreshold={(m) => {
        store.getState().setChangeThreshold(m);
      }}
      hover={hover}
    >
      {children}
    </ChangeLegendView>
  );
}
