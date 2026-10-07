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
  short: string;
  long: string;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

export function dateTags(
  captures: readonly Pick<Capture, 'id' | 'date'>[],
): Record<string, DateTag> {
  const sorted = [...captures].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const years = new Set(sorted.map((c) => parts(c.date).y));
  const out: Record<string, DateTag> = {};
  sorted.forEach((c, order) => {
    const { y, m, d } = parts(c.date);
    const month = MONTHS[m - 1] ?? '';
    out[c.id] = {
      id: c.id,
      date: c.date,
      order,
      colour: `var(--date-${(order % DATE_COLOURS) + 1})`,
      short: years.size > 1 ? `${d} ${month} ${String(y).slice(-2)}` : `${d} ${month}`,
      long: `${d} ${month} ${y}`,
    };
  });
  return out;
}
