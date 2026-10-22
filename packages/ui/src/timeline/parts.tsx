import type { ClockStore } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import { formatClock } from '../format';
import { t } from '../i18n';
import { Icon } from '../icons/Icon';
import { platformKeys } from '../shortcut';
import { generateTicks, pickTickStep, type Tick, type TickStep } from './ticks';

export const RATES = [0.25, 0.5, 1, 2, 4, 8] as const;

const MIN_SPAN = 2_000;

export function tickLabel(t: number, major: number): string {
  const d = new Date(t);
  if (major >= 86_400_000) return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  const clock = formatClock(t);
  if (major >= 60_000) return clock.slice(0, 5);
  if (major >= 1_000) return clock;
  return `${clock}.${String(d.getUTCMilliseconds()).padStart(3, '0').slice(0, 1)}`;
}

export interface TimeAxis {
  /** Visible span, null while nothing carries time. */
  view: [number, number] | null;
  /** Width of the tracks in px. */
  width: number;
  span: number;
  step: TickStep;
  ticks: Tick[];
  /** Position of a time in percent of the tracks. */
  x: (t: number) => number;
  pct: (t: number) => string;
  /** Time under a pointer x. */
  timeAt: (clientX: number) => number;
  zoom: (factor: number, anchor: number) => void;
  /** Back to the whole range. */
  fit: () => void;
  /** Bring a time that left the view back into it (the playhead while playing). */
  follow: (t: number) => void;
}

/**
 * The visible span of a time axis drawn in `tracksRef`: fits `range` until the user zooms or pans
 * (Ctrl + wheel zooms at the cursor, wheel pans); `follow` keeps the playhead in view.
 */
export function useTimeAxis(
  tracksRef: RefObject<HTMLDivElement | null>,
  range: [number, number] | null,
): TimeAxis {
  const [width, setWidth] = useState(800);
  const hasTime = range !== null;
  const rangeKey = range ? `${range[0]}:${range[1]}` : 'none';
  const [manual, setManual] = useState<{ key: string; view: [number, number] } | null>(null);
  // A new project or new clip durations reset the view to fit.
  const view = manual?.key === rangeKey ? manual.view : range;
  const setView = useCallback(
    (v: [number, number] | null) => {
      setManual(v ? { key: rangeKey, view: v } : null);
    },
    [rangeKey],
  );
  // Keep the playhead in view while playing: called by the playhead as the clock moves.
  const follow = useCallback(
    (t: number) => {
      if (!view || (t <= view[1] && t >= view[0])) return;
      const s = view[1] - view[0];
      setManual({ key: rangeKey, view: [t - s * 0.1, t + s * 0.9] });
    },
    [view, rangeKey],
  );

  useLayoutEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(1, entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.max(1, el.clientWidth));
    return () => {
      ro.disconnect();
    };
  }, [hasTime, tracksRef]);

  const [v0, v1] = view ?? [0, 1];
  const span = Math.max(v1 - v0, 1);
  const x = useCallback((t: number) => ((t - v0) / span) * 100, [v0, span]);
  const pct = useCallback((t: number) => `${x(t).toFixed(3)}%`, [x]);
  const step = useMemo(() => pickTickStep(span, width), [span, width]);
  const ticks = useMemo(() => generateTicks(v0, v1, step), [v0, v1, step]);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = tracksRef.current;
      if (!el) return v0;
      const r = el.getBoundingClientRect();
      return v0 + ((clientX - r.left) / Math.max(r.width, 1)) * span;
    },
    [v0, span, tracksRef],
  );

  const zoom = useCallback(
    (factor: number, anchor: number) => {
      if (!view) return;
      const [a, b] = view;
      const next = Math.max(MIN_SPAN, (b - a) * factor);
      const f = (anchor - a) / (b - a);
      setView([anchor - next * f, anchor + next * (1 - f)]);
    },
    [view, setView],
  );

  // Ctrl + wheel zooms at the cursor, wheel pans. Registered natively to allow preventDefault.
  useEffect(() => {
    const el = tracksRef.current;
    if (!el || !view) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e.clientX));
      } else {
        const d = ((e.deltaX || e.deltaY) / Math.max(width, 1)) * span;
        setView([v0 + d, v1 + d]);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [view, setView, zoom, timeAt, width, span, v0, v1, tracksRef]);

  return {
    view,
    width,
    span,
    step,
    ticks,
    x,
    pct,
    timeAt,
    zoom,
    fit: () => {
      setView(range);
    },
    follow,
  };
}

