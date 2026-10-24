/**
 * The one profile chart (volumetric parity W1): every surface over chainage in a fixed style by
 * kind (current solid accent, earlier dates grey, designs dashed, the base dotted), cut and fill
 * shaded between the current survey and the "Shade vs" target, axes in the project units with the
 * A → B direction and the vertical exaggeration, a hover (or arrow-key) crosshair with a readout,
 * and click (or Enter) to pin. With `width` and `interactive={false}` it renders statically for
 * the report. Cross-sections, line measurements, the pile detail and the report all draw this.
 */
import {
  formatNumber,
  formatQuantity,
  localeOf,
  unitFactor,
  unitLabel,
  type NumberLocale,
} from '@aio/geo';
import type { AngleSettings, SurveyPrecision, SurveyUnits } from '@aio/schema';
import {
  chartScale,
  cutFill,
  formatRow,
  hoverAt,
  niceStep,
  orderSeries,
  seriesStyle,
  zExtent,
  type ChartSeries,
  type Pin,
} from '@aio/survey';
import { Icon, useT } from '@aio/ui';
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import './charts.css';

export interface ProfileChartProps {
  series: readonly ChartSeries[]; // the visible ones (chips decide)
  shadeVs: string | null;
  exaggeration: number;
  ends: { a: string; b: string };
  units: SurveyUnits;
  precision: SurveyPrecision;
  /** The site locale numbers group by (as the cards); else the distance unit's. */
  locale?: NumberLocale;
  angles?: AngleSettings;
  pins?: readonly Pin[];
  onPin?(chainage: number): void;
  height?: number;
  width?: number; // width given → no ResizeObserver (static render for the report)
  interactive?: boolean; // false: no crosshair, no click (report)
  testId?: string;
  /** The export and "Add to report" buttons, set at the end of the line under the chart. */
  actions?: ReactNode;
  /** The crosshair's chainage from outside (linked hover); controlled when not `undefined`. */
  hoverAt?: number | null;
  /** The chainage under the pointer or the keyboard, null when it leaves. */
  onHover?(chainageM: number | null): void;
  /** The pinned point from outside; controlled when not `undefined`. */
  pinnedAt?: number | null;
  /** Given: a click pins the point (a click on the pin clears it) instead of calling `onPin`. */
  onPinAt?(chainageM: number | null): void;
  /** A double-click: fly the camera and the map there. */
  onFly?(chainageM: number): void;
  /** Set at the end of the readout (the line cards' "Add pin here"). */
  readoutAction?: ReactNode;
}

/** Room for the elevation labels on the left and the chainage labels and captions below. */
const PAD = { left: 60, right: 14, top: 22, bottom: 40 };
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 220;
/** The plot inside the axes at the default size, for a caller that fits the exaggeration to it. */
export const DEFAULT_PLOT = {
  width: DEFAULT_WIDTH - PAD.left - PAD.right,
  height: DEFAULT_HEIGHT - PAD.top - PAD.bottom,
} as const;
/** Space kept above and below the data, as a share of its range (at least 0.1 m). */
const Z_MARGIN = 0.08;
/** Readout offset from the crosshair. */
const READOUT_GAP = 12;
/** A click this close to the pinned point (px) clears the pin. */
const PIN_HIT_PX = 6;
/** Two dates closer than this (m) draw no dashed gap between their dots. */
const GAP_MIN_M = 0.05;

type Run = [number, number][];

/** The polyline runs of a series, broken where it has no data. */
function runs(s: ChartSeries): Run[] {
  const out: Run[] = [];
  let cur: Run = [];
  const n = Math.min(s.chainage.length, s.z.length);
  for (let i = 0; i < n; i++) {
    const z = s.z[i];
    const c = s.chainage[i] ?? 0;
    if (z == null || !Number.isFinite(z)) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    } else cur.push([c, z]);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** `target` at `current`'s stations (linear between its own), so the two can be shaded. */
function onStations(stations: readonly number[], target: ChartSeries): (number | null)[] {
  const same =
    target.chainage.length === stations.length &&
    stations.every((c, i) => c === target.chainage[i]);
  if (same) return [...target.z];
  return stations.map((c) => hoverAt([target], c, null).rows[0]?.z ?? null);
}

/** Ticks every `step` display units across [lo, hi] SI, as SI values. */
function ticks(lo: number, hi: number, factor: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(lo / factor / step); k * step * factor <= hi + 1e-9; k++)
    out.push(k * step * factor);
  return out;
}

