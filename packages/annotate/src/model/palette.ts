/**
 * Colours for new classes (ANN-7): distinct, legible on the dark and the light theme and on
 * photos. The kit importer's colours come first, so imported and new classes look alike.
 */
export const CLASS_PALETTE: readonly string[] = [
  '#e5484d',
  '#f08a3e',
  '#e8c547',
  '#7cc46b',
  '#34a6d9',
  '#5b9bd5',
  '#b68ef8',
  '#e879b9',
  '#2fb8a6',
  '#c9a26b',
  '#8fd14f',
  '#f2a1a1',
];

/** The first palette colour no class uses yet (any case); once all are used, it cycles. */
export function nextClassColour(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  const free = CLASS_PALETTE.find((c) => !taken.has(c));
  if (free) return free;
  return CLASS_PALETTE[used.length % CLASS_PALETTE.length] ?? '#e5484d';
}
