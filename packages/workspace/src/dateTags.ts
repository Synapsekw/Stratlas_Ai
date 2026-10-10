import type { Capture } from '@aio/schema';

export const DATE_COLOURS = 8;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** How one survey date is shown everywhere: colour swatch plus text. */
export interface DateTag {
  id: string;
  date: string;
  /** Position in date order, oldest first. */
  order: number;
  colour: string;
  /** The palette number (1 to 8) behind `colour`. */
  colourIndex?: number;
  /** True when a person picked the colour (`Capture.colour`), not the date order. */
  picked?: boolean;
  /** The icon a person gave the date's folder (`Capture.icon`); absent: the colour square. */
  icon?: string;
  short: string;
  long: string;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

/** The palette number date order gives the capture at `order` (oldest is 0). */
export function autoDateColour(order: number): number {
  return (order % DATE_COLOURS) + 1;
}

/** `colour` when it is a number of the date palette, else undefined (a newer or hand-edited file). */
function pickedColour(colour: number | undefined): number | undefined {
  return colour !== undefined && Number.isInteger(colour) && colour >= 1 && colour <= DATE_COLOURS
    ? colour
    : undefined;
}

/**
 * The tag of every survey date. A date's colour is the one a person picked for it
 * (`Capture.colour`), else the one its place in date order gives; every screen that colours a date
 * reads it here, so a picked colour shows the same everywhere.
 */
export function dateTags(
  captures: readonly Pick<Capture, 'id' | 'date' | 'colour' | 'icon'>[],
): Record<string, DateTag> {
  const sorted = [...captures].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const years = new Set(sorted.map((c) => parts(c.date).y));
  const out: Record<string, DateTag> = {};
  sorted.forEach((c, order) => {
    const { y, m, d } = parts(c.date);
    const month = MONTHS[m - 1] ?? '';
    const picked = pickedColour(c.colour);
    const colourIndex = picked ?? autoDateColour(order);
    out[c.id] = {
      id: c.id,
      date: c.date,
      order,
      colour: `var(--date-${String(colourIndex)})`,
      colourIndex,
      ...(picked !== undefined ? { picked: true } : {}),
      ...(c.icon ? { icon: c.icon } : {}),
      short: years.size > 1 ? `${d} ${month} ${String(y).slice(-2)}` : `${d} ${month}`,
      long: `${d} ${month} ${y}`,
    };
  });
  return out;
}
