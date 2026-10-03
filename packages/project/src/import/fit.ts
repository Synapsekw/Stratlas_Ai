/** 2D similarity `dst = s * R(theta) * src + t` (theta counter-clockwise), least squares. */
export interface Similarity2D {
  thetaDeg: number;
  scale: number;
  tx: number;
  ty: number;
  /** Root mean square residual (same unit as dst). */
  rms: number;
  maxResidual: number;
  n: number;
}

export function fitSimilarity2D(
  pairs: readonly { src: readonly [number, number]; dst: readonly [number, number] }[],
): Similarity2D {
  const n = pairs.length;
  if (n < 2) throw new Error('Need at least two point pairs');
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (const p of pairs) {
    sx += p.src[0];
    sy += p.src[1];
    dx += p.dst[0];
    dy += p.dst[1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  let a = 0;
  let b = 0;
  let ss = 0;
  for (const p of pairs) {
    const x = p.src[0] - sx;
    const y = p.src[1] - sy;
    const u = p.dst[0] - dx;
    const v = p.dst[1] - dy;
    a += x * u + y * v;
    b += x * v - y * u;
    ss += x * x + y * y;
  }
  const theta = Math.atan2(b, a);
  const scale = Math.hypot(a, b) / ss;
  const c = Math.cos(theta) * scale;
  const s = Math.sin(theta) * scale;
  const tx = dx - (c * sx - s * sy);
  const ty = dy - (s * sx + c * sy);
  let sum = 0;
  let max = 0;
  for (const p of pairs) {
    const ex = c * p.src[0] - s * p.src[1] + tx - p.dst[0];
    const ey = s * p.src[0] + c * p.src[1] + ty - p.dst[1];
    const r = Math.hypot(ex, ey);
    sum += r * r;
    max = Math.max(max, r);
  }
  return {
    thetaDeg: (theta * 180) / Math.PI,
    scale,
    tx,
    ty,
    rms: Math.sqrt(sum / n),
    maxResidual: max,
    n,
  };
}

export function applySimilarity2D(f: Similarity2D, p: readonly [number, number]): [number, number] {
  const t = (f.thetaDeg * Math.PI) / 180;
  const c = Math.cos(t) * f.scale;
  const s = Math.sin(t) * f.scale;
  return [c * p[0] - s * p[1] + f.tx, s * p[0] + c * p[1] + f.ty];
}
