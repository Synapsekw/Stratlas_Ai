const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** 1536 -> "1.5 KB", 186 GiB -> "186 GB". Binary units, one decimal below 10. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, bytes);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const digits = u === 0 || v >= 10 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[u] ?? 'B'}`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 280000 -> "280 k", 1.4e6 -> "1.4 M". */
export function formatCompact(n: number): string {
  const steps: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [div, suffix] of steps) {
    if (Math.abs(n) >= div) {
      const v = n / div;
      return `${v >= 10 ? Math.round(v).toString() : String(Math.round(v * 10) / 10)} ${suffix}`;
    }
  }
  return String(Math.round(n));
}

/** Minutes east of UTC written at the end of an ISO datetime ("+03:00", "-0430"), else null. */
function writtenOffset(iso: string): number | null {
  const m = /T[\d:.]+([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, sign, h = '0', min = '0'] = m;
  return (sign === '-' ? -1 : 1) * (Number(h) * 60 + Number(min));
}

/**
 * "2023-02-21" or an ISO datetime -> "21 Feb 2023". The day is the one in the time zone the
 * datetime was recorded in: "2024-04-02T00:00:00+03:00" is 2 Apr (not 1 Apr, its UTC day); a
 * datetime in UTC ("Z") gives its UTC day, one without a zone the day as written (never the
 * day of the computer's own zone). Unparseable input is returned as is.
 */
export function formatDate(iso: string): string {
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(iso)
      ? `${iso}T00:00:00Z`
      : /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(iso)
        ? `${iso}Z`
        : iso,
  );
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + (writtenOffset(iso) ?? 0) * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/** UTC wall clock, "15:11:16". */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** UTC timecode with frames, "15:11:16:14". */
export function formatTimecode(ms: number, fps = 30): string {
  const frame = Math.floor(((((ms % 1000) + 1000) % 1000) / 1000) * fps);
  return `${formatClock(ms)}:${pad(frame)}`;
}

/** 11000 -> "0:11", 3723000 -> "1:02:03". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}
