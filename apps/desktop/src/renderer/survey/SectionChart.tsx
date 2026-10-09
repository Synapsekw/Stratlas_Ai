/**
 * The cross-section chart (M11 G5): one coloured line per surface over chainage, cut and fill
 * shading between two chosen lines, pins, axes; the elevation axis drawn at the chosen vertical
 * exaggeration (1:1 to 1:20) of the chainage axis. A click adds a pin at that chainage.
 */
import { formatQuantity } from '@aio/geo';
import type { SurveySettings } from '@aio/schema';
import { chartScale, cutFill, niceStep, type Pin } from '@aio/survey';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SectionResult } from './sectionEngine';

const PAD = { left: 64, right: 16, top: 12, bottom: 28 };

export interface ChartLine {
  key: string;
  label: string;
  colour: string;
  z: (number | null)[];
}

function runs(ch: number[], z: (number | null)[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  z.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    } else cur.push([ch[i] ?? 0, v]);
  });
  if (cur.length > 1) out.push(cur);
  return out;
}

export function SectionChart({
  result,
  lines,
  pins,
  exaggeration,
  shade,
  settings,
  onPin,
  testId = 'section-chart',
}: {
  result: SectionResult;
  lines: ChartLine[];
  pins: Pin[];
  exaggeration: number;
  shade: { from: string; to: string } | null;
  settings: Pick<SurveySettings, 'units' | 'precision'>;
  onPin: (chainage: number) => void;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const ch = result.chainage;
  const zr = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of lines)
      for (const v of l.z)
        if (v !== null) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
    if (lo === Infinity) return [0, 1] as [number, number];
    const pad = Math.max(0.1, (hi - lo) * 0.08);
    return [lo - pad, hi + pad] as [number, number];
  }, [lines]);
  const c0 = ch[0] ?? 0;
  const c1 = ch[ch.length - 1] ?? 1;
  const sc = chartScale({
    width: size.w - PAD.left - PAD.right,
    height: size.h - PAD.top - PAD.bottom,
    chainage: [c0, c1],
    z: zr,
    exaggeration,
  });
  const x = (c: number) => PAD.left + sc.x(c);
  const y = (z: number) => PAD.top + sc.y(z);
  const d = (v: number) => formatQuantity(v, 'distance', settings.units, settings.precision);

  const shading = useMemo(() => {
    if (!shade) return null;
    const from = lines.find((l) => l.key === shade.from);
    const to = lines.find((l) => l.key === shade.to);
    return from && to ? cutFill(ch, from.z, to.z) : null;
  }, [shade, lines, ch]);

  const cStep = niceStep(c1 - c0, Math.max(2, Math.floor(size.w / 110)));
  const cTicks: number[] = [];
  for (let k = Math.ceil(c0 / cStep); k * cStep <= c1 + 1e-9; k++) cTicks.push(k * cStep);
  const [zLo, zHi] = sc.zRange;
  const zStep = niceStep(zHi - zLo, Math.max(2, Math.floor(size.h / 45)));
  const zTicks: number[] = [];
  for (let k = Math.ceil(zLo / zStep); k * zStep <= zHi + 1e-9; k++) zTicks.push(k * zStep);

  return (
    <div ref={box} className="sec-chart" data-testid={testId}>
      <svg
        width={size.w}
        height={size.h}
        role="img"
        aria-label={`Cross-section, ${d(c1 - c0)} long, vertical exaggeration 1:${String(exaggeration)}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const c = c0 + (e.clientX - r.left - PAD.left - sc.x(c0)) / sc.sx;
          if (c >= c0 - 1e-9 && c <= c1 + 1e-9) onPin(Math.min(c1, Math.max(c0, c)));
        }}
      >
        <defs>
          <clipPath id={`${testId}-clip`}>
            <rect
              x={PAD.left}
              y={PAD.top}
              width={Math.max(0, size.w - PAD.left - PAD.right)}
              height={Math.max(0, size.h - PAD.top - PAD.bottom)}
            />
          </clipPath>
        </defs>
        {zTicks.map((z) => (
          <g key={`z${String(z)}`} className="sec-grid">
            <line x1={PAD.left} x2={size.w - PAD.right} y1={y(z)} y2={y(z)} />
            <text x={PAD.left - 6} y={y(z) + 4} textAnchor="end">
              {Number(z.toFixed(3)).toString()}
            </text>
          </g>
        ))}
        {cTicks.map((c) => (
          <g key={`c${String(c)}`} className="sec-grid">
            <line x1={x(c)} x2={x(c)} y1={PAD.top} y2={size.h - PAD.bottom} />
            <text x={x(c)} y={size.h - PAD.bottom + 16} textAnchor="middle">
              {Number(c.toFixed(3)).toString()}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${testId}-clip)`}>
          {shading?.pieces.map((p, i) => (
            <polygon
              key={`s${String(i)}`}
              className={p.kind === 'fill' ? 'sec-fill' : 'sec-cut'}
              points={p.points.map(([c, z]) => `${String(x(c))},${String(y(z))}`).join(' ')}
            />
          ))}
          {lines.map((l) =>
            runs(ch, l.z).map((run, i) => (
              <polyline
                key={`${l.key}-${String(i)}`}
                data-surface={l.key}
                fill="none"
                stroke={l.colour}
                strokeWidth={2}
                points={run.map(([c, z]) => `${String(x(c))},${String(y(z))}`).join(' ')}
              />
            )),
          )}
          {pins.map((p, i) => (
            <g key={`p${String(i)}`} data-testid="section-chart-pin">
              <line
                className="sec-pin"
                x1={x(p.chainage)}
                x2={x(p.chainage)}
                y1={PAD.top}
                y2={size.h - PAD.bottom}
              />
              {p.values.map((v, k) =>
                v.z === null ? null : (
                  <circle
                    key={v.key}
                    cx={x(p.chainage)}
                    cy={y(v.z)}
                    r={3.5}
                    fill={lines[k]?.colour ?? '#fff'}
                  />
                ),
              )}
            </g>
          ))}
        </g>
      </svg>
      {shading && (
        <p className="sec-shade-note small">
          Cut {formatQuantity(shading.cutM2, 'area', settings.units, settings.precision)} · Fill{' '}
          {formatQuantity(shading.fillM2, 'area', settings.units, settings.precision)} in section
        </p>
      )}
    </div>
  );
}
