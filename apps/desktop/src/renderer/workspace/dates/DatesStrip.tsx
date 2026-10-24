/**
 * The dates chart strip under the stage (volumetrics redesign, spec section 5, boards 1, 2, 6):
 * a 30 px bar (play, step, speed, loop; Volume | Tonnes | Cut & fill with its legend; Compare, fit,
 * collapse) over a 130 px chart of the site's stockpiles through the survey dates. x is true time
 * with month gridlines and a labelled marker per survey; Volume and Tonnes stack the materials in
 * their colours, straight between survey points; Cut & fill draws diverging bars between
 * consecutive surveys. The playhead sits on the date in focus and drags to another survey; the
 * compare band spans the compare pair with its change; a selected pile draws its own line over the
 * site total, faded, each on its own scale.
 *
 * Built in the profile and time charts' language (`.pc-*`: grid, axis titles, crosshair, readout
 * card, chips). Nothing is estimated between surveys: during playback the readout shows the last
 * survey passed. Labelled "Survey dates chart", never "Timeline" (that is the footage timeline).
 */
import { formatNumber, fromSI, localeOf, unitFactor, unitLabel, type NumberLocale } from '@aio/geo';
import type { SurveyUnits } from '@aio/schema';
import { inventoryPiles, NO_MATERIAL_COLOUR } from '@aio/survey';
import { Icon, Tip, useT, type IconName } from '@aio/ui';
import { dateTags, useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useMeasure, select } from '../../survey/measureStore';
import { useCounted } from '../../survey/useInventory';
import { useFocusCapture } from '../../survey/qaHelpers';
import { useSurfaceStates, type SurfaceState } from '../../survey/surfaceStates';
import { cutFillPrefs } from '../../survey/volumes/cutFill';
import { materialsDraft } from '../../survey/volumes/materialsDraft';
import { timeline } from '../timeline';
import { datesCollapsed } from '../timelinePref';
import { compareDates, defaultPair } from './compareDates';
import { datesPlayer, type PlayerSpeed } from './datesPlayer';
import { useStripCutFill, type StripCutFill } from './stripCutFill';
import { timelapseStore } from './timelapse';
import { useTimelapseConnection } from './TimelapseFloats';
import {
  changeBetween,
  consecutivePairs,
  legendOf,
  nearestDay,
  readoutOf,
  stepDay,
  stripDates,
  stripDays,
  valueOn,
  withAssignments,
  type StripDay,
} from './stripData';
import {
  cutFillBars,
  monthTicks,
  stackSeries,
  stripScale,
  yTickLabel,
  yTicks,
  type StripMode,
} from './stripModel';
import '../../charts/charts.css';
import './datesStrip.css';

/** The bar and the chart (spec: 30 px and 130 px, 160 px in all). */
const CHART_H = 130;
const PAD = { left: 52, right: 16, top: 22, bottom: 30 };
const MONTH_Y = 12;
const DEFAULT_WIDTH = 720;
/** Month labels are never closer than this. */
const MIN_MONTH_PX = 64;
/** Survey labels: one character of the label font, and the space kept between labels. */
const CHAR_W = 6.4;
const LABEL_GAP = 12;
const READOUT_GAP = 10;
const SPEEDS: readonly PlayerSpeed[] = [0.5, 1, 2, 4];
const MODES: readonly StripMode[] = ['volume', 'tonnes', 'cutFill'];
const DAY_MS = 86_400_000;

export interface StripPile {
  id: string;
  label: string;
  colour: string;
}

export interface DatesStripViewProps {
  /** The dated surveys, oldest first, with their figures. */
  days: readonly StripDay[];
  /** The date in focus. */
  focus: string | null;
  mode: StripMode;
  onMode: (mode: StripMode) => void;
  units: SurveyUnits;
  locale: NumberLocale;
  /** A density edit is unsaved: the Tonnes figures preview it. */
  preview: boolean;
  states?: ReadonlyMap<string, SurfaceState>;
  pile: StripPile | null;
  onClearPile: () => void;
  compare: { on: boolean; from: string | null; to: string | null };
  onCompareToggle: () => void;
  onCompareSet: (from: string, to: string) => void;
  cutFill?: StripCutFill;
  player: {
    playing: boolean;
    speed: PlayerSpeed;
    loop: boolean;
    /** A fixed playhead time while playing, when there is no `playhead` source (tests). */
    t?: number | null;
    /** The last survey passed while playing. */
    passed: string | null;
  };
  /** The player's moving time; only the playhead subscribes to it. */
  playhead?: PlayheadSource;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: PlayerSpeed) => void;
  onLoop: () => void;
  /** Jump to a survey (a marker, a drag, a step, a key). */
  onFocus: (capture: string) => void;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  /** Width given: no ResizeObserver (tests). */
  width?: number;
}

/** The player's time as it moves (read by the playhead alone, each frame of playback). */
export interface PlayheadSource {
  get: () => number | null;
  subscribe: (cb: () => void) => () => void;
}

const NO_SOURCE: PlayheadSource = { get: () => null, subscribe: () => () => undefined };

/**
 * The playhead's marks: at the player's time while it plays (subscribed here, so only these
 * re-render each frame), else at `restT` (the date in focus, or where it is dragged).
 */
function AtPlayhead(p: {
  follow: boolean;
  source: PlayheadSource | undefined;
  /** A fixed time while playing, when no source is given (tests). */
  fixedT: number | null;
  restT: number;
  render: (t: number) => ReactElement;
}): ReactElement {
  const src = p.source ?? NO_SOURCE;
  const live = useSyncExternalStore(src.subscribe, src.get);
  const t = p.follow ? ((p.source ? live : p.fixedT) ?? p.restT) : p.restT;
  return p.render(t);
}

