const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Whole units with thousands separators; a middle dot when there is no value. */
export const f0 = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? '·' : nf0.format(Math.round(v));

export const f1 = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? '·' : nf1.format(v);

/** Signed whole units, with a true minus sign. */
export const sgn = (v: number): string => {
  const r = Math.round(v);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${nf0.format(Math.abs(r))}`;
};
