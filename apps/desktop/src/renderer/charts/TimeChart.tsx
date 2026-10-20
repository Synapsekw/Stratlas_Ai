/**
 * The time chart (volumetric parity W2/W4): a pile's volume per survey date as bars, a point's
 * elevation per date as a line with dots, or the site inventory as bars stacked by pile. The x axis
 * is time, so dates a day apart sit close and dates a month apart sit far; a date without data is a
 * gap, never a zero. Built from the profile chart's parts (axis titles, grid, crosshair, readout and
 * its aria-live copy), and with `width` and `interactive={false}` it renders statically for the report.
 */
import { formatNumber, formatQuantity, localeOf, unitFactor, unitLabel } from '@aio/geo';
import type { SurveyPrecision, SurveyUnits } from '@aio/schema';
import { niceStep, type StackRow, type TimeRow } from '@aio/survey';
import { Tip, useT } from '@aio/ui';
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import './charts.css';
import './timeChart.css';

export type TimeChartData =
  | { kind: 'volume'; rows: readonly TimeRow[] }
  | {
      kind: 'elevation';
      rows: readonly { capture: string; date: string; label: string; z: number | null }[];
    }
  | { kind: 'stack'; rows: readonly StackRow[]; names: ReadonlyMap<string, string> };

/**
 * A level drawn across an elevation chart: a design's height at the point (dashed, as designs
 * are on the profile chart) or the point's own height (dotted, as the base is).
 */
export interface TimeReference {
  key: string;
  label: string;
  /** Metres. */
  z: number;
  kind: 'design' | 'base';
}

export interface TimeChartProps {
  data: TimeChartData;
  /** Levels across the plot (elevation charts only). */
  references?: readonly TimeReference[];
  units: SurveyUnits;
  precision: SurveyPrecision;
  width?: number; // width given → no ResizeObserver (static render for the report)
  height?: number;
  interactive?: boolean; // false: no crosshair, no tips (report)
  testId?: string;
}

const PAD = { left: 60, right: 14, top: 22, bottom: 40 };
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 220;
/** Space kept before the first and after the last date, so the end bars stay inside the plot. */
const EDGE = 22;
const MAX_BAR = 28; // the stacked bars
const MIN_BAR = 4;
const DOT_R = 4;
const DOT_R_LATEST = 6;
/** The pile ramp: shares of --chart-earlier over the background, never closer than the step. */
const STACK_MAX_SHARE = 100;
const STACK_MIN_SHARE = 40;
const STACK_MIN_STEP = 12;
const STACK_SHADES = 6; // beyond this the shades repeat; the legend and hover carry the names
const READOUT_GAP = 12;
const LABEL_W = 64;

/** One column of the chart, whatever the kind. */
interface Col {
  capture: string;
  date: string;
  label: string;
  t: number;
  value: number | null; // SI: m3 for volume and stack, m for elevation
  change: number | null;
  latest: boolean; // TimeRow.latest for volume; else the newest date with a value
  stale: boolean;
  partial: boolean;
  stack?: StackRow;
}

function columns(data: TimeChartData): Col[] {
  let prev: number | null = null;
  const out: Col[] = data.rows.map((r) => {
    const value =
      data.kind === 'volume'
        ? (r as TimeRow).valueM3
        : data.kind === 'elevation'
          ? (r as { z: number | null }).z
          : (r as StackRow).totalM3;
    const change =
      data.kind === 'volume'
        ? (r as TimeRow).changeM3
        : value !== null && prev !== null
          ? value - prev
          : null;
    if (value !== null) prev = value;
    const row = data.kind === 'volume' ? (r as TimeRow) : undefined;
    return {
      capture: r.capture,
      date: r.date,
      label: r.label,
      t: Date.parse(r.date),
      value,
      change,
      latest: row?.latest ?? false,
      stale: row?.stale ?? false,
      partial: row?.status === 'partial',
      ...(data.kind === 'stack' ? { stack: r as StackRow } : {}),
    };
  });
  out.sort((a, b) => a.t - b.t);
  if (data.kind !== 'volume') {
    const last = out.findLast((c) => c.value !== null);
    if (last) last.latest = true;
  }
  return out;
}

