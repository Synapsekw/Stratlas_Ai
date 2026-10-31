/**
 * Volume rate and forecast across survey dates (study item 5.4), pure. One executor of two: the
 * Python twin `python/src/aio_pipelines/survey/trend.py` repeats it step for step, and both
 * reproduce `packages/schema/src/__fixtures__/survey/trend.json` (`trend.parity.test.ts`,
 * `python/tests/test_survey_trend.py`).
 *
 * - The rate is the least-squares slope, m³ per day, over the last `TREND_WINDOW` dates with a
 *   figure. It needs `TREND_MIN_DATES` dates on at least two days; with fewer the status is
 *   `not-enough-dates`, and two dates still give the plain rate between them, never a forecast.
 * - The forecast is linear from the last figure: the days until it reaches 0 while it falls
 *   (`daysToEmpty`, `emptyOn`) and the figure 30 days on, never below 0.
 * - `lastRateZ` scores the last rate (m³ per day between the last two dates) against the earlier
 *   ones with a robust z (median and MAD); it needs `TREND_MIN_EARLIER` earlier rates and a MAD
 *   above 0. A large score is a real event or a bad surface: worth a check either way.
 */

/** One figure on a survey date. */
export interface TrendPoint {
  capture: string;
  /** ISO date (`YYYY-MM-DD`, a time after it is ignored). */
  date: string;
  valueM3: number;
}

export interface VolumeTrend {
  status: 'ok' | 'not-enough-dates';
  /** Dates with a figure. */
  dates: number;
  /** Dates the rate was fitted over (0 without a fit). */
  window: number;
  lastCapture: string | null;
  lastDate: string | null;
  lastM3: number | null;
  /** The change between the last two dates. */
  lastChangeM3: number | null;
  /** m³ per day: the fitted slope, or the plain rate between two dates. */
  rateM3PerDay: number | null;
  /** How well the line fits, 0 to 1 (1 when every figure is the same). */
  r2: number | null;
  daysToEmpty: number | null;
  emptyOn: string | null;
  in30DaysM3: number | null;
  lastRateZ: number | null;
}

export const TREND_WINDOW = 5;
export const TREND_MIN_DATES = 3;
export const TREND_MIN_EARLIER = 3;
/** MAD to a standard deviation for normal data. */
const MAD_SCALE = 1.4826;
const DAY_MS = 86_400_000;

/** Whole days since 1970 of an ISO date. */
const dayOf = (date: string): number => Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS;

/** The ISO date `days` whole days after `date`. */
const addDays = (date: string, days: number): string =>
  new Date((dayOf(date) + days) * DAY_MS).toISOString().slice(0, 10);

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function volumeTrend(points: readonly TrendPoint[]): VolumeTrend {
  const pts = [...points]
    .filter((x) => Number.isFinite(x.valueM3) && !Number.isNaN(dayOf(x.date)))
    .sort((a, b) =>
      a.date.slice(0, 10) < b.date.slice(0, 10)
        ? -1
        : a.date.slice(0, 10) > b.date.slice(0, 10)
          ? 1
          : a.capture < b.capture
            ? -1
            : a.capture > b.capture
              ? 1
              : 0,
    );
  const n = pts.length;
  const last = pts[n - 1];
  const prev = pts[n - 2];
  const out: VolumeTrend = {
    status: 'not-enough-dates',
    dates: n,
    window: 0,
    lastCapture: last?.capture ?? null,
    lastDate: last ? last.date.slice(0, 10) : null,
    lastM3: last?.valueM3 ?? null,
    lastChangeM3: null,
    rateM3PerDay: null,
    r2: null,
    daysToEmpty: null,
    emptyOn: null,
    in30DaysM3: null,
    lastRateZ: null,
  };
  if (!last || !prev) return out;

  out.lastChangeM3 = last.valueM3 - prev.valueM3;
  const lastDays = dayOf(last.date) - dayOf(prev.date);
  const lastRate = lastDays > 0 ? out.lastChangeM3 / lastDays : null;

  // the robust score of the last rate against the earlier ones (same-day pairs have no rate)
  const rates: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const d = dayOf(b.date) - dayOf(a.date);
    if (d > 0) rates.push((b.valueM3 - a.valueM3) / d);
  }
  if (lastRate !== null && rates.length >= TREND_MIN_EARLIER) {
    const m = median(rates);
    const mad = median(rates.map((r) => Math.abs(r - m)));
    if (mad > 0) out.lastRateZ = (lastRate - m) / (MAD_SCALE * mad);
  }

  // the least-squares line over the last dates
  const win = pts.slice(-TREND_WINDOW);
  const day0 = dayOf(win[0]?.date ?? last.date);
  const xs = win.map((x) => dayOf(x.date) - day0);
  const ys = win.map((x) => x.valueM3);
  const span = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
  if (win.length < TREND_MIN_DATES || span <= 0) {
    out.rateM3PerDay = n === 2 ? lastRate : null;
    return out;
  }
  const k = win.length;
  const xbar = xs.reduce((s, x) => s + x, 0) / k;
  const ybar = ys.reduce((s, y) => s + y, 0) / k;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < k; i++) {
    const dx = (xs[i] ?? 0) - xbar;
    const dy = (ys[i] ?? 0) - ybar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  let ssRes = 0;
  for (let i = 0; i < k; i++) {
    const r = (ys[i] ?? 0) - (intercept + slope * (xs[i] ?? 0));
    ssRes += r * r;
  }
  out.status = 'ok';
  out.window = k;
  out.rateM3PerDay = slope;
  out.r2 = syy > 0 ? Math.max(0, 1 - ssRes / syy) : 1;
  out.in30DaysM3 = Math.max(0, last.valueM3 + 30 * slope);
  if (slope < 0 && last.valueM3 > 0) {
    out.daysToEmpty = last.valueM3 / -slope;
    out.emptyOn = addDays(last.date, Math.ceil(out.daysToEmpty));
  }
  return out;
}
