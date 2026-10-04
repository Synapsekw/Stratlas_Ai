import type { BaseVolumes, FillCut, VolumeBaseId } from '@aio/schema';
import type { PileEpochGrid, PileGrid } from './kitdata';

export const BASE_IDS: readonly VolumeBaseId[] = ['tin', 'plane', 'avg', 'low'];

export interface PileVolume extends FillCut {
  areaM2: number;
  topM: number;
  /** Top minus the lowest base point. */
  heightM: number;
}

/** Base height of a 10 cm cell (`x`, `y` from the top-left, `i` its index): the kit's `baseAt`. */
export function gridBase(
  o: PileEpochGrid,
  base: VolumeBaseId,
  g: Pick<PileGrid, 'res' | 'zoff'>,
): (x: number, y: number, i: number) => number {
  const need = <T>(v: T | undefined): T => {
    if (v === undefined) throw new Error(`Pile grid has no ${base} base`);
    return v;
  };
  switch (base) {
    case 'low': {
      const v = need(o.low);
      return () => v;
    }
    case 'avg': {
      const v = need(o.avg);
      return () => v;
    }
    case 'plane': {
      const [c0, c1, c2] = need(o.plane);
      return (x, y) => c0 + c1 * (x + 0.5) * g.res + c2 * (y + 0.5) * g.res;
    }
    case 'tin': {
      const t = need(o.tin);
      return (_x, _y, i) => (t[i] ?? 0) / 100 + g.zoff;
    }
  }
}

/** Volume of one pile on one date against one base: the kit viewer's `volume()`. */
export function pileVolume(g: PileGrid, epoch: string, base: VolumeBaseId): PileVolume | null {
  const o = g.ep[epoch];
  if (!o?.m) return null;
  const { m, z } = o;
  const baseAt = gridBase(o, base, g);
  let fill = 0;
  let cut = 0;
  let top = -Infinity;
  let bmin = Infinity;
  let n = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      if (!m[i]) continue;
      const zz = (z[i] ?? 0) / 100 + g.zoff;
      const b = baseAt(x, y, i);
      const d = zz - b;
      if (d > 0) fill += d;
      else cut -= d;
      if (zz > top) top = zz;
      if (b < bmin) bmin = b;
      n++;
    }
  }
  const a = g.res * g.res;
  return {
    fill: fill * a,
    cut: cut * a,
    net: (fill - cut) * a,
    areaM2: n * a,
    topM: top,
    heightM: top - bmin,
  };
}

/** All four bases of one pile and date, or null when the pile is absent on that date. */
export function pileVolumes(g: PileGrid, epoch: string): BaseVolumes | null {
  const one = (b: VolumeBaseId): FillCut | null => {
    const v = pileVolume(g, epoch, b);
    return v && { fill: v.fill, cut: v.cut, net: v.net };
  };
  const tin = one('tin');
  const plane = one('plane');
  const avg = one('avg');
  const low = one('low');
  return tin && plane && avg && low ? { tin, plane, avg, low } : null;
}

/** Surface to surface change inside the pile zone; differences within the deadband are ignored. */
export function pileChange(g: PileGrid, from: string, to: string, deadband: number): FillCut {
  const a = g.ep[from]?.z;
  const b = g.ep[to]?.z;
  if (!a || !b) throw new Error(`Pile grid lacks ${from} or ${to}`);
  let fill = 0;
  let cut = 0;
  for (let i = 0; i < g.zone.length; i++) {
    if (!g.zone[i]) continue;
    const d = ((b[i] ?? 0) - (a[i] ?? 0)) / 100;
    if (d > deadband) fill += d;
    else if (d < -deadband) cut -= d;
  }
  const area = g.res * g.res;
  return { fill: fill * area, cut: cut * area, net: (fill - cut) * area };
}
