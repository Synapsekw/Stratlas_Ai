import type { VolumeBaseId } from '@aio/schema';
import type { PileGrid } from './kitdata';
import { gridBase } from './volume';

export interface PileSection {
  /** Distance along the axis, m. */
  s: number[];
  z1: (number | null)[];
  z2: (number | null)[];
  /** The base on `epoch` where the pile is, else null. */
  base: (number | null)[];
}

/**
 * Long section along the pile's main axis (principal axis of its mask), 15 cells beyond each
 * end, every 2 cells: the kit viewer's `pileSection`.
 */
export function pileLongSection(
  p: PileGrid,
  epoch: string,
  base: VolumeBaseId,
  first: string,
  last: string,
): PileSection {
  const o = p.ep[epoch]?.m ? p.ep[epoch] : p.ep[last]?.m ? p.ep[last] : p.ep[first];
  const m = o?.m;
  const out: PileSection = { s: [], z1: [], z2: [], base: [] };
  if (!m) return out;
  const W = p.w;
  const H = p.h;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < H; y += 2)
    for (let x = 0; x < W; x += 2)
      if (m[y * W + x]) {
        sx += x;
        sy += y;
        n++;
      }
  if (n === 0) return out;
  const mx = sx / n;
  const my = sy / n;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let y = 0; y < H; y += 2)
    for (let x = 0; x < W; x += 2)
      if (m[y * W + x]) {
        const dx = x - mx;
        const dy = y - my;
        cxx += dx * dx;
        cyy += dy * dy;
        cxy += dx * dy;
      }
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  let t0 = Infinity;
  let t1 = -Infinity;
  for (let y = 0; y < H; y += 3)
    for (let x = 0; x < W; x += 3)
      if (m[y * W + x]) {
        const t = (x - mx) * ux + (y - my) * uy;
        t0 = Math.min(t0, t);
        t1 = Math.max(t1, t);
      }
  t0 -= 15;
  t1 += 15;
  const ob = p.ep[epoch];
  const baseAt = ob?.m ? gridBase(ob, base, p) : null;
  const za = p.ep[first]?.z;
  const zb = p.ep[last]?.z;
  for (let t = t0; t <= t1; t += 2) {
    const x = Math.round(mx + ux * t);
    const y = Math.round(my + uy * t);
    out.s.push((t - t0) * p.res);
    if (x < 0 || y < 0 || x >= W || y >= H) {
      out.z1.push(null);
      out.z2.push(null);
      out.base.push(null);
      continue;
    }
    const k = y * W + x;
    out.z1.push(za ? (za[k] ?? 0) / 100 + p.zoff : null);
    out.z2.push(zb ? (zb[k] ?? 0) / 100 + p.zoff : null);
    out.base.push(baseAt && ob?.m?.[k] ? baseAt(x, y, k) : null);
  }
  return out;
}