/** A value of the clock, read again on every tick; renders only when the value changes. */
function useClockValue<T>(clock: ClockStore, select: (nowMs: number) => T): T {
  return useSyncExternalStore(clock.subscribe, () => select(clock.getState().nowMs));
}

export interface PlayheadProps {
  clock: ClockStore;
  axis: TimeAxis;
  /** Where the clock draws on the axis (null: nowhere). Keep it stable (useCallback). */
  at: (nowMs: number) => number | null;
  /** Keep the line in view (the playhead while playing). */
  follow: boolean;
  className: string;
  testId: string;
}

/**
 * The line at the clock. It follows the clock on its own, with a transform written straight to
 * the element: a playback frame neither renders the timeline nor lays it out again.
 */
export function Playhead(p: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { clock, at, follow: keep } = p;
  const { x, follow } = p.axis;
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const t = at(clock.getState().nowMs);
      if (t === null) {
        el.style.visibility = 'hidden';
        return;
      }
      el.style.visibility = '';
      // the element spans the tracks, so a translate in % of its own width is % of the tracks
      el.style.transform = `translateX(${x(t).toFixed(3)}%)`;
      if (keep) follow(t);
    };
    place();
    return clock.subscribe(place);
  }, [clock, at, x, follow, keep]);
  return <div ref={ref} className={`${p.className} ph-rail`} data-testid={p.testId} />;
}

