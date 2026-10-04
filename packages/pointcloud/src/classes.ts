/** ASPRS point classes (LAS 1.4 R15, table 17) with the colours used by the classification mode. */

export interface ClassInfo {
  code: number;
  name: string;
  colour: string;
}

export const ASPRS_CLASSES: readonly ClassInfo[] = [
  { code: 0, name: 'Never classified', colour: '#9aa3ad' },
  { code: 1, name: 'Unclassified', colour: '#c9ced4' },
  { code: 2, name: 'Ground', colour: '#a87a4a' },
  { code: 3, name: 'Low vegetation', colour: '#9ed36a' },
  { code: 4, name: 'Medium vegetation', colour: '#5fb547' },
  { code: 5, name: 'High vegetation', colour: '#2f7d32' },
  { code: 6, name: 'Building', colour: '#e0574f' },
  { code: 7, name: 'Low noise', colour: '#ff3df2' },
  { code: 8, name: 'Model key point', colour: '#ffd23f' },
  { code: 9, name: 'Water', colour: '#3a8fe8' },
  { code: 10, name: 'Rail', colour: '#8c6bd6' },
  { code: 11, name: 'Road surface', colour: '#5c5f66' },
  { code: 12, name: 'Overlap', colour: '#f2a65a' },
  { code: 13, name: 'Wire guard', colour: '#f5e663' },
  { code: 14, name: 'Wire conductor', colour: '#ffb000' },
  { code: 15, name: 'Transmission tower', colour: '#d9822b' },
  { code: 16, name: 'Wire connector', colour: '#e6c229' },
  { code: 17, name: 'Bridge deck', colour: '#7a8fa6' },
  { code: 18, name: 'High noise', colour: '#ff007f' },
];

/** Colours for user-defined classes 19..31, so every shader slot has one. */
const EXTRA = ['#34d3c0', '#b68ef8', '#ff7a2d', '#8fd14f', '#e94b9a', '#5ab0ff', '#fad34b'];

export function className(code: number): string {
  return ASPRS_CLASSES[code]?.name ?? `Class ${code}`;
}

export function classColour(code: number): string {
  return ASPRS_CLASSES[code]?.colour ?? EXTRA[code % EXTRA.length] ?? '#c9ced4';
}

export interface LegendEntry {
  code: number;
  name: string;
  colour: string;
  points: number;
  /** Fraction of the counted points. */
  share: number;
}

/** The classes present in `counts`, most points first. */
export function legendEntries(counts: Readonly<Record<number, number>>): LegendEntry[] {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return Object.entries(counts)
    .map(([c, n]) => ({ code: Number(c), points: n }))
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points || a.code - b.code)
    .map((e) => ({
      code: e.code,
      name: className(e.code),
      colour: classColour(e.code),
      points: e.points,
      share: total ? e.points / total : 0,
    }));
}
