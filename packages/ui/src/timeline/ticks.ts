const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/** [major, minor] pairs, finest first. */
const STEPS: [number, number][] = [
  [100, 20],
  [500, 100],
  [S, 200],
  [2 * S, 500],
  [5 * S, S],
  [10 * S, 2 * S],
  [30 * S, 5 * S],
  [M, 10 * S],
  [2 * M, 30 * S],
  [5 * M, M],
  [10 * M, 2 * M],
  [15 * M, 5 * M],
  [30 * M, 5 * M],
  [H, 10 * M],
  [2 * H, 30 * M],
  [6 * H, H],
  [12 * H, 2 * H],
  [D, 6 * H],
  [7 * D, D],
  [30 * D, 7 * D],
];

export interface TickStep {
  major: number;
  minor: number;
}

export interface Tick {
  t: number;
  major: boolean;
}

/** Smallest step whose major ticks are at least `minLabelPx` apart. */
export function pickTickStep(spanMs: number, widthPx: number, minLabelPx = 110): TickStep {
  const pxPerMs = widthPx / Math.max(spanMs, 1);
  for (const [major, minor] of STEPS) {
    if (major * pxPerMs >= minLabelPx) return { major, minor };
  }
  const last = STEPS[STEPS.length - 1] ?? [D, H];
  return { major: last[0], minor: last[1] };
}

const MAX_TICKS = 2000;

export function generateTicks(t0: number, t1: number, step: TickStep): Tick[] {
  const out: Tick[] = [];
  if (!(step.minor > 0) || t1 < t0) return out;
  for (let t = Math.ceil(t0 / step.minor) * step.minor; t <= t1; t += step.minor) {
    out.push({ t, major: t % step.major === 0 });
    if (out.length >= MAX_TICKS) break;
  }
  return out;
}
