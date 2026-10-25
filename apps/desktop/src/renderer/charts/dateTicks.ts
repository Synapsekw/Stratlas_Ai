import { formatDate } from '@aio/ui';

/**
 * The short form of a set of survey dates, for a chart's date axis and a narrow table's date
 * column: "13 Apr" when every date falls in one year (the year is said nowhere else it would
 * help), "13 Apr 2026" otherwise. A date's own label ("Survey 13 April 2026") is too long for
 * either.
 */
export function shortDates(dates: readonly string[]): (iso: string) => string {
  const years = new Set(dates.map((d) => d.slice(0, 4)));
  const year = years.size > 1;
  return (iso) => formatDate(iso, { year });
}

/**
 * Which of the labels at `xs` (left to right) are drawn: all of them when each is at least `gap`
 * from the one before; else every other, then every third and so on, the first and the last
 * always kept (the one before the last gives way to it). Only when even the first and the last
 * collide is the last shown alone.
 */
export function thinLabels(xs: readonly number[], gap: number): number[] {
  const n = xs.length;
  if (n <= 1) return n === 1 ? [0] : [];
  const fits = (idx: readonly number[]) =>
    idx.every((v, k) => k === 0 || (xs[v] ?? 0) - (xs[idx[k - 1] ?? 0] ?? 0) >= gap);
  for (let step = 1; step < n; step++) {
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i += step) idx.push(i);
    // the last always: the label before it gives way when the two would touch
    const before = idx.at(-1) ?? 0;
    if (before !== 0 && (xs[n - 1] ?? 0) - (xs[before] ?? 0) < gap) idx.pop();
    idx.push(n - 1);
    if (fits(idx)) return idx;
  }
  return [n - 1];
}