/** Decimals that show a tick step exactly (0 for 1, 2, 5, 10; 1 for 0.5; 2 for 0.25 ...). */
const stepDecimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));

export function ProfileChart(p: ProfileChartProps): ReactElement {
  const t = useT();
  const interactive = p.interactive ?? true;
  const testId = p.testId ?? 'profile-chart';
  const clipId = `${useId().replace(/:/g, '')}-clip`;
  // the plot box is measured unless a width is given; its CSS height is the default height
  const plot = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const fixedWidth = p.width;
  useLayoutEffect(() => {
    if (fixedWidth !== undefined) return;
    const el = plot.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        setMeasured({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [fixedWidth]);
  const w = fixedWidth ?? measured.w;
  const h = p.height ?? measured.h;

  const ordered = useMemo(() => orderSeries(p.series), [p.series]);
  const current = ordered.find((s) => s.kind === 'current');
  const target = p.shadeVs === null ? undefined : ordered.find((s) => s.key === p.shadeVs);

  // the chainage domain over every visible series
  const [c0, c1] = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of p.series)
      for (const c of s.chainage) {
        if (c < lo) lo = c;
        if (c > hi) hi = c;
      }
    return lo > hi ? [0, 1] : [lo, hi > lo ? hi : lo + 1];
  }, [p.series]);
  const zr = useMemo((): [number, number] => {
    const e = zExtent(p.series);
    if (!e) return [0, 1];
    const pad = Math.max(0.1, (e[1] - e[0]) * Z_MARGIN);
    return [e[0] - pad, e[1] + pad];
  }, [p.series]);

  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, h - PAD.top - PAD.bottom);
  const sc = chartScale({
    width: plotW,
    height: plotH,
    chainage: [c0, c1],
    z: zr,
    exaggeration: p.exaggeration,
  });
  const x = (c: number) => PAD.left + sc.x(c);
  const y = (z: number) => PAD.top + sc.y(z);
  const pts = (r: Run) => r.map(([c, z]) => `${String(x(c))},${String(y(z))}`).join(' ');

  const shading = useMemo(() => {
    if (!current || !target) return null;
    // `dz = to - from`, fill where `dz > 0`, with the pair fixed per kind as the engine has it:
    // an earlier survey or a base goes from the target to the current (current higher = fill);
    // a design goes from the current to the design (current higher = cut, as in compliance.ts)
    const targetZ = onStations(current.chainage, target);
    return target.kind === 'design'
      ? cutFill(current.chainage, current.z, targetZ)
      : cutFill(current.chainage, targetZ, current.z);
  }, [current, target]);

  // axes in the project's distance unit
  const unit = p.units.distance;
  const factor = unitFactor('distance', unit);
  const locale = p.locale ?? localeOf(unit);
  const cStep = niceStep((c1 - c0) / factor, Math.max(2, Math.floor(plotW / 90)));
  const cTicks = ticks(c0, c1, factor, cStep);
  const [zLo, zHi] = sc.zRange;
  const zStep = niceStep((zHi - zLo) / factor, Math.max(2, Math.floor(plotH / 36)));
  const zTicks = ticks(zLo, zHi, factor, zStep);
  const tick = (v: number, step: number) => formatNumber(v / factor, stepDecimals(step), locale);
  const u = unitLabel(unit);
  const dist = (v: number) => formatQuantity(v, 'distance', p.units, p.precision, locale);
  const area = (v: number) => formatQuantity(v, 'area', p.units, p.precision, locale);

  // the crosshair: a chainage under the pointer, or a sample index from the keyboard
  const stations = (current ?? ordered.at(-1))?.chainage ?? [];
  // the hover and the pin are the chart's own unless the caller drives them (linked hover)
  const [ownAt, setOwnAt] = useState<number | null>(null);
  const [ownPin, setOwnPin] = useState<number | null>(null);
  const at = p.hoverAt !== undefined ? p.hoverAt : ownAt;
  const pin = interactive ? (p.pinnedAt !== undefined ? p.pinnedAt : ownPin) : null;
  // blur leaves the crosshair alone while the pointer is still over the plot
  const hovering = useRef(false);
  const setAt = (c: number | null) => {
    setOwnAt(c);
    p.onHover?.(c);
  };
  const setPin = (c: number | null) => {
    setOwnPin(c);
    p.onPinAt?.(c);
  };
  /** The point pins, or a click on the pin clears it (the chart's pin; else a section pin). */
  const pinAt = (c: number) => {
    if (p.onPinAt) setPin(pin !== null && Math.abs(sc.sx * (c - pin)) <= PIN_HIT_PX ? null : c);
    else p.onPin?.(c);
  };
  // the readout follows the pointer, and stays on the pin when the pointer has gone
  const shownAt = at ?? pin;
  const live = interactive && shownAt !== null;
  const readout = live ? hoverAt(ordered, shownAt, target ? target.key : null) : null;
  // the newest dated surface against the one before it: Δ cut or fill, and the dashed gap
  const dated = readout
    ? ordered
        .filter((s) => s.date)
        .map((s) => ({
          key: s.key,
          date: s.date ?? '',
          z: readout.rows.find((r) => r.key === s.key)?.z ?? null,
        }))
        .filter((d): d is { key: string; date: string; z: number } => d.z !== null)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    : [];
  const newest = dated.at(-1);
  const before = dated.at(-2);
  const dz = newest && before ? newest.z - before.z : null;

  const chainageAt = (e: ReactMouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const c = c0 + (e.clientX - r.left - x(c0)) / sc.sx;
    return c >= c0 - 1e-9 && c <= c1 + 1e-9 ? Math.min(c1, Math.max(c0, c)) : null;
  };
  const nearest = (c: number) => {
    let best = 0;
    stations.forEach((s, i) => {
      if (Math.abs(s - c) < Math.abs((stations[best] ?? 0) - c)) best = i;
    });
    return best;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (stations.length === 0) return;
    const i = at === null ? 0 : nearest(at);
    const last = stations.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = at === null ? 0 : Math.min(last, i + 1);
    else if (e.key === 'ArrowLeft') next = at === null ? 0 : Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if ((e.key === 'Enter' || e.key === ' ') && at !== null && (p.onPinAt ?? p.onPin)) {
      e.preventDefault();
      pinAt(at);
      return;
    } else if (e.key === 'Escape') {
      // the pin goes first, then the crosshair; the panel or dialog around the chart stays open
      e.stopPropagation();
      if (pin !== null) setPin(null);
      else setAt(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setAt(stations[next] ?? null);
  };

  const strokeOf = new Map(ordered.map((s) => [s.key, seriesStyle(s, ordered)]));
  const direction = t('chart.direction', { a: p.ends.a, b: p.ends.b });
  const exaggeration = t('chart.exaggeration', { n: String(p.exaggeration) });
  const chartLabel = t('chart.label', { a: p.ends.a, b: p.ends.b, n: String(p.exaggeration) });
  const left = PAD.left;
  const right = w - PAD.right;
  const top = PAD.top;
  const bottom = h - PAD.bottom;

  const handlers = interactive
    ? {
        onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
          hovering.current = true;
          setAt(chainageAt(e));
        },
        onPointerLeave: () => {
          hovering.current = false;
          setAt(null);
        },
        onClick: (e: ReactMouseEvent<SVGSVGElement>) => {
          // the second click of a double-click leaves the pin the first one made
          if (e.detail >= 2) return;
          const c = chainageAt(e);
          if (c !== null) pinAt(c);
        },
        onDoubleClick: (e: ReactMouseEvent<SVGSVGElement>) => {
          // click pins, double-click flies: the point stays pinned where the camera goes
          const c = chainageAt(e);
          if (c === null) return;
          if (p.onPinAt) setPin(c);
          p.onFly?.(c);
        },
      }
    : {};

  const readoutId = `${clipId}-readout`;
  const cx = shownAt === null ? 0 : x(shownAt);
  const flip = cx > PAD.left + plotW / 2;
  const px = pin === null ? 0 : x(pin);
  // signed with the Unicode minus, no sign on a value that rounds to zero
  const dzMag = dz === null ? '' : dist(Math.abs(dz));
  const dzText =
    dz === null
      ? null
      : t(dz < 0 ? 'chart.deltaCut' : 'chart.deltaFill', {
          value: `${dzMag === dist(0) ? '' : dz < 0 ? '−' : '+'}${dzMag}`,
        });
  const delta = readout?.deltaM ?? null;
  // signed, with no "+" on a value that rounds to zero
  const diffText =
    delta === null ? '-' : `${delta > 0 && dist(delta) !== dist(0) ? '+' : ''}${dist(delta)}`;

  return (
    <div className="pc" data-testid={testId} data-static={interactive ? undefined : ''}>
      <div
        ref={plot}
        className="pc-plot"
        style={{ blockSize: p.height, inlineSize: fixedWidth }}
        data-testid="chart-plot"
        tabIndex={interactive ? 0 : undefined}
        role={interactive ? 'group' : undefined}
        aria-label={interactive ? chartLabel : undefined}
        aria-describedby={readout ? readoutId : undefined}
        onKeyDown={interactive ? onKey : undefined}
        onFocus={
          interactive
            ? () => {
                if (at === null && stations.length > 0) setAt(stations[0] ?? null);
              }
            : undefined
        }
        onBlur={
          interactive
            ? () => {
                if (!hovering.current && at !== null) setAt(null);
              }
            : undefined
        }
      >
        <svg
          className="pc-svg"
          width={w}
          height={h}
          // interactive, the focusable plot around it carries the name
          role={interactive ? undefined : 'img'}
          aria-label={interactive ? undefined : chartLabel}
          aria-hidden={interactive ? true : undefined}
          {...handlers}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={left} y={top} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          <g className="pc-grid" data-axis="z">
            {zTicks.map((z) => (
              <g key={`z${String(z)}`}>
                <line x1={left} x2={right} y1={y(z)} y2={y(z)} />
                <text x={left - 6} y={y(z)} textAnchor="end" dominantBaseline="middle">
                  {tick(z, zStep)}
                </text>
              </g>
            ))}
          </g>
          <g className="pc-grid" data-axis="c">
            {cTicks.map((c) => (
              <g key={`c${String(c)}`}>
                <line x1={x(c)} x2={x(c)} y1={top} y2={bottom} />
                <text x={x(c)} y={bottom + 14} textAnchor="middle">
                  {tick(c, cStep)}
                </text>
              </g>
            ))}
          </g>
          <text className="pc-axis-title" x={left - 6} y={top - 9} textAnchor="end">
            {t('chart.axisTitle', { label: t('chart.elevation'), unit: u })}
          </text>
          <text className="pc-axis-title" x={left} y={h - 6}>
            {t('chart.axisTitle', { label: t('chart.chainage'), unit: u })}
          </text>
          <text className="pc-axis-note" x={right} y={h - 6} textAnchor="end">
            <tspan className="pc-direction">{direction}</tspan>
            <tspan dx={12}>{exaggeration}</tspan>
          </text>
          <g clipPath={`url(#${clipId})`}>
            {shading?.pieces.map((piece, i) => (
              <polygon
                key={`s${String(i)}`}
                className={piece.kind === 'fill' ? 'pc-fill' : 'pc-cut'}
                points={pts(piece.points)}
              />
            ))}
            {ordered.map((s) => {
              const st = strokeOf.get(s.key) ?? seriesStyle(s, ordered);
              return runs(s).map((r, i) => (
                <polyline
                  key={`${s.key}-${String(i)}`}
                  data-series={s.key}
                  data-kind={s.kind}
                  fill="none"
                  stroke={st.stroke}
                  strokeWidth={st.width}
                  strokeOpacity={st.opacity}
                  strokeDasharray={st.dash || undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={pts(r)}
                />
              ));
            })}
            {(p.pins ?? []).map((pin, i) => (
              <g key={`p${String(i)}`} data-testid="section-chart-pin" className="pc-pin">
                <line x1={x(pin.chainage)} x2={x(pin.chainage)} y1={top} y2={bottom} />
                {pin.values.map((v) =>
                  v.z === null ? null : (
                    <circle
                      key={v.key}
                      cx={x(pin.chainage)}
                      cy={y(v.z)}
                      r={3.5}
                      fill={strokeOf.get(v.key)?.stroke ?? 'var(--fg-1)'}
                    />
                  ),
                )}
              </g>
            ))}
            {pin !== null && (
              <line
                data-testid="chart-pin-mark"
                className="pc-pin-mark"
                x1={px}
                x2={px}
                y1={top}
                y2={bottom}
              />
            )}
            {readout && (
              <g data-testid="chart-crosshair" className="pc-crosshair">
                <line x1={cx} x2={cx} y1={top} y2={bottom} />
                {newest && before && Math.abs(newest.z - before.z) > GAP_MIN_M && (
                  <line
                    data-testid="chart-gap"
                    className="pc-gap"
                    x1={cx}
                    x2={cx}
                    y1={y(newest.z)}
                    y2={y(before.z)}
                  />
                )}
                {readout.rows.map((r) =>
                  r.z === null ? null : (
                    <circle
                      key={r.key}
                      cx={cx}
                      cy={y(r.z)}
                      r={3.5}
                      fill={strokeOf.get(r.key)?.stroke ?? 'var(--fg-1)'}
                    />
                  ),
                )}
              </g>
            )}
          </g>
        </svg>
        {readout && (
          <div
            id={readoutId}
            className="pc-readout"
            data-testid="chart-readout"
            style={
              flip
                ? { insetInlineEnd: w - cx + READOUT_GAP, insetBlockStart: top }
                : { insetInlineStart: cx + READOUT_GAP, insetBlockStart: top }
            }
          >
            <div className="pc-ro-head">
              {t('chart.chainageAt', { value: dist(readout.chainage) })}
            </div>
            <dl className="pc-ro-rows">
              {readout.rows.map((r) => {
                const st = strokeOf.get(r.key);
                return (
                  <div key={r.key} className="pc-ro-row" data-row={r.key}>
                    <dt>
                      <i
                        className="pc-ro-key"
                        style={{ background: st?.stroke, opacity: st?.opacity }}
                      />
                      {r.label}
                    </dt>
                    <dd>{r.z === null ? '-' : dist(r.z)}</dd>
                  </div>
                );
              })}
            </dl>
            {dzText !== null && dz !== null && (
              <p
                className="pc-ro-delta"
                data-testid="chart-delta"
                data-kind={dz < 0 ? 'cut' : 'fill'}
              >
                {dzText}
              </p>
            )}
            <dl className="pc-ro-rows">
              {target && (
                <div className="pc-ro-row pc-ro-sep" data-row="diff">
                  <dt>{t('chart.diff')}</dt>
                  <dd>{diffText}</dd>
                </div>
              )}
              <div className={target ? 'pc-ro-row' : 'pc-ro-row pc-ro-sep'} data-row="grade">
                <dt>{t('chart.grade')}</dt>
                <dd>
                  {formatRow(
                    {
                      key: 'grade',
                      label: t('chart.grade'),
                      value: readout.grade?.ratio ?? null,
                      kind: 'grade',
                    },
                    p.units,
                    p.precision,
                    undefined,
                    p.angles,
                  )}
                </dd>
              </div>
            </dl>
            {p.readoutAction !== undefined && <div className="pc-ro-action">{p.readoutAction}</div>}
          </div>
        )}
        {pin !== null && (
          <div
            className="pc-pin-badge"
            data-testid="chart-pin-badge"
            style={{ insetInlineStart: px, insetBlockStart: 0 }}
          >
            <Icon name="pin" size={12} />
            {t('hover.pinned', { chainage: dist(pin) })}
          </div>
        )}
        {interactive && (
          <p className="sr-only" aria-live="polite" data-testid="chart-live">
            {readout
              ? target
                ? `${dist(readout.chainage)}, ${t('chart.diff')} ${diffText}`
                : dist(readout.chainage)
              : ''}
          </p>
        )}
      </div>
      {(shading !== null || p.actions !== undefined) && (
        <div className="pc-foot">
          {shading && (
            <p className="pc-areas" data-testid="chart-areas">
              <span className="pc-area" data-kind="cut">
                <i aria-hidden="true" />
                {t('chart.cutArea', { v: area(shading.cutM2) })}
              </span>
              <span className="pc-area" data-kind="fill">
                <i aria-hidden="true" />
                {t('chart.fillArea', { v: area(shading.fillM2) })}
              </span>
            </p>
          )}
          {p.actions && <div className="pc-actions">{p.actions}</div>}
        </div>
      )}
    </div>
  );
}
