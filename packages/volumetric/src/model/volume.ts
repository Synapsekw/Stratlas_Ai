import type { VolumeBaseId } from '@aio/schema';
import type { PileEpochGrid, PileGrid } from './kitdata';

/**
 * Base height of a 10 cm cell (`x`, `y` from the top-left, `i` its index) under a kit pile's 3D
 * body: the kit's `baseAt`. Display only: it shapes the lifted body and its base plate, and never
 * a figure. Every volume a person reads comes from the survey engine (volumetric parity W3).
 */
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
