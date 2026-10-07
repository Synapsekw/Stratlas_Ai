import { CLOCK_AHEAD_HOLD_MS, CLOCK_AHEAD_NOTICE_MS } from '@aio/schema';

/** A parsed hybrid logical clock reading. */
export interface HlcParts {
  ms: number;
  counter: number;
  device: string;
}

export function formatHlc({ ms, counter, device }: HlcParts): string {
  return `${String(ms).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${device}`;
}

export function parseHlc(hlc: string): HlcParts {
  const m = /^(\d{13})\.(\d{4})\.(d_[a-z2-7]{52})$/.exec(hlc);
  if (!m?.[1] || !m[2] || !m[3]) throw new Error(`Not a clock reading: ${hlc}`);
  return { ms: Number(m[1]), counter: Number(m[2]), device: m[3] };
}

/** Readings compare as strings (fixed widths), the device id breaking ties. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A device's clock: `tick()` for a local event, `receive()` for a remote reading. Never goes back,
 * whatever the wall clock does. T1 adds the persisted last reading and the skew notices.
 */
export function createClock(device: string, now: () => number = Date.now) {
  let last: HlcParts = { ms: 0, counter: 0, device };
  const set = (ms: number, counter: number): string => {
    // the counter has four digits: past 9999 the reading moves on by a millisecond
    last = counter > 9999 ? { ms: ms + 1, counter: 0, device } : { ms, counter, device };
    return formatHlc(last);
  };
  return {
    tick(): string {
      const pt = now();
      return pt > last.ms ? set(pt, 0) : set(last.ms, last.counter + 1);
    },
    receive(remote: string): string {
      const r = parseHlc(remote);
      const ms = Math.max(last.ms, r.ms, now());
      if (ms === last.ms && ms === r.ms) return set(ms, Math.max(last.counter, r.counter) + 1);
      if (ms === last.ms) return set(ms, last.counter + 1);
      if (ms === r.ms) return set(ms, r.counter + 1);
      return set(ms, 0);
    },
  };
}

/** How far ahead of this machine a remote reading is: `ok`, `notice` (5 min) or `hold` (24 h). */
export function clockAhead(remote: string, nowMs: number): 'ok' | 'notice' | 'hold' {
  const ahead = parseHlc(remote).ms - nowMs;
  if (ahead > CLOCK_AHEAD_HOLD_MS) return 'hold';
  if (ahead > CLOCK_AHEAD_NOTICE_MS) return 'notice';
  return 'ok';
}
