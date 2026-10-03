import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';

/** Longest step one frame may take, so a throttled or hidden window does not jump ahead. */
const MAX_STEP_MS = 250;

export function advance(
  nowMs: number,
  dtMs: number,
  rate: number,
  clipEndMs: number | undefined,
): { nowMs: number; stop: boolean } {
  const next = nowMs + Math.min(Math.max(dtMs, 0), MAX_STEP_MS) * rate;
  if (clipEndMs !== undefined && next >= clipEndMs) return { nowMs: clipEndMs, stop: true };
  return { nowMs: next, stop: false };
}

/**
 * While the workspace is playing, advance the project clock on every animation frame at the
 * current rate. Video windows follow nowMs. Returns a stop function.
 */
export function startPlaybackLoop(
  ws: StoreApi<Workspace>,
  clipEnd: () => number | undefined,
  raf: (cb: (t: number) => void) => number = requestAnimationFrame,
  caf: (id: number) => void = cancelAnimationFrame,
): () => void {
  let handle: number | null = null;
  let last: number | null = null;

  const frame = (t: number) => {
    handle = null;
    const s = ws.getState();
    if (!s.playing) {
      last = null;
      return;
    }
    if (last !== null) {
      const r = advance(s.nowMs, t - last, s.rate, clipEnd());
      s.setTime(r.nowMs);
      if (r.stop) {
        s.pause();
        last = null;
        return;
      }
    }
    last = t;
    handle = raf(frame);
  };

  const unsub = ws.subscribe((s, prev) => {
    if (s.playing && !prev.playing && handle === null) {
      last = null;
      handle = raf(frame);
    }
  });
  if (ws.getState().playing) handle = raf(frame);

  return () => {
    unsub();
    if (handle !== null) caf(handle);
  };
}
