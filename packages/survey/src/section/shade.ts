/**
 * Cut and fill shading between two section lines, and the chart's vertical exaggeration.
 *
 * Between `from` and `to` (the same stations), `dz = to - from`: fill where `dz > 0`, cut where
 * `dz < 0` (the comparison engine's sign). Between two stations both lines are straight, so each
 * interval is a trapezoid, or two triangles split where the lines cross; areas are exact for the
 * polylines. Intervals where either line has no data break the shading.
 */

export interface ShadePiece {
  kind: 'cut' | 'fill';
  /** A closed polygon in (chainage, elevation): along `to`, then back along `from`. */
  points: [number, number][];
  areaM2: number;
}

export interface Shading {
  pieces: ShadePiece[];
  cutM2: number;
  fillM2: number;
}

type Z = number | null | undefined;

const ok = (v: Z): v is number => typeof v === 'number' && Number.isFinite(v);

/** Cut and fill between two profiles sampled at the same chainages. */
export function cutFill(
  chainage: readonly number[],
  from: readonly Z[],
  to: readonly Z[],
): Shading {
  const pieces: ShadePiece[] = [];
  let cutM2 = 0;
  let fillM2 = 0;
  // a piece being built: the `to` points forward, the `from` points (reversed at the end)
  let cur: {
    kind: 'cut' | 'fill';
    top: [number, number][];
    bot: [number, number][];
    a: number;
  } | null = null;
  const close = () => {
    if (cur && cur.top.length >= 2) {
      pieces.push({ kind: cur.kind, points: [...cur.top, ...cur.bot.reverse()], areaM2: cur.a });
    }
    cur = null;
  };
  const add = (
    kind: 'cut' | 'fill',
    c0: number,
    f0: number,
    t0: number,
    c1: number,
    f1: number,
    t1: number,
  ) => {
    const area = (Math.abs(t0 - f0) + Math.abs(t1 - f1)) * 0.5 * (c1 - c0);
    if (kind === 'fill') fillM2 += area;
    else cutM2 += area;
    if (cur?.kind !== kind) {
      close();
      cur = { kind, top: [[c0, t0]], bot: [[c0, f0]], a: 0 };
    }
    cur.top.push([c1, t1]);
    cur.bot.push([c1, f1]);
    cur.a += area;
  };
  for (let i = 0; i + 1 < chainage.length; i++) {
    const c0 = chainage[i] ?? 0;
    const c1 = chainage[i + 1] ?? 0;
    const f0 = from[i];
    const f1 = from[i + 1];
    const t0 = to[i];
    const t1 = to[i + 1];
    if (!ok(f0) || !ok(f1) || !ok(t0) || !ok(t1) || c1 <= c0) {
      close();
      continue;
    }
    const d0 = t0 - f0;
    const d1 = t1 - f1;
    if (d0 === 0 && d1 === 0) {
      close();
      continue;
    }
    if (d0 >= 0 && d1 >= 0) add('fill', c0, f0, t0, c1, f1, t1);
    else if (d0 <= 0 && d1 <= 0) add('cut', c0, f0, t0, c1, f1, t1);
    else {
      // the lines cross inside the interval
      const k = d0 / (d0 - d1);
      const cx = c0 + (c1 - c0) * k;
      const zx = f0 + (f1 - f0) * k;
      add(d0 > 0 ? 'fill' : 'cut', c0, f0, t0, cx, zx, zx);
      add(d1 > 0 ? 'fill' : 'cut', cx, zx, zx, c1, f1, t1);
    }
  }
  close();
  return { pieces, cutM2, fillM2 };
}

// ---------------------------------------------------------------------------------- the chart

export const MIN_EXAGGERATION = 1;
export const MAX_EXAGGERATION = 20;

/** Vertical exaggeration kept within 1:1 to 1:20. */
export function clampExaggeration(x: number): number {
  if (!Number.isFinite(x)) return MIN_EXAGGERATION;
  return Math.min(MAX_EXAGGERATION, Math.max(MIN_EXAGGERATION, x));
}

export interface ChartScale {
  /** Pixels per metre of chainage. */
  sx: number;
  /** Pixels per metre of elevation: `sx` times the exaggeration. */
  sz: number;
  x(chainage: number): number;
  y(z: number): number;
  /** The elevation range shown (bottom, top). */
  zRange: [number, number];
}

/**
 * Chart transform: the chainage fills the width; the elevation axis is `exaggeration` times the
 * horizontal scale, centred on the data. When that would not fit the height, both scales shrink
 * together, so the ratio always holds.
 */
export function chartScale(o: {
  width: number;
  height: number;
  chainage: [number, number];
  z: [number, number];
  exaggeration: number;
  pad?: number;
}): ChartScale {
  const pad = o.pad ?? 0;
  const ex = clampExaggeration(o.exaggeration);
  const w = Math.max(1, o.width - 2 * pad);
  const h = Math.max(1, o.height - 2 * pad);
  const span = Math.max(1e-9, o.chainage[1] - o.chainage[0]);
  const zSpan = Math.max(1e-9, o.z[1] - o.z[0]);
  let sx = w / span;
  if (zSpan * sx * ex > h) sx = h / (zSpan * ex);
  const sz = sx * ex;
  const left = pad + (w - span * sx) / 2;
  const zMid = (o.z[0] + o.z[1]) / 2;
  const mid = pad + h / 2;
  return {
    sx,
    sz,
    x: (c) => left + (c - o.chainage[0]) * sx,
    y: (z) => mid - (z - zMid) * sz,
    zRange: [zMid - h / 2 / sz, zMid + h / 2 / sz],
  };
}

/** A "nice" tick step (1, 2 or 5 times a power of ten) for about `count` ticks over `span`. */
export function niceStep(span: number, count = 6): number {
  if (!(span > 0)) return 1;
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 5, 10]) if (raw <= f * p) return f * p;
  return 10 * p;
}