/** Pointer capture where the platform has it (jsdom has none). */
function capture(el: Element, id: number, on: boolean): void {
  try {
    if (on) el.setPointerCapture(id);
    else el.releasePointerCapture(id);
  } catch {
    // no capture: the drag still follows while the pointer stays over the grip
  }
}

/** A tool button of the bar, with its tip above (the footage timeline's transport look). */
function Tool(p: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  expanded?: boolean;
  testId?: string;
}): ReactElement {
  return (
    <Tip content={p.label} placement="top" repeatsName>
      <button
        type="button"
        className={p.className ? `tool ${p.className}` : 'tool'}
        aria-label={p.label}
        aria-pressed={p.pressed}
        aria-expanded={p.expanded}
        disabled={p.disabled}
        data-testid={p.testId}
        onClick={p.onClick}
      >
        <Icon name={p.icon} />
      </button>
    </Tip>
  );
}

const MINUS = '−';

export function DatesStripView(p: DatesStripViewProps): ReactElement {
  const t = useT();
  const chart = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^\w-]/g, '');
  const clipId = `ds-clip-${uid}`;
  const hatchId = `ds-hatch-${uid}`;
  const [measured, setMeasured] = useState(DEFAULT_WIDTH);
  const fixedWidth = p.width;
  useLayoutEffect(() => {
    if (fixedWidth !== undefined) return;
    const el = chart.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setMeasured(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [fixedWidth, p.collapsed]);
  const w = fixedWidth ?? measured;

  const { days, mode, units, locale, pile } = p;
  const states = p.states ?? new Map<string, SurfaceState>();
  const stateOf = (capture: string) => states.get(capture)?.kind;

  // ---------------------------------------------------------------- formats
  const volF = unitFactor('volume', units.volume);
  const vUnit = unitLabel(units.volume);
  const num = (v: number, d = 0) => formatNumber(v, d, locale);
  const bareVol = (m3: number) => num(fromSI(m3, 'volume', units.volume));
  const volText = (m3: number) => `${bareVol(m3)} ${vUnit}`;
  // tonnes in the site's mass unit, as the Volumes header writes them (`massParts`)
  const mUnit = unitLabel(units.mass);
  const bareMass = (tn: number) => num(fromSI(tn * 1000, 'mass', units.mass));
  const tonText = (tn: number) => `${bareMass(tn)} ${mUnit}`;
  const signed = (s: string, v: number) =>
    /[1-9]/.test(s) ? `${v < 0 ? MINUS : '+'}${s}` : s.replace(/^-/, '');
  const quantText = (v: number, withSign: boolean) => {
    const bare = mode === 'tonnes' ? bareMass(Math.abs(v)) : bareVol(Math.abs(v));
    const s = withSign ? signed(bare, v) : bare;
    return `${s} ${mode === 'tonnes' ? mUnit : vUnit}`;
  };

  // ---------------------------------------------------------------- the x scale
  const [fit, setFit] = useState<readonly [number, number] | null>(null);
  const left = PAD.left;
  const right = Math.max(left + 1, w - PAD.right);
  const plotW = right - left;
  const top = PAD.top;
  const bottom = CHART_H - PAD.bottom;
  const plotH = bottom - top;
  // playback always shows every survey
  const view = p.player.playing ? null : fit;
  // the scale, the month ticks, the stack and the legend change with the surveys, the width and
  // the mode, never with the playhead (they are not worked out again each frame of playback)
  const sc = useMemo(() => stripScale(view ?? days.map((d) => d.t), plotW), [view, days, plotW]);
  const X = (time: number) => left + sc.x(time);
  const inView = (x: number) => x >= left - 0.5 && x <= right + 0.5;
  const timeOf = (capture: string) => days.find((d) => d.capture === capture)?.t ?? null;
  const dayOf = (capture: string | null) =>
    capture === null ? undefined : days.find((d) => d.capture === capture);

  // month gridlines, thinned to every 2, 3, 6 or 12 months when they would crowd
  const months = useMemo(() => {
    const perMonth = (plotW * 30.4 * DAY_MS) / Math.max(1, sc.t1 - sc.t0);
    const every = [1, 2, 3, 6, 12, 24].find((k) => k * perMonth >= MIN_MONTH_PX) ?? 24;
    return monthTicks(sc.t0, sc.t1).filter((m) => {
      const d = new Date(m.t);
      return (d.getUTCFullYear() * 12 + d.getUTCMonth()) % every === 0;
    });
  }, [sc, plotW]);

  // ---------------------------------------------------------------- the y scale and the marks
  // the axis in the site's units: tonnes in its mass unit
  const qf = mode === 'tonnes' ? unitFactor('mass', units.mass) / 1000 : volF;
  const stacked = mode !== 'cutFill' && !pile;
  const stack = useMemo(
    () => (stacked ? stackSeries(stripDates(days), mode) : null),
    [stacked, days, mode],
  );
  const pileVals = pile && mode !== 'cutFill' ? days.map((d) => valueOn(d, mode, pile.id)) : null;
  const siteVals = pile && mode !== 'cutFill' ? days.map((d) => valueOn(d, mode, null)) : null;
  const known = (vs: readonly (number | null)[]) => vs.flatMap((v) => (v === null ? [] : [v]));
  const bars = mode === 'cutFill' ? cutFillBars(p.cutFill?.bars ?? [], sc, timeOf) : [];
  const yMax =
    mode === 'cutFill'
      ? Math.max(0, ...bars.flatMap((b) => [b.cutM3, b.fillM3]))
      : pileVals
        ? Math.max(0, ...known(pileVals))
        : (stack?.max ?? 0);
  // a negative figure is drawn below zero, never clamped to it
  const yMin =
    mode === 'cutFill' ? 0 : pileVals ? Math.min(0, ...known(pileVals)) : (stack?.min ?? 0);
  const hasData = yMax > 0 || yMin < 0;
  /** A value scale from zero (or below it, for a negative figure) to a round top. */
  const valueScale = (max: number, min: number) => {
    const ticks = yTicks(Math.max(max, 0) / qf);
    const step = (ticks[1] ?? 1) * qf;
    const hi = (ticks[2] ?? 1) * qf;
    const lo = min < 0 ? -Math.ceil(-min / step) * step : 0;
    return { ticks, hi, lo, y: (v: number) => bottom - ((v - lo) / (hi - lo)) * plotH };
  };
  const ys = valueScale(yMax, yMin);
  const extent = ys.hi;
  const mid = (top + bottom) / 2;
  const Y = (v: number) => (mode === 'cutFill' ? mid - (v / extent) * (plotH / 2) : ys.y(v));
  const siteVs = siteVals ? known(siteVals) : [];
  const Ysite = valueScale(Math.max(0, ...siteVs), Math.min(0, ...siteVs)).y;
  const tickRows =
    mode === 'cutFill'
      ? [
          { v: extent, label: yTickLabel(extent / qf) },
          { v: 0, label: '0' },
          { v: -extent, label: `${MINUS}${yTickLabel(extent / qf)}` },
        ]
      : [
          ...(ys.lo < 0 ? [{ v: ys.lo, label: `${MINUS}${yTickLabel(-ys.lo / qf)}` }] : []),
          ...ys.ticks.map((v) => ({ v: v * qf, label: yTickLabel(v) })),
        ];
  const yTitle =
    mode === 'tonnes'
      ? units.mass === 't'
        ? t('strip.axis.tonnes')
        : `${t('strip.mode.tonnes')} (${mUnit})`
      : mode === 'cutFill'
        ? t('strip.axis.change', { unit: vUnit })
        : t('strip.axis.volume', { unit: vUnit });

  /** Runs of consecutive points with a value (a gap breaks the line). */
  const runs = (vals: readonly (number | null)[], y: (v: number) => number) => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    days.forEach((d, i) => {
      const v = vals[i];
      if (v === null || v === undefined) {
        if (cur.length > 0) out.push(cur);
        cur = [];
      } else cur.push([X(d.t), y(v)]);
    });
    if (cur.length > 0) out.push(cur);
    return out;
  };
  const line = (pts: readonly [number, number][]) =>
    pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = (pts: readonly [number, number][], base: number) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return '';
    return `M${first[0].toFixed(1)},${base.toFixed(1)} L${line(pts).replaceAll(' ', ' L')} L${last[0].toFixed(1)},${base.toFixed(1)}Z`;
  };

  // ---------------------------------------------------------------- the playhead
  const focusDay = dayOf(p.focus) ?? days[days.length - 1];
  const [drag, setDrag] = useState<number | null>(null);
  // while playing, only the playhead follows the player's time (`AtPlayhead`); the rest of the
  // strip stays as it is between surveys
  const followPlayer = p.player.playing && drag === null;
  const restT = drag ?? focusDay?.t ?? null;
  const playheadX = restT === null ? null : X(restT);
  const atPlayhead = (render: (x: number) => ReactElement) =>
    restT === null ? null : (
      <AtPlayhead
        follow={followPlayer}
        source={p.playhead}
        fixedT={p.player.t ?? null}
        restT={restT}
        render={(tm) => render(X(tm))}
      />
    );
  const [hover, setHover] = useState<string | null>(null);
  const focusIndex = focusDay ? days.indexOf(focusDay) : -1;

  const pointerTime = (clientX: number) => {
    const r = chart.current?.getBoundingClientRect();
    const x = clientX - (r?.left ?? 0) - left;
    return sc.t(Math.min(plotW, Math.max(0, x)));
  };
  const lastDragFocus = useRef<string | null>(null);
  const onPlayheadDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    capture(e.currentTarget, e.pointerId, true);
    if (p.player.playing) p.onPause();
    lastDragFocus.current = p.focus;
    setDrag(pointerTime(e.clientX));
  };
  const onPlayheadMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const tm = pointerTime(e.clientX);
    setDrag(tm);
    // the date in focus follows the nearest survey while dragging
    const near = nearestDay(days, tm);
    if (near && near.capture !== lastDragFocus.current) {
      lastDragFocus.current = near.capture;
      p.onFocus(near.capture);
    }
  };
  const onPlayheadUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    capture(e.currentTarget, e.pointerId, false);
    const near = nearestDay(days, pointerTime(e.clientX));
    setDrag(null);
    if (near && near.capture !== lastDragFocus.current) p.onFocus(near.capture);
  };
  const stepTo = (dir: -1 | 1) => {
    const next = stepDay(days, focusDay?.capture ?? null, dir);
    if (next && next.capture !== focusDay?.capture) p.onFocus(next.capture);
  };
  const onPlayheadKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: StripDay | null | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp')
      next = stepDay(days, focusDay?.capture ?? null, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')
      next = stepDay(days, focusDay?.capture ?? null, -1);
    else if (e.key === 'Home') next = days[0];
    else if (e.key === 'End') next = days[days.length - 1];
    else return;
    e.preventDefault();
    if (next && next.capture !== focusDay?.capture) p.onFocus(next.capture);
  };

  // the plot: hover shows the nearest survey's readout, a click jumps to it
  const onPlotMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag !== null) return;
    setHover(nearestDay(days, pointerTime(e.clientX))?.capture ?? null);
  };
  const onPlotClick = (e: { clientX: number }) => {
    const near = nearestDay(days, pointerTime(e.clientX));
    if (near && near.capture !== p.focus) p.onFocus(near.capture);
  };

  // ---------------------------------------------------------------- the compare band
  const cmpFrom = p.compare.on ? dayOf(p.compare.from) : undefined;
  const cmpTo = p.compare.on ? dayOf(p.compare.to) : undefined;
  const band = cmpFrom && cmpTo && cmpFrom !== cmpTo ? { from: cmpFrom, to: cmpTo } : null;
  const bandDelta = band
    ? changeBetween(days, band.from.capture, band.to.capture, mode, pile?.id ?? null)
    : null;
  const [bracket, setBracket] = useState<{ side: 'from' | 'to'; t: number } | null>(null);
  const moveBracket = (side: 'from' | 'to', to: StripDay) => {
    if (!band) return;
    const other = side === 'from' ? band.to : band.from;
    if (to.capture === other.capture) return;
    if (side === 'from') p.onCompareSet(to.capture, other.capture);
    else p.onCompareSet(other.capture, to.capture);
  };
  const bracketHandlers = (side: 'from' | 'to') => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      capture(e.currentTarget, e.pointerId, true);
      setBracket({ side, t: pointerTime(e.clientX) });
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      if (bracket?.side !== side) return;
      setBracket({ side, t: pointerTime(e.clientX) });
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      if (bracket?.side !== side) return;
      capture(e.currentTarget, e.pointerId, false);
      const near = nearestDay(days, pointerTime(e.clientX));
      setBracket(null);
      if (near) moveBracket(side, near);
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!band) return;
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (dir === 0) return;
      e.preventDefault();
      const at = side === 'from' ? band.from : band.to;
      const next = stepDay(days, at.capture, dir);
      if (next) moveBracket(side, next);
    },
  });
  const bandX = (side: 'from' | 'to') =>
    bracket?.side === side ? X(bracket.t) : band ? X(band[side].t) : 0;

  // ---------------------------------------------------------------- fit
  const canFitCompare = !p.player.playing && p.compare.on && band !== null && view === null;
  const fitLabel = canFitCompare ? t('strip.fit') : t('strip.fitAll');
  const onFit = () => {
    if (canFitCompare) setFit([band.from.t, band.to.t]);
    else setFit(null);
  };

  // ---------------------------------------------------------------- the survey labels
  // the date in focus keeps its label; the others take theirs where there is room
  const labelled = useMemo(() => {
    const out = new Set<string>();
    const keep: { x: number; half: number }[] = [];
    const room = (x: number, half: number) =>
      x >= left - 0.5 &&
      x <= right + 0.5 &&
      keep.every((k) => Math.abs(k.x - x) >= k.half + half + LABEL_GAP);
    const order = focusDay ? [focusDay, ...days.filter((d) => d !== focusDay)] : [...days];
    for (const d of order) {
      const x = left + sc.x(d.t);
      const half = (d.label.length * CHAR_W) / 2;
      if (room(x, half)) {
        keep.push({ x, half });
        out.add(d.capture);
      }
    }
    return out;
  }, [days, focusDay, sc, left, right]);

  // ---------------------------------------------------------------- the readout
  const passedDay = p.player.playing ? dayOf(p.player.passed) : undefined;
  const dragDay = drag !== null ? nearestDay(days, drag) : null;
  const readDay = dayOf(hover) ?? dragDay ?? passedDay ?? focusDay;
  const ro = readDay ? readoutOf(days, readDay.capture, mode, pile?.id ?? null, stateOf) : null;
  // while playing the card stands at the last survey passed (it changes only there)
  const roX =
    hover !== null && readDay
      ? X(readDay.t)
      : followPlayer && passedDay
        ? X(passedDay.t)
        : (playheadX ?? 0);
  const roFlip = roX > left + plotW / 2;
  const deltaText = (v: number, pct: number | null) => {
    const pctText = pct === null ? '' : `${signed(num(Math.abs(pct), 1), pct)} %`;
    return t('strip.readout.delta', { delta: quantText(v, true), percent: pctText });
  };

  // ---------------------------------------------------------------- the bar
  const legend = useMemo(() => legendOf(days), [days]);
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(p.player.speed) + 1) % SPEEDS.length] ?? 1;
  const speedText = `${num(p.player.speed, p.player.speed < 1 ? 1 : 0)}×`;
  const atStart = focusIndex <= 0;
  const atEnd = focusIndex < 0 || focusIndex >= days.length - 1;

  const compareLabel = (() => {
    if (!band) return null;
    const SENTINEL = '\u0000';
    const text = t('strip.compareLabel', {
      from: band.from.short,
      to: band.to.short,
      delta: SENTINEL,
    });
    const [head, tail = ''] = text.split(SENTINEL);
    return (
      <>
        {head}
        {bandDelta === null ? (
          '-'
        ) : (
          <span className="ds-band-delta" data-kind={bandDelta < 0 ? 'cut' : 'fill'}>
            {quantText(bandDelta, true)}
          </span>
        )}
        {tail}
      </>
    );
  })();

  const pileColour = pile?.colour ?? 'var(--chart-current)';

  return (
    <div
      className="ds"
      role="region"
      aria-label={t('strip.region')}
      data-testid="dates-strip"
      data-mode={mode}
      data-collapsed={p.collapsed ? '' : undefined}
      dir="ltr"
    >
      <div className="tl-h ds-bar">
        <div className="transport">
          <Tool
            className="play"
            icon={p.player.playing ? 'pause' : 'play'}
            label={p.player.playing ? t('strip.pause') : t('strip.play')}
            testId="strip-play"
            disabled={days.length < 2}
            onClick={p.player.playing ? p.onPause : p.onPlay}
          />
          <Tool
            className="ds-opt"
            icon="back"
            label={t('strip.previous')}
            disabled={atStart}
            onClick={() => {
              stepTo(-1);
            }}
          />
          <Tool
            className="ds-opt"
            icon="fwd"
            label={t('strip.next')}
            disabled={atEnd}
            onClick={() => {
              stepTo(1);
            }}
          />
          <Tip content={t('strip.speed', { speed: speedText })} placement="top" repeatsName>
            <button
              type="button"
              className="rate ds-speed"
              aria-label={t('strip.speed', { speed: speedText })}
              onClick={() => {
                p.onSpeed(nextSpeed);
              }}
            >
              {speedText}
            </button>
          </Tip>
          <Tool
            className="ds-opt"
            icon="loop"
            label={t('strip.loop')}
            pressed={p.player.loop}
            onClick={p.onLoop}
          />
        </div>
        <span className="vsep" aria-hidden="true" />
        <div className="seg ds-modes">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-mode={m}
              onClick={() => {
                p.onMode(m);
              }}
            >
              {t(`strip.mode.${m}`)}
            </button>
          ))}
        </div>
        <div className="ds-key">
          {pile ? (
            <>
              <span className="pc-chip ds-pile" data-on="" style={{ borderColor: pileColour }}>
                <span className="pc-chip-main">
                  <i className="pc-swatch ds-swatch" style={{ background: pileColour }} />
                  {pile.label}
                </span>
                <Tip content={t('strip.clearPile')} placement="top" repeatsName>
                  <button
                    type="button"
                    className="pc-chip-x"
                    aria-label={t('strip.clearPile')}
                    data-testid="strip-clear-pile"
                    onClick={p.onClearPile}
                  >
                    <Icon name="x" />
                  </button>
                </Tip>
              </span>
              {mode !== 'cutFill' && (
                <span className="ds-faded">
                  <i className="ds-swatch ds-swatch-faded" aria-hidden="true" />
                  {t('strip.siteTotalFaded')}
                </span>
              )}
            </>
          ) : mode === 'cutFill' ? (
            <span className="ds-cf-key">
              <i className="ds-swatch" data-kind="fill" aria-hidden="true" />
              <i className="ds-swatch" data-kind="cut" aria-hidden="true" />
              {t('strip.legendCutFill')}
            </span>
          ) : (
            <ul className="ds-legend" data-testid="strip-legend">
              {legend.map((e) => (
                <li key={e.key || 'none'}>
                  <i className="ds-swatch" style={{ background: e.colour }} aria-hidden="true" />
                  {e.name ?? t('volumes.noMaterial')}
                </li>
              ))}
            </ul>
          )}
          {p.preview && mode === 'tonnes' && (
            <span className="ds-preview" data-testid="strip-preview">
              {t('strip.preview')}
            </span>
          )}
        </div>
        <span className="sp" />
        <div className="seg">
          <button
            type="button"
            aria-pressed={p.compare.on}
            data-testid="strip-compare"
            onClick={p.onCompareToggle}
          >
            {t('strip.compare')}
          </button>
        </div>
        <Tool icon="maximize" label={fitLabel} onClick={onFit} testId="strip-fit" />
        <Tool
          icon={p.collapsed ? 'chevup' : 'chevdown'}
          label={p.collapsed ? t('strip.expand') : t('strip.collapse')}
          expanded={!p.collapsed}
          testId="strip-collapse"
          onClick={() => {
            p.onCollapse(!p.collapsed);
          }}
        />
      </div>

      {!p.collapsed && (
        <div
          ref={chart}
          className="ds-chart"
          data-testid="strip-chart"
          onPointerMove={onPlotMove}
          onPointerLeave={() => {
            setHover(null);
          }}
        >
          <svg
            className="pc-svg ds-svg"
            width={w}
            height={CHART_H}
            aria-hidden="true"
            onClick={onPlotClick}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={left} y={0} width={plotW} height={CHART_H} />
              </clipPath>
              <pattern
                id={hatchId}
                width={6}
                height={6}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1={0} y1={0} x2={0} y2={6} className="ds-hatch-line" />
              </pattern>
            </defs>

            {/* the value axis: three ticks and its title, turned along the axis */}
            {hasData && (
              <g className="pc-grid" data-axis="y">
                {tickRows.map((r) => (
                  <g key={r.label}>
                    <line x1={left} x2={right} y1={Y(r.v)} y2={Y(r.v)} />
                    <text x={left - 6} y={Y(r.v)} textAnchor="end" dominantBaseline="middle">
                      {r.label}
                    </text>
                  </g>
                ))}
              </g>
            )}
            <text
              className="pc-axis-title"
              transform={`translate(12 ${String((top + bottom) / 2)}) rotate(-90)`}
              textAnchor="middle"
            >
              {yTitle}
            </text>

            {/* month gridlines, labelled along the top */}
            <g className="ds-months" clipPath={`url(#${clipId})`}>
              {months.map((m) => (
                <g key={m.t} data-month={m.label}>
                  <line x1={X(m.t)} x2={X(m.t)} y1={top - 6} y2={bottom} />
                  <text x={X(m.t) + 4} y={MONTH_Y}>
                    {m.label}
                  </text>
                </g>
              ))}
            </g>

            <g clipPath={`url(#${clipId})`}>
              {band && (
                <rect
                  className="ds-band"
                  data-testid="strip-band"
                  x={Math.min(bandX('from'), bandX('to'))}
                  width={Math.abs(bandX('to') - bandX('from'))}
                  y={top}
                  height={plotH}
                />
              )}

              {/* Volume and Tonnes: the stack by material, straight between surveys; a material
                  or a date without a figure breaks the area (a gap, never a zero) */}
              {stack && (
                <g className="ds-stack">
                  {stack.layers.map((layer) => {
                    if (layer.points.length === 0) return null;
                    return (
                      <g key={layer.key || 'none'} data-stack={layer.key || 'none'}>
                        {layer.runs.map((run) => {
                          const topPts = run.map((q): [number, number] => [X(q.t), Y(q.y1)]);
                          const basePts = run
                            .map((q): [number, number] => [X(q.t), Y(q.y0)])
                            .reverse();
                          const d = `M${line(topPts).replaceAll(' ', ' L')} L${line(basePts).replaceAll(' ', ' L')}Z`;
                          return (
                            <path
                              key={run[0]?.capture}
                              className="ds-layer"
                              d={d}
                              fill={layer.colour}
                            />
                          );
                        })}
                      </g>
                    );
                  })}
                  {stack.totalRuns
                    .filter((run) => run.length > 1)
                    .map((run) => (
                      <polyline
                        key={run[0]?.capture}
                        className="ds-total"
                        points={line(run.map((q): [number, number] => [X(q.t), Y(q.value)]))}
                      />
                    ))}
                  {stack.totals.map((q) => (
                    <circle
                      key={q.capture}
                      className="ds-dot"
                      data-point={q.capture}
                      cx={X(q.t)}
                      cy={Y(q.value)}
                      r={q.capture === focusDay?.capture ? 4.5 : 3.5}
                    />
                  ))}
                </g>
              )}

              {/* a selected pile: its line over the site total, faded, each on its own scale */}
              {pileVals && siteVals && (
                <g className="ds-pile-plot" data-testid="strip-pile-line">
                  {runs(siteVals, Ysite).map((r) => (
                    <path key={`s${line(r)}`} className="ds-site-faded" d={area(r, Ysite(0))} />
                  ))}
                  {(() => {
                    const lastSite = runs(siteVals, Ysite).at(-1)?.at(-1);
                    return lastSite ? (
                      <text
                        className="pc-axis-note ds-site-note"
                        x={lastSite[0] - 6}
                        y={Math.max(top + 10, lastSite[1] - 6)}
                        textAnchor="end"
                      >
                        {t('strip.siteTotalOwnScale')}
                      </text>
                    ) : null;
                  })()}
                  {runs(pileVals, Y).map((r) => (
                    <g key={`p${line(r)}`}>
                      <path
                        className="ds-pile-area"
                        d={area(r, Y(0))}
                        fill={`color-mix(in oklab, ${pileColour} 22%, transparent)`}
                      />
                      {r.length > 1 && (
                        <polyline className="ds-pile-line" points={line(r)} stroke={pileColour} />
                      )}
                    </g>
                  ))}
                  {days.map((d, i) => {
                    const v = pileVals[i];
                    return v === null || v === undefined ? null : (
                      <circle
                        key={d.capture}
                        className="ds-pile-dot"
                        data-point={d.capture}
                        cx={X(d.t)}
                        cy={Y(v)}
                        r={4}
                        fill={pileColour}
                      />
                    );
                  })}
                </g>
              )}

              {/* Cut & fill: fill above zero, cut below, between consecutive surveys */}
              {mode === 'cutFill' && (
                <g className="ds-bars">
                  <line className="ds-zero" x1={left} x2={right} y1={mid} y2={mid} />
                  {bars.map((b) => {
                    const x0 = left + b.x0;
                    const bw = Math.max(2, b.x1 - b.x0);
                    const fillTop = Y(b.fillM3);
                    const cutBottom = Y(-b.cutM3);
                    const wide = bw >= 64;
                    return (
                      <g key={`${b.from}>${b.to}`} data-bar={`${b.from}>${b.to}`}>
                        <rect
                          className="ds-fill"
                          x={x0}
                          width={bw}
                          y={fillTop}
                          height={Math.max(0, mid - fillTop)}
                        />
                        <rect
                          className="ds-cut"
                          x={x0}
                          width={bw}
                          y={mid}
                          height={Math.max(0, cutBottom - mid)}
                        />
                        {wide && (
                          <>
                            <text
                              className="ds-bar-label"
                              data-kind="fill"
                              x={x0 + bw / 2}
                              y={Math.max(top + 8, fillTop - 4)}
                              textAnchor="middle"
                            >
                              {t('strip.barFill', { value: bareVol(b.fillM3) })}
                            </text>
                            <text
                              className="ds-bar-label"
                              data-kind="cut"
                              x={x0 + bw / 2}
                              y={Math.min(bottom - 2, cutBottom + 11)}
                              textAnchor="middle"
                            >
                              {t('strip.barCut', { value: bareVol(b.cutM3) })}
                            </text>
                          </>
                        )}
                      </g>
                    );
                  })}
                  {(p.cutFill?.waiting ?? []).map((wt) => {
                    const a = timeOf(wt.from);
                    const b = timeOf(wt.to);
                    const on = dayOf(wt.on);
                    if (a === null || b === null) return null;
                    const xa = X(a);
                    const xb = X(b);
                    const inset = (xb - xa) * 0.2;
                    return (
                      <g key={`w${wt.from}>${wt.to}`} data-waiting={`${wt.from}>${wt.to}`}>
                        <rect
                          className="ds-hatch"
                          fill={`url(#${hatchId})`}
                          x={xa + inset}
                          width={Math.max(2, xb - xa - 2 * inset)}
                          y={top}
                          height={plotH}
                        />
                        {xb - xa - 2 * inset > 120 && on && (
                          <text
                            className="pc-axis-note"
                            x={(xa + xb) / 2}
                            y={mid}
                            textAnchor="middle"
                          >
                            {t('strip.waiting', { date: on.short })}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              )}

              {/* a date still preparing its surface: hatched, with its percentage */}
              {days.map((d) => {
                const s = states.get(d.capture);
                if (s?.kind !== 'preparing') return null;
                const x = X(d.t);
                return (
                  <g key={`prep${d.capture}`} data-preparing={d.capture}>
                    <rect
                      className="ds-hatch"
                      fill={`url(#${hatchId})`}
                      x={x - 5}
                      width={10}
                      y={top}
                      height={plotH}
                    />
                    <text className="pc-axis-note" x={x + 8} y={top + 10}>
                      {t('strip.preparing', { percent: num(s.pct) })}
                    </text>
                  </g>
                );
              })}

              {/* the compare brackets */}
              {band && (
                <g className="ds-brackets">
                  <path
                    d={`M${String(bandX('from') + 6)},${String(top - 4)} L${String(bandX('from'))},${String(top - 4)} L${String(bandX('from'))},${String(bottom + 4)} L${String(bandX('from') + 6)},${String(bottom + 4)}`}
                  />
                  <path
                    d={`M${String(bandX('to') - 6)},${String(top - 4)} L${String(bandX('to'))},${String(top - 4)} L${String(bandX('to'))},${String(bottom + 4)} L${String(bandX('to') - 6)},${String(bottom + 4)}`}
                  />
                </g>
              )}

              {hover !== null && readDay && (
                <g className="pc-crosshair" data-testid="strip-crosshair">
                  <line x1={X(readDay.t)} x2={X(readDay.t)} y1={top} y2={bottom} />
                </g>
              )}

              {atPlayhead((x) => (
                <g className="ds-ph" data-testid="strip-playhead-line">
                  <line x1={x} x2={x} y1={4} y2={bottom + 4} />
                  <rect x={x - 6} y={0} width={12} height={9} rx={2} />
                </g>
              ))}
            </g>

            <line className="ds-axis" x1={left} x2={right} y1={bottom} y2={bottom} />
          </svg>

          {/* the survey markers: a dot on the axis and the date under it; a click jumps there */}
          {days.map((d) => {
            const x = X(d.t);
            if (!inView(x)) return null;
            const on = d.capture === focusDay?.capture;
            const s = stateOf(d.capture);
            return (
              <button
                key={d.capture}
                type="button"
                className="ds-mk"
                data-survey={d.capture}
                data-on={on ? '' : undefined}
                data-state={s}
                data-crowded={labelled.has(d.capture) ? undefined : ''}
                aria-current={on ? 'date' : undefined}
                style={{ left: x, top: bottom - 6 }}
                onClick={() => {
                  if (!on) p.onFocus(d.capture);
                }}
              >
                <span className="ds-mk-dot" style={{ background: d.colour }} aria-hidden="true" />
                <span className="ds-mk-label">{d.label}</span>
              </button>
            );
          })}

          {/* the compare band: its change on top, a bracket at each end to drag */}
          {band && (
            <>
              <div
                className="ds-band-label"
                data-testid="strip-band-label"
                style={{ left: (bandX('from') + bandX('to')) / 2 }}
              >
                {compareLabel}
              </div>
              {(['from', 'to'] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  className="ds-bracket"
                  data-side={side}
                  data-testid={`strip-bracket-${side}`}
                  aria-label={t(side === 'from' ? 'strip.bracketFrom' : 'strip.bracketTo', {
                    date: band[side].label,
                  })}
                  style={{ left: bandX(side), top: top - 4, height: plotH + 8 }}
                  {...bracketHandlers(side)}
                />
              ))}
            </>
          )}

          {/* the playhead: drag it to another survey, or use the arrow keys */}
          {focusDay &&
            atPlayhead((x) => (
              <div
                className="ds-playhead"
                role="slider"
                tabIndex={0}
                aria-label={t('strip.playhead')}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, days.length - 1)}
                aria-valuenow={Math.max(0, focusIndex)}
                aria-valuetext={focusDay.label}
                data-testid="strip-playhead"
                data-dragging={drag !== null ? '' : undefined}
                style={{ left: x, height: bottom + 4 }}
                onPointerDown={onPlayheadDown}
                onPointerMove={onPlayheadMove}
                onPointerUp={onPlayheadUp}
                onPointerCancel={() => {
                  setDrag(null);
                }}
                onKeyDown={onPlayheadKey}
              />
            ))}

          {ro && (
            <div
              className="pc-readout ds-readout"
              data-testid="strip-readout"
              style={
                roFlip
                  ? { insetInlineEnd: w - roX + READOUT_GAP, insetBlockStart: top }
                  : { insetInlineStart: roX + READOUT_GAP, insetBlockStart: top }
              }
            >
              <div className="pc-ro-head">
                {pile ? `${ro.day.label} · ${pile.label}` : ro.day.label}
              </div>
              <p className="ds-ro-figures">
                {ro.volumeM3 === null
                  ? t('mcard.notMeasured')
                  : ro.tonnes !== null
                    ? t('strip.readout.figures', {
                        volume: volText(ro.volumeM3),
                        tonnes: tonText(ro.tonnes),
                      })
                    : volText(ro.volumeM3)}
              </p>
              {ro.delta ? (
                <p className="pc-ro-delta" data-kind={ro.delta.value < 0 ? 'cut' : 'fill'}>
                  {deltaText(ro.delta.value, ro.delta.pct)}
                </p>
              ) : ro.waiting ? (
                <p className="ds-ro-note" data-testid="strip-waiting">
                  {t('strip.waiting', { date: ro.waiting.short })}
                </p>
              ) : null}
              {ro.vs && (
                <p className="ds-ro-note">{t('strip.readout.vs', { date: ro.vs.label })}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the strip wired to the app

const NO_CAPTURES: readonly { id: string; date: string }[] = [];

/** The app player's time, for the playhead alone. */
const PLAYER_TIME: PlayheadSource = {
  get: () => datesPlayer.getState().t,
  subscribe: (cb) => datesPlayer.subscribe(cb),
};

/** The open project's dates strip: its surveys, piles, materials, player and compare pair. */
export function DatesStrip(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const captures = project?.manifest.captures ?? NO_CAPTURES;
  const measurements = useMeasure((s) => s.file.measurements);
  const settings = useMeasure((s) => s.settings);
  const measureFocus = useMeasure((s) => s.focus);
  const draft = useStore(materialsDraft, (s) => s.draft);
  const assignments = useStore(materialsDraft, (s) => s.assignments);
  const focus = useFocusCapture();
  const states = useSurfaceStates();
  const player = useStore(
    datesPlayer,
    useShallow((s) => ({
      playing: s.playing,
      speed: s.speed,
      loop: s.loop,
      // the time itself moves every frame: only the playhead reads it (`playheadSource`)
      passedT: s.frame?.passed ?? null,
    })),
  );
  const compare = useStore(
    compareDates,
    useShallow((s) => ({ on: s.on, from: s.from, to: s.to })),
  );
  const collapsed = useStore(datesCollapsed, (s) =>
    projectId === null ? false : (s.byProject[projectId] ?? false),
  );
  const [mode, setMode] = useState<StripMode>('volume');

  useEffect(() => {
    cutFillPrefs.getState().load(projectId);
  }, [projectId]);

  const stockpiles = useMemo(() => inventoryPiles(measurements), [measurements]);
  const piles = useMemo(() => withAssignments(stockpiles, assignments), [stockpiles, assignments]);
  // the Volumes tab's one counting rule: the strip adds exactly what the inventory counts
  const isCounted = useCounted(stockpiles);
  const materials = draft ?? settings.materials;
  const tags = useMemo(() => dateTags(captures), [captures]);
  const days = useMemo(
    () => stripDays(captures, piles, materials, (id) => tags[id], isCounted),
    [captures, piles, materials, tags, isCounted],
  );
  const times = useMemo(() => days.map((d) => d.t), [days]);
  // the timelapse's floats and the Volumes tab name the surveys in play from these
  useEffect(() => {
    timelapseStore.setState({
      days: days.map((d) => ({
        capture: d.capture,
        t: d.t,
        label: d.label,
        short: d.short,
        colour: d.colour,
        volumeM3: d.volumeM3,
      })),
    });
  }, [days]);
  useEffect(
    () => () => {
      timelapseStore.setState({ days: [] });
    },
    [],
  );
  useTimelapseConnection();

  const pileM = measureFocus === null ? undefined : piles.find((m) => m.id === measureFocus);
  const pile: StripPile | null = useMemo(() => {
    if (!pileM) return null;
    const group = days.flatMap((d) => d.groups).find((g) => g.piles.some((x) => x.id === pileM.id));
    return { id: pileM.id, label: pileM.label, colour: group?.colour ?? NO_MATERIAL_COLOUR };
  }, [pileM, days]);

  const pairs = useMemo(() => consecutivePairs(days), [days]);
  const cutFill = useStripCutFill(mode === 'cutFill' && !collapsed, pairs, piles, pile?.id ?? null);

  // playback: each frame moves the playhead; the date in focus is the last survey passed
  const playing = player.playing;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let shown: string | null = null;
    const frame = (now: number) => {
      const s = datesPlayer.getState();
      s.tick(now - last, times);
      last = now;
      const f = datesPlayer.getState().frame;
      if (f) {
        const d = days.find((x) => x.t === f.passed);
        if (d && d.capture !== shown) {
          shown = d.capture;
          timeline.getState().focusSurvey(d.capture);
        }
      }
      if (datesPlayer.getState().playing) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing, times, days]);
  // the strip gone (another project, Footage chosen): playback stops with it
  useEffect(
    () => () => {
      datesPlayer.getState().pause();
    },
    [],
  );

  if (days.length < 2) return null;
  const focusT = days.find((d) => d.capture === focus)?.t;
  const passed =
    player.passedT === null ? null : (days.find((d) => d.t === player.passedT) ?? null);
  const goTo = (capture: string) => {
    if (datesPlayer.getState().playing) datesPlayer.getState().pause();
    timeline.getState().focusSurvey(capture);
  };
  const timeOf = (capture: string) => days.find((d) => d.capture === capture)?.t ?? null;

  return (
    <DatesStripView
      days={days}
      focus={focus}
      mode={mode}
      onMode={setMode}
      units={settings.units}
      locale={settings.locale ?? localeOf(settings.units.distance)}
      preview={draft !== null || Object.keys(assignments).length > 0}
      states={states}
      pile={pile}
      onClearPile={() => {
        select([], null);
      }}
      compare={compare}
      onCompareToggle={() => {
        compareDates.getState().toggle(
          defaultPair(
            focus,
            days.map((d) => ({ capture: d.capture, t: d.t })),
          ),
        );
      }}
      onCompareSet={(from, to) => {
        compareDates.getState().set(from, to, timeOf);
      }}
      cutFill={cutFill}
      player={{
        playing: player.playing,
        speed: player.speed,
        loop: player.loop,
        passed: passed?.capture ?? null,
      }}
      playhead={PLAYER_TIME}
      onPlay={() => {
        const s = datesPlayer.getState();
        if (focusT !== undefined) s.seek(focusT);
        s.play(times);
      }}
      onPause={() => {
        datesPlayer.getState().pause();
      }}
      onSpeed={(speed) => {
        datesPlayer.getState().setSpeed(speed);
      }}
      onLoop={() => {
        datesPlayer.getState().toggleLoop();
      }}
      onFocus={goTo}
      collapsed={collapsed}
      onCollapse={(c) => {
        if (projectId !== null) datesCollapsed.getState().set(projectId, c);
      }}
    />
  );
}