export function Ruler({ axis }: { axis: TimeAxis }) {
  return (
    <div className="tl-ruler" aria-hidden="true">
      {axis.ticks.map((tk) => (
        <span key={tk.t}>
          <i className={`tk ${tk.major ? 'maj' : 'min'}`} style={{ left: axis.pct(tk.t) }} />
          {tk.major && (
            <span className="tkl" style={{ left: axis.pct(tk.t) }}>
              {tickLabel(tk.t, axis.step.major)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

export interface TransportProps {
  canStep: boolean;
  canPlay: boolean;
  playing: boolean;
  /** The clock the timecode shows (null: nothing carries time). */
  clock: ClockStore | null;
  /** Added to the clock for the timecode (a site time zone). */
  shiftMs?: number;
  rate: number;
  activeName?: string | undefined;
  onStep: (dir: 1 | -1) => void;
  onTogglePlay: () => void;
  onRate: (rate: number) => void;
}

/** Previous / play / next, the timecode, the rate and the active clip tag. */
export function Transport(p: TransportProps) {
  const nextRate = () => {
    const i = RATES.findIndex((r) => r === p.rate);
    p.onRate(RATES[(i + 1) % RATES.length] ?? 1);
  };
  return (
    <>
      <div className="transport">
        <button
          className="tool tip-up"
          type="button"
          onClick={() => {
            p.onStep(-1);
          }}
          disabled={!p.canStep}
          aria-label="Previous clip"
        >
          <Icon name="back" />
          <span className="tip">Previous clip</span>
        </button>
        <button
          className="tool play"
          type="button"
          onClick={p.onTogglePlay}
          disabled={!p.canPlay}
          aria-label={p.playing ? 'Pause' : 'Play'}
          aria-keyshortcuts="Space"
        >
          <Icon name={p.playing ? 'pause' : 'play'} />
        </button>
        <button
          className="tool tip-up"
          type="button"
          onClick={() => {
            p.onStep(1);
          }}
          disabled={!p.canStep}
          aria-label="Next clip"
        >
          <Icon name="fwd" />
          <span className="tip">Next clip</span>
        </button>
      </div>
      <div className="tc" data-testid="timecode">
        {p.clock !== null ? <Timecode clock={p.clock} shiftMs={p.shiftMs ?? 0} /> : '--:--:--'}
      </div>
      <button
        className="rate"
        type="button"
        onClick={nextRate}
        title="Playback rate"
        aria-label={`Playback rate ${p.rate}x`}
      >
        {p.rate.toFixed(p.rate < 1 ? 2 : 1)}×
      </button>
      {p.activeName && (
        <span className="tag">
          <Icon name="video" size={12} />
          {p.activeName}
        </span>
      )}
    </>
  );
}

/** The clock as hh:mm:ss.ff (30 frames a second); renders once per frame shown, not per tick. */
function Timecode({ clock, shiftMs }: { clock: ClockStore; shiftMs: number }) {
  const text = useClockValue(clock, (nowMs) => {
    const ms = nowMs + shiftMs;
    const frames = String(Math.floor(((((ms % 1000) + 1000) % 1000) / 1000) * 30)).padStart(2, '0');
    return `${formatClock(ms)}.${frames}`;
  });
  const dot = text.lastIndexOf('.');
  return (
    <>
      {text.slice(0, dot)}
      <small>{text.slice(dot)}</small>
    </>
  );
}

/** Zoom out, fit, zoom in; the buttons zoom around `anchor()` (the playhead). */
export function ZoomControls({ axis, anchor }: { axis: TimeAxis; anchor: () => number }) {
  return (
    <div className="seg icons" role="group" aria-label="Timeline zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title={`Zoom out (${platformKeys('Ctrl')} + wheel)`}
        onClick={() => {
          axis.zoom(1.6, anchor());
        }}
      >
        <Icon name="minus" size={14} />
      </button>
      <button type="button" aria-label="Fit" title="Fit everything" onClick={axis.fit}>
        <Icon name="maximize" size={14} />
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title={`Zoom in (${platformKeys('Ctrl')} + wheel)`}
        onClick={() => {
          axis.zoom(0.625, anchor());
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

/** Collapse the timeline (it has no key: the island's View row shows it again). */
export function HideButton({ onHide }: { onHide: () => void }) {
  return (
    <button
      className="tool tip-up tl-hide"
      type="button"
      onClick={onHide}
      aria-label={t('timeline.hide')}
    >
      <Icon name="chevdown" />
      <span className="tip tip-end">{t('timeline.hide')}</span>
    </button>
  );
}

export interface KeyframeDiamondProps {
  layerId: string;
  /** Index into the clip's keyframes. */
  index: number;
  /** The clip's name, for the title. */
  name: string;
  style: CSSProperties;
  /** Project time under a pointer x. */
  timeAt: (clientX: number) => number;
  onKeyframe?: ((layerId: string, index: number) => void) | undefined;
  onKeyframeMove?:
    ((layerId: string, index: number, tMs: number, phase: 'move' | 'end') => void) | undefined;
}

/** A camera direction keyframe: a click selects it, a drag past 3 px moves it. */
export function KeyframeDiamond(p: KeyframeDiamondProps) {
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const label = `Camera direction keyframe ${String(p.index + 1)} of ${p.name}`;
  return (
    <button
      type="button"
      data-hit
      className="kf"
      style={p.style}
      title={label}
      aria-label={label}
      data-testid="timeline-direction-key"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !p.onKeyframeMove) return;
        if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
        d.moved = true;
        p.onKeyframeMove(p.layerId, p.index, p.timeAt(e.clientX), 'move');
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) p.onKeyframeMove?.(p.layerId, p.index, p.timeAt(e.clientX), 'end');
        else p.onKeyframe?.(p.layerId, p.index);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          p.onKeyframe?.(p.layerId, p.index);
        }
      }}
    />
  );
}
