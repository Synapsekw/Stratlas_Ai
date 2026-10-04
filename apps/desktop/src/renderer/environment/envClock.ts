/** Site civil time for the time-of-day controls (whole-hour offsets, no time zone database). */
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Site civil time pieces of an instant: `YYYY-MM-DD` and minutes into the day. */
export function siteClock(timeMs: number, offsetHours: number): { date: string; minutes: number } {
  const local = timeMs + offsetHours * 3_600_000;
  const d = new Date(Math.floor(local / DAY_MS) * DAY_MS);
  const date = `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { date, minutes: Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000) };
}

/** The instant for a site date (`YYYY-MM-DD`) and minutes into that day. */
export function siteInstant(date: string, minutes: number, offsetHours: number): number | null {
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day)) return null;
  return day - offsetHours * 3_600_000 + minutes * 60_000;
}

export const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
