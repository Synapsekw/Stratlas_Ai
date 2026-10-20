import { describe, expect, it } from 'vitest';
import {
  hoverAt,
  orderSeries,
  seriesStyle,
  shadeTargets,
  zExtent,
  type ChartSeries,
} from './chart';

const at = <T>(a: readonly T[], i: number): T => {
  const v = a[i];
  if (v === undefined) throw new Error('missing item');
  return v;
};

const mk = (
  key: string,
  kind: ChartSeries['kind'],
  z: (number | null)[],
  date?: string,
): ChartSeries => ({
  key,
  label: key,
  kind,
  ...(date ? { date } : {}),
  chainage: z.map((_, i) => i * 10),
  z,
});

describe('chart model', () => {
  it('current is solid accent, design dashed, base dotted', () => {
    const all = [mk('c', 'current', [1, 2]), mk('d', 'design', [1, 2]), mk('b', 'base', [1, 2])];
    expect(seriesStyle(at(all, 0), all)).toEqual({
      stroke: 'var(--chart-current)',
      dash: '',
      width: 2,
      opacity: 1,
    });
    expect(seriesStyle(at(all, 1), all)).toMatchObject({
      stroke: 'var(--chart-design)',
      dash: '6 4',
      width: 1.5,
    });
    expect(seriesStyle(at(all, 2), all)).toMatchObject({
      stroke: 'var(--chart-base)',
      dash: '1 3',
      width: 1.5,
    });
  });

  it('earlier dates fade from 0.9 to 0.35 and clamp', () => {
    const all = Array.from({ length: 12 }, (_, i) =>
      mk(`e${i}`, 'earlier', [1, 2], `2026-01-${String(i + 1).padStart(2, '0')}`),
    );
    expect(seriesStyle(at(all, 0), all).opacity).toBeCloseTo(0.35);
    expect(seriesStyle(at(all, 11), all).opacity).toBeCloseTo(0.9);
    expect(seriesStyle(at(all, 5), all).stroke).toBe('var(--chart-earlier)');
    for (const s of all) {
      const o = seriesStyle(s, all).opacity;
      expect(o).toBeGreaterThanOrEqual(0.35);
      expect(o).toBeLessThanOrEqual(0.9);
    }
    expect(seriesStyle(at(all, 0), [at(all, 0)]).opacity).toBe(0.9);
  });

  it('styles do not depend on the order surfaces were added', () => {
    const all = [
      mk('a', 'earlier', [1, 2], '2026-01-01'),
      mk('b', 'earlier', [1, 2], '2026-02-01'),
      mk('c', 'earlier', [1, 2], '2026-03-01'),
    ];
    const rev = [...all].reverse();
    for (const s of all) expect(seriesStyle(s, all)).toEqual(seriesStyle(s, rev));
  });

  it('orders base, designs, earlier, then current last', () => {
    const all = [
      mk('c', 'current', [1]),
      mk('e', 'earlier', [1], '2026-01-01'),
      mk('d', 'design', [1]),
      mk('b', 'base', [1]),
    ];
    expect(orderSeries(all).map((s) => s.key)).toEqual(['b', 'd', 'e', 'c']);
  });

  it('shadeTargets lists only visible non-current series', () => {
    const vis = [
      mk('c', 'current', [1, 2]),
      mk('d', 'design', [1, 2]),
      mk('e', 'earlier', [1, 2], '2026-01-01'),
    ];
    expect(shadeTargets(vis)).toEqual([
      { key: 'd', label: 'd' },
      { key: 'e', label: 'e' },
    ]);
  });

  it('hoverAt interpolates and gives delta and grade', () => {
    const cur = mk('c', 'current', [10, 12, 11]);
    const des = mk('d', 'design', [9, 9, 9]);
    const h = hoverAt([cur, des], 5, 'd');
    expect(h.rows).toEqual([
      { key: 'c', label: 'c', z: 11 },
      { key: 'd', label: 'd', z: 9 },
    ]);
    expect(h.deltaM).toBeCloseTo(2);
    expect(h.grade?.percent).toBeCloseTo(20);
    expect(hoverAt([cur, des], 15, 'd').grade?.percent).toBeCloseTo(-10);
    expect(hoverAt([cur, des], 5, null).deltaM).toBeNull();
    expect(at(hoverAt([cur], 99, null).rows, 0).z).toBeNull();
  });

  it('hover skips an all-null series', () => {
    const cur = mk('c', 'current', [10, 12]);
    const dead = mk('d', 'design', [null, null]);
    const h = hoverAt([cur, dead], 5, 'd');
    expect(at(h.rows, 1).z).toBeNull();
    expect(h.deltaM).toBeNull();
    expect(at(h.rows, 0).z).toBe(11);
  });

  it('zExtent is null when nothing has data', () => {
    expect(zExtent([mk('d', 'design', [null, null])])).toBeNull();
    expect(zExtent([])).toBeNull();
    expect(zExtent([mk('c', 'current', [3, null, 7]), mk('d', 'design', [1, 2])])).toEqual([1, 7]);
  });
});
