import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The dates strip's player: it moves a playhead through the survey dates, each gap between two
 * consecutive surveys taking the same time whatever its length in days. It only reports where the
 * playhead is (the last survey passed, the next one and the fraction of the gap); what the views
 * show between surveys is the timelapse's job, and no figure is ever estimated between them.
 */

/** Each gap between consecutive surveys takes 2 s at 1x. */
export const GAP_MS_AT_1X = 2000;

export type PlayerSpeed = 0.5 | 1 | 2 | 4;
export type BetweenMode = 'crossfade' | 'swipe' | 'hold';

export interface PlayerFrame {
  /** The playhead's time. */
  t: number;
  /** The last survey the playhead passed (or sits on). */
  passed: number;
  /** The next survey, null at the end. */
  next: number | null;
  /** The fraction of the gap from `passed` to `next`, 0 on a survey. */
  f: number;
  /** True when it stopped at the last survey (no loop, or too few surveys). */
  ended: boolean;
}

const DAY_MS = 86_400_000;

/**
 * The stops the playhead plays through, in order: a gap shorter than a day is never played (two
 * surveys at the same time, or on the same day, would spend a whole gap's time on nothing), so a
 * survey with a later one on its day is passed over for it.
 */
export function playStops(dates: readonly number[]): number[] {
  const ds = [...new Set(dates.filter((d) => Number.isFinite(d)))].sort((a, b) => a - b);
  return ds.filter((d, i) => {
    const next = ds[i + 1];
    return next === undefined || Math.floor(next / DAY_MS) !== Math.floor(d / DAY_MS);
  });
}

const sorted = playStops;

/** Position in gaps: 0 on the first survey, n - 1 on the last. */
function positionOf(t: number, ds: readonly number[]): number {
  const n = ds.length;
  const first = ds[0] ?? 0;
  const last = ds[n - 1] ?? 0;
  if (!Number.isFinite(t) || t <= first) return 0;
  if (t >= last) return n - 1;
  for (let i = 0; i < n - 1; i += 1) {
    const a = ds[i] ?? 0;
    const b = ds[i + 1] ?? 0;
    if (t < b) return i + (b > a ? (t - a) / (b - a) : 0);
  }
  return n - 1;
}

function frameAt(pos: number, ds: readonly number[], ended: boolean): PlayerFrame {
  const i = Math.min(Math.floor(pos), ds.length - 1);
  const passed = ds[i] ?? 0;
  const next = ds[i + 1] ?? null;
  const f = next === null ? 0 : pos - i;
  return { t: next === null ? passed : passed + (next - passed) * f, passed, next, f, ended };
}

/**
 * Moves the playhead `dtMs` of wall time at `speed`. Without loop it stops on the last survey
 * (`ended`); with loop it goes back to the first and carries on. Undated (non-finite) dates are
 * ignored; fewer than two surveys end at once on the one there is.
 */
export function advance(
  t: number,
  dates: readonly number[],
  dtMs: number,
  speed: number,
  loop: boolean,
): PlayerFrame {
  const ds = sorted(dates);
  const first = ds[0];
  if (first === undefined) return { t, passed: t, next: null, f: 0, ended: true };
  if (ds.length < 2) return { t: first, passed: first, next: null, f: 0, ended: true };
  const gaps = ds.length - 1;
  const step = Math.max(0, (dtMs * speed) / GAP_MS_AT_1X);
  let pos = positionOf(t, ds) + (Number.isFinite(step) ? step : 0);
  if (pos >= gaps) {
    if (!loop) return frameAt(gaps, ds, true);
    pos %= gaps;
  }
  return frameAt(pos, ds, false);
}

export interface DatesPlayerState {
  playing: boolean;
  speed: PlayerSpeed;
  loop: boolean;
  /** The playhead's time while playing or after a seek; null before the first play. */
  t: number | null;
  between: BetweenMode;
  /** Where the last tick left the playhead; null after a seek or before playing. */
  frame: PlayerFrame | null;
  /** Starts playing; from the first survey when the playhead is unset or on the last one. */
  play(dates?: readonly number[]): void;
  pause(): void;
  setSpeed(speed: PlayerSpeed): void;
  toggleLoop(): void;
  seek(t: number): void;
  setBetween(mode: BetweenMode): void;
  /**
   * Moves a playing playhead by `dtMs`; it pauses itself at the end without loop. With loop it
   * stays on the last survey for a gap's time before it starts again from the first, so every
   * survey comes into focus, the last one too.
   */
  tick(dtMs: number, dates: readonly number[]): void;
}

export function createDatesPlayer(): StoreApi<DatesPlayerState> {
  /** Looping: the time at 1x still to stay on the last survey before going round again. */
  let holdMs = 0;
  return createStore<DatesPlayerState>((set, get) => ({
    playing: false,
    speed: 1,
    loop: false,
    t: null,
    between: 'crossfade',
    frame: null,
    play(dates) {
      const ds = dates ? sorted(dates) : [];
      const first = ds[0];
      const last = ds[ds.length - 1];
      const { t } = get();
      const restart =
        first !== undefined && last !== undefined && (t === null || t >= last || t < first);
      holdMs = 0;
      set(restart ? { playing: true, t: first, frame: null } : { playing: true });
    },
    pause() {
      holdMs = 0;
      set({ playing: false });
    },
    setSpeed(speed) {
      set({ speed });
    },
    toggleLoop() {
      set({ loop: !get().loop });
    },
    seek(t) {
      holdMs = 0;
      set({ t, frame: null });
    },
    setBetween(between) {
      set({ between });
    },
    tick(dtMs, dates) {
      const s = get();
      if (!s.playing) return;
      const start = s.t ?? sorted(dates)[0];
      if (start === undefined) {
        set({ playing: false });
        return;
      }
      const ds = sorted(dates);
      const first = ds[0];
      const last = ds[ds.length - 1];
      if (!s.loop || ds.length < 2 || first === undefined || last === undefined) {
        const frame = advance(start, dates, dtMs, s.speed, s.loop);
        set({ t: frame.t, frame, playing: !frame.ended });
        return;
      }
      const onLast: PlayerFrame = { t: last, passed: last, next: null, f: 0, ended: false };
      if (holdMs > 0) {
        holdMs -= Math.max(0, dtMs * s.speed);
        if (holdMs > 0) {
          set({ t: last, frame: onLast });
          return;
        }
        // round again from the first survey with what is left of this tick
        const rest = -holdMs / Math.max(s.speed, 1e-9);
        holdMs = 0;
        const frame = advance(first, ds, rest, s.speed, true);
        set({ t: frame.t, frame });
        return;
      }
      const frame = advance(start, ds, dtMs, s.speed, false);
      if (frame.ended) {
        // the last survey reached: it stays in focus for a gap before the loop goes round
        holdMs = GAP_MS_AT_1X;
        set({ t: last, frame: onLast });
        return;
      }
      set({ t: frame.t, frame });
    },
  }));
}

/** The app's one dates player. */
export const datesPlayer = createDatesPlayer();