/** Ticks every `step` display units across [lo, hi] SI, as SI values. */
function ticks(lo: number, hi: number, factor: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(lo / factor / step - 1e-9); k * step * factor <= hi + 1e-9; k++)
    out.push(k * step * factor);
  return out;
}
const stepDecimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));

export function TimeChart(p: TimeChartProps): ReactElement {
  const t = useT();
  const interactive = p.interactive ?? true;
  const testId = p.testId ?? 'time-chart';
  const uid = useId().replace(/:/g, '');
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

  const { data } = p;
  const cols = useMemo(() => columns(data), [data]);
  const isElev = data.kind === 'elevation';
  const quantity = isElev ? 'distance' : 'volume';
  const unit = isElev ? p.units.distance : p.units.volume;
  const factor = isElev
    ? unitFactor('distance', p.units.distance)
    : unitFactor('volume', p.units.volume);
  const locale = localeOf(p.units.distance);
  const fmt = (v: number) => formatQuantity(v, quantity, p.units, p.precision);

  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, h - PAD.top - PAD.bottom);
  const left = PAD.left;
  const right = w - PAD.right;
  const top = PAD.top;
  const bottom = h - PAD.bottom;

  // x by date
  const t0 = cols[0]?.t ?? 0;
  const t1 = cols.at(-1)?.t ?? 0;
  const span = t1 - t0;
  const inner = Math.max(1, plotW - 2 * EDGE);
  const x = (time: number) => left + (span > 0 ? EDGE + ((time - t0) / span) * inner : plotW / 2);
  const barW = useMemo(() => {
    let min = Infinity;
    for (let i = 1; i < cols.length; i++) {
      const d = (cols[i]?.t ?? 0) - (cols[i - 1]?.t ?? 0);
      if (d > 0 && d < min) min = d;
    }
    const px = Number.isFinite(min) && span > 0 ? (min / span) * inner : MAX_BAR;
    return Math.max(MIN_BAR, Math.min(MAX_BAR, px * 0.6));
  }, [cols, span, inner]);

  // y by value: the stack grows from zero; the lines span their own range
  const refs = useMemo(
    () => (isElev ? (p.references ?? []).filter((r) => Number.isFinite(r.z)) : []),
    [isElev, p.references],
  );
  const [yLo, yHi] = useMemo((): [number, number] => {
    const vals = [
      ...cols.flatMap((c) => (c.value === null ? [] : [c.value])),
      ...refs.map((r) => r.z),
    ];
    if (vals.length === 0) return [0, 1];
    const hi = Math.max(...vals);
    if (data.kind === 'stack') return [0, hi > 0 ? hi * 1.08 : 1];
    const lo = Math.min(...vals);
    const pad = Math.max(0.1, (hi - lo) * 0.12);
    return [lo - pad, hi + pad];
  }, [cols, refs, data.kind]);
  const y = (v: number) => top + plotH - ((v - yLo) / (yHi - yLo || 1)) * plotH;
  const yStep = niceStep((yHi - yLo) / factor, Math.max(2, Math.floor(plotH / 36)));
  const yTicks = ticks(yLo, yHi, factor, yStep);
  const tick = (v: number) => formatNumber(v / factor, stepDecimals(yStep), locale);

  // date labels, left to right, skipping any that would overlap the last one drawn
  const dateLabels = useMemo(() => {
    const keep: Col[] = [];
    let last = -Infinity;
    for (const c of cols) {
      const cx = x(c.t);
      if (cx - last >= LABEL_W) {
        keep.push(c);
        last = cx;
      }
    }
    return keep;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- x is derived from cols, w and span
  }, [cols, w, span]);

  const stackIds = useMemo(() => {
    const ids: string[] = [];
    if (data.kind === 'stack')
      for (const r of data.rows)
        for (const part of r.parts) if (!ids.includes(part.id)) ids.push(part.id);
    return ids;
  }, [data]);
  const nameOf = (id: string) => (data.kind === 'stack' ? data.names.get(id) : undefined) ?? id;
  const partFill = (id: string) => {
    const n = Math.min(stackIds.length, STACK_SHADES);
    const i = stackIds.indexOf(id) % STACK_SHADES;
    const step = Math.max(STACK_MIN_STEP, (STACK_MAX_SHARE - STACK_MIN_SHARE) / Math.max(1, n - 1));
    const share = Math.max(STACK_MIN_SHARE, STACK_MAX_SHARE - i * step);
    return `color-mix(in oklch, var(--chart-earlier) ${String(Math.round(share))}%, var(--bg-1))`;
  };

  // the crosshair: a column under the pointer or chosen by the arrow keys
  const [at, setAt] = useState<number | null>(null);
  const hovering = useRef(false);
  const live = interactive && at !== null ? (cols[at] ?? null) : null;
  const nearest = (clientX: number, svg: SVGSVGElement) => {
    const px = clientX - svg.getBoundingClientRect().left;
    let best = -1;
    let bestD = Infinity;
    cols.forEach((c, i) => {
      const d = Math.abs(x(c.t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best < 0 ? null : best;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (cols.length === 0) return;
    const last = cols.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = at === null ? 0 : Math.min(last, at + 1);
    else if (e.key === 'ArrowLeft') next = at === null ? 0 : Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') {
      setAt(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setAt(next);
  };
  const handlers = interactive
    ? {
        onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
          hovering.current = true;
          setAt(nearest(e.clientX, e.currentTarget));
        },
        onPointerLeave: () => {
          hovering.current = false;
          setAt(null);
        },
      }
    : {};

  const title = t(
    data.kind === 'volume'
      ? 'vol.overTime'
      : data.kind === 'stack'
        ? 'vol.inventory'
        : 'chart.elevation',
  );
  const yTitle = t('chart.axisTitle', {
    label: t(isElev ? 'chart.elevation' : 'chart.volume'),
    unit: unitLabel(unit),
  });

  const signed = (v: number | null) =>
    v === null ? '-' : `${v > 0 && fmt(v) !== fmt(0) ? '+' : ''}${fmt(v)}`;

  const stackMissing = data.kind === 'stack' ? data.rows.filter((r) => r.missing.length > 0) : [];
  const liveRow = live?.stack;
  const readoutId = `${uid}-readout`;
  const cx = live ? x(live.t) : 0;
  const flip = cx > left + plotW / 2;

  const columnsOf = cols.map((c) => ({ c, cx: x(c.t) }));
  const linePts = (() => {
    const runs: string[] = [];
    let cur: string[] = [];
    for (const { c, cx: px } of columnsOf) {
      if (c.value === null) {
        if (cur.length > 1) runs.push(cur.join(' '));
        cur = [];
      } else cur.push(`${String(px)},${String(y(c.value))}`);
    }
    if (cur.length > 1) runs.push(cur.join(' '));
    return runs;
  })();

  return (
    <div
      className="pc tc"
      data-testid={testId}
      data-kind={data.kind}
      data-static={interactive ? undefined : ''}
    >
      <div
        ref={plot}
        className="pc-plot"
        style={{ blockSize: p.height, inlineSize: fixedWidth }}
        data-testid="time-plot"
        tabIndex={interactive ? 0 : undefined}
        role={interactive ? 'group' : undefined}
        aria-label={interactive ? title : undefined}
        aria-describedby={live ? readoutId : undefined}
        onKeyDown={interactive ? onKey : undefined}
        onFocus={
          interactive
            ? () => {
                if (at === null && cols.length > 0) setAt(cols.length - 1);
              }
            : undefined
        }
        onBlur={
          interactive
            ? () => {
                if (!hovering.current) setAt(null);
              }
            : undefined
        }
      >
        <svg
          className="pc-svg"
          width={w}
          height={h}
          role={interactive ? undefined : 'img'}
          aria-label={interactive ? undefined : title}
          aria-hidden={interactive ? true : undefined}
          {...handlers}
        >
          <g className="pc-grid" data-axis="z">
            {yTicks.map((v) => (
              <g key={`y${String(v)}`}>
                <line x1={left} x2={right} y1={y(v)} y2={y(v)} />
                <text x={left - 6} y={y(v)} textAnchor="end" dominantBaseline="middle">
                  {tick(v)}
                </text>
              </g>
            ))}
          </g>
          <g className="pc-grid" data-axis="t">
            {dateLabels.map((c) => (
              <text key={c.capture} x={x(c.t)} y={bottom + 14} textAnchor="middle">
                {c.label}
              </text>
            ))}
          </g>
          <text className="pc-axis-title" x={left - 6} y={top - 9} textAnchor="end">
            {yTitle}
          </text>
          <text className="pc-axis-title" x={left} y={h - 6}>
            {t('chart.date')}
          </text>

          {refs.map((r) => (
            <g key={r.key} className="tc-ref" data-reference={r.key} data-kind={r.kind}>
              <line
                x1={left}
                x2={right}
                y1={y(r.z)}
                y2={y(r.z)}
                fill="none"
                stroke={r.kind === 'design' ? 'var(--chart-design)' : 'var(--chart-base)'}
                strokeWidth={1.5}
                strokeDasharray={r.kind === 'design' ? '6 4' : '1 3'}
              />
              <text className="pc-axis-note" x={right - 4} y={y(r.z) - 4} textAnchor="end">
                {r.label}
              </text>
            </g>
          ))}

          {data.kind !== 'stack' &&
            linePts.map((pts) => (
              <polyline
                key={pts}
                className="tc-line"
                fill="none"
                stroke="var(--chart-earlier)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={pts}
              />
            ))}

          {columnsOf.map(({ c, cx: px }) => {
            const colour = c.latest ? 'var(--chart-current)' : 'var(--chart-earlier)';
            if (c.value === null) {
              const note = t('mcard.noData');
              const mark = (
                <g
                  className="tc-gap"
                  data-gap={c.capture}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={interactive ? `${c.label}: ${note}` : undefined}
                >
                  <desc>{note}</desc>
                  <rect x={px - 8} y={top} width={16} height={plotH} className="tc-hit" />
                  <line x1={px} x2={px} y1={top} y2={bottom} />
                </g>
              );
              return interactive ? (
                <Tip key={c.capture} content={note} placement="top">
                  {mark}
                </Tip>
              ) : (
                <g key={c.capture}>{mark}</g>
              );
            }
            if (c.stack) {
              let acc = 0;
              return (
                <g key={c.capture} data-stack={c.capture}>
                  {c.stack.parts.map((part) => {
                    const y0 = y(acc);
                    acc += part.valueM3;
                    const y1 = y(acc);
                    return (
                      <rect
                        key={part.id}
                        data-part={part.id}
                        className="tc-part"
                        x={px - barW / 2}
                        width={barW}
                        y={y1}
                        height={Math.max(0, y0 - y1)}
                        fill={partFill(part.id)}
                      />
                    );
                  })}
                  <text
                    data-total={c.capture}
                    className={c.latest ? 'tc-total tc-total-latest' : 'tc-total'}
                    x={px}
                    y={y(c.value) - 5}
                    textAnchor="middle"
                  >
                    {fmt(c.value)}
                  </text>
                </g>
              );
            }
            // a line chart dot: hollow when stale, dashed when partly outside the survey
            const flags = [
              ...(c.stale ? [t('mcard.stale')] : []),
              ...(c.partial ? [t('vol.status.partial')] : []),
            ];
            const dot = (
              <circle
                data-dot={c.capture}
                data-cx={px}
                data-value={fmt(c.value)}
                data-latest={c.latest ? '' : undefined}
                cx={px}
                cy={y(c.value)}
                r={c.latest ? DOT_R_LATEST : DOT_R}
                className={flags.length > 0 ? 'tc-dot tc-dot-hollow' : 'tc-dot'}
                fill={flags.length > 0 ? 'var(--bg-1)' : colour}
                stroke={flags.length > 0 ? colour : undefined}
                strokeDasharray={c.partial ? '2 2' : undefined}
              />
            );
            if (flags.length === 0) return <g key={c.capture}>{dot}</g>;
            const note = flags.join('. ');
            const mark = (
              <g
                className="tc-flag"
                data-stale={c.stale ? c.capture : undefined}
                data-partial={c.partial ? c.capture : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={interactive ? `${c.label}: ${note}` : undefined}
              >
                <desc>{note}</desc>
                <circle cx={px} cy={y(c.value)} r={DOT_R_LATEST + 4} className="tc-hit" />
                {dot}
              </g>
            );
            return interactive ? (
              <Tip key={c.capture} content={note} placement="top">
                {mark}
              </Tip>
            ) : (
              <g key={c.capture}>{mark}</g>
            );
          })}

          {live && (
            <g data-testid="time-crosshair" className="pc-crosshair">
              <line x1={cx} x2={cx} y1={top} y2={bottom} />
              {live.value !== null && (
                <circle cx={cx} cy={y(live.value)} r={3.5} fill="var(--fg-0)" />
              )}
            </g>
          )}
        </svg>
        {live && (
          <div
            id={readoutId}
            className="pc-readout"
            data-testid="time-readout"
            style={
              flip
                ? { insetInlineEnd: w - cx + READOUT_GAP, insetBlockStart: top }
                : { insetInlineStart: cx + READOUT_GAP, insetBlockStart: top }
            }
          >
            <div className="pc-ro-head">{live.label}</div>
            <dl className="pc-ro-rows">
              {liveRow
                ? liveRow.parts.map((part) => (
                    <div key={part.id} className="pc-ro-row">
                      <dt>
                        <i className="pc-ro-key" style={{ background: partFill(part.id) }} />
                        {nameOf(part.id)}
                      </dt>
                      <dd>{fmt(part.valueM3)}</dd>
                    </div>
                  ))
                : null}
              <div className={liveRow ? 'pc-ro-row pc-ro-sep' : 'pc-ro-row'}>
                <dt>{t(isElev ? 'chart.elevation' : 'chart.volume')}</dt>
                <dd>{live.value === null ? t('mcard.noData') : fmt(live.value)}</dd>
              </div>
              <div className="pc-ro-row">
                <dt>{t('vol.change')}</dt>
                <dd>{signed(live.change)}</dd>
              </div>
            </dl>
          </div>
        )}
        {interactive && (
          <p className="sr-only" aria-live="polite" data-testid="time-live">
            {live
              ? `${live.label}, ${live.value === null ? t('mcard.noData') : fmt(live.value)}, ${t('vol.change')} ${signed(live.change)}`
              : ''}
          </p>
        )}
      </div>
      {stackIds.length > 0 && (
        <ul className="tc-legend" data-testid="time-legend">
          {stackIds.map((id) => (
            <li key={id}>
              <i aria-hidden="true" style={{ background: partFill(id) }} />
              {nameOf(id)}
            </li>
          ))}
        </ul>
      )}
      {stackMissing.length > 0 && (
        <ul className="tc-missing" data-testid="time-missing">
          {stackMissing.map((r) => (
            <li key={r.capture}>
              {t('vol.missing', { count: r.missing.length, date: r.label })}
              <span className="tc-missing-names"> {r.missing.map(nameOf).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
