/**
 * A small fixed-window rate limiter (no extra dependency): per client address for enrolment and
 * unsigned calls, per device for signed ones. One server process; the counts are in memory.
 */
export interface RateLimit {
  /** Count one request; false when the key is over its limit in this window. */
  take(key: string, nowMs: number): boolean;
}

export function rateLimit(limit: number, windowMs: number): RateLimit {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key, nowMs) {
      if (windows.size > 50_000) {
        for (const [k, w] of windows) if (nowMs - w.start >= windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || nowMs - w.start >= windowMs) {
        windows.set(key, { start: nowMs, count: 1 });
        return true;
      }
      w.count += 1;
      return w.count <= limit;
    },
  };
}

export interface RateLimits {
  /** Enrolment attempts per client address (guessing invite codes). */
  enrol: RateLimit;
  /** Signed requests per device. */
  device: RateLimit;
  /** Anything per client address. */
  address: RateLimit;
}

export function defaultRateLimits(): RateLimits {
  return {
    enrol: rateLimit(20, 10 * 60_000),
    device: rateLimit(1200, 60_000),
    address: rateLimit(3000, 60_000),
  };
}
