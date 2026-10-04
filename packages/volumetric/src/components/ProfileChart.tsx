import { useEffect, useRef } from 'react';

export interface ProfileSeries {
  z: readonly (number | null)[];
  label: string;
  /** CSS colour or `var(--token)`. */
  color: string;
}

export interface ProfileChartProps {
  s: readonly number[];
  series: readonly ProfileSeries[];
  /** Dashed base line (pile long section). */
  base?: readonly (number | null)[] | null;
  /** Shade between the first two series where they differ beyond this, m. */
  deadband?: number;
  height?: number;
  label: string;
  className?: string;
}

export const CUT_CSS = '#db5429';
export const FILL_CSS = '#3885db';

function resolve(el: Element, c: string): string {
  if (!c.startsWith('var(')) return c;
  return getComputedStyle(el).getPropertyValue(c.slice(4, -1)).trim() || '#888';
}

/** Elevation profile of one or two surveys along a line, cut and fill shaded (the kit's drawProfile). */
export function ProfileChart({
  s,
  series,
  base,
  deadband = 0.1,
  height = 180,
  label,
  className,
}: ProfileChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth || 320;
      const H = cv.clientHeight || height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const muted = resolve(cv, 'var(--fg-3)');
      const line = resolve(cv, 'var(--line)');
      const mono = resolve(cv, 'var(--f-mono)') || 'monospace';
      const all: number[] = [];
      for (const se of series) for (const v of se.z) if (v != null) all.push(v);
      if (base) for (const v of base) if (v != null) all.push(v);
      const total = s.at(-1) ?? 0;
      if (!all.length || total <= 0) {
        g.fillStyle = muted;
        g.font = `12px ${mono}`;
        g.fillText('No elevation data along this line', 10, 20);
        return;
      }
      let lo = Math.min(...all);
      let hi = Math.max(...all);
      const pad = Math.max(0.5, (hi - lo) * 0.08);
      lo = Math.floor(lo - pad);
      hi = Math.ceil(hi + pad);
      const L0 = 36;
      const R0 = 8;
      const T0 = 20;
      const B0 = 20;
      const sx = (v: number) => L0 + (v / total) * (W - L0 - R0);
      const sy = (v: number) => T0 + ((hi - v) / (hi - lo)) * (H - T0 - B0);
      g.strokeStyle = line;
      g.fillStyle = muted;
      g.font = `10.5px ${mono}`;
      g.lineWidth = 1;
      const step = [0.5, 1, 2, 5, 10, 20].find((t) => (hi - lo) / t <= 6) ?? 20;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const y = sy(v);
        g.beginPath();
        g.moveTo(L0, y);
        g.lineTo(W - R0, y);
        g.stroke();
        g.fillText(v.toFixed(step < 1 ? 1 : 0), 4, y + 3);
      }
      const xs = [5, 10, 20, 50, 100, 200].find((t) => total / t <= 6) ?? 200;
      for (let v = 0; v <= total; v += xs)
        g.fillText(`${String(v)} m`, Math.min(sx(v) - 6, W - R0 - 30), H - 5);
      const [a, b] = series;
      if (a && b) {
        for (let k = 0; k < s.length - 1; k++) {
          const a0 = a.z[k];
          const a1 = a.z[k + 1];
          const b0 = b.z[k];
          const b1 = b.z[k + 1];
          const s0 = s[k];
          const s1 = s[k + 1];
          if (
            a0 == null ||
            a1 == null ||
            b0 == null ||
            b1 == null ||
            s0 === undefined ||
            s1 === undefined
          )
            continue;
          const d = b0 - a0;
          if (Math.abs(d) <= deadband) continue;
          g.fillStyle = d < 0 ? CUT_CSS : FILL_CSS;
          g.globalAlpha = 0.4;
          g.beginPath();
          g.moveTo(sx(s0), sy(a0));
          g.lineTo(sx(s1), sy(a1));
          g.lineTo(sx(s1), sy(b1));
          g.lineTo(sx(s0), sy(b0));
          g.fill();
          g.globalAlpha = 1;
        }
      }
      const path = (z: readonly (number | null)[]) => {
        g.beginPath();
        let on = false;
        z.forEach((v, k) => {
          const x = s[k];
          if (v == null || x === undefined) {
            on = false;
            return;
          }
          if (!on) g.moveTo(sx(x), sy(v));
          else g.lineTo(sx(x), sy(v));
          on = true;
        });
        g.stroke();
      };
      if (base) {
        g.setLineDash([5, 4]);
        g.strokeStyle = resolve(cv, 'var(--fg-1)');
        g.lineWidth = 1.5;
        path(base);
        g.setLineDash([]);
      }
      for (const se of series) {
        g.strokeStyle = resolve(cv, se.color);
        g.lineWidth = 2;
        path(se.z);
      }
      let lx = L0 + 4;
      g.font = `600 10px ${mono}`;
      const keys = [...series, ...(base ? [{ label: 'Base', color: 'var(--fg-1)', z: [] }] : [])];
      for (const se of keys) {
        g.fillStyle = resolve(cv, se.color);
        g.fillRect(lx, 6, 10, 3);
        const t = se.label.toUpperCase();
        g.fillText(t, lx + 14, 11);
        lx += g.measureText(t).width + 28;
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => {
      ro.disconnect();
    };
  }, [s, series, base, deadband, height]);
  return (
    <canvas
      ref={ref}
      className={`vol-chart${className ? ` ${className}` : ''}`}
      style={{ height }}
      role="img"
      aria-label={label}
    />
  );
}
