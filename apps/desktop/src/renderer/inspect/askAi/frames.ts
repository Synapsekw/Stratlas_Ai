/**
 * The video frames Ask AI looks at: a 360 walk's frames (local model only) or a clip's frames,
 * one every N seconds, each list capped so one run stays a bounded job.
 */
import { sampleTimes, type DetectItem } from '../../detections/convert';

/** Intervals offered for walk frames, in seconds. */
export const WALK_EVERY = [1, 2, 5, 10] as const;
/**
 * At most this many walk frames per run. A local run costs nothing, so the cap is higher than the
 * cloud's 500: it covers a 33 minute walk at one frame a second, while one run stays a bounded
 * job (a few hundred ms a frame: minutes, not hours) and a bounded list of items over IPC.
 */
export const MAX_WALK_FRAMES = 2000;
/** At most this many frames of a video clip per run (a clip's frames may go to the cloud). */
export const MAX_CLIP_FRAMES = 500;

/** Frames of a walk to check: one every `everyS` seconds, or only the time `at`. */
export function walkItems(
  walk: { id: string; durationS: number },
  pick: { everyS: number } | { at: number },
): DetectItem[] {
  const times =
    'at' in pick
      ? [Math.round(pick.at * 1000) / 1000]
      : sampleTimes(walk.durationS, pick.everyS, MAX_WALK_FRAMES);
  return times.map((t) => ({ kind: 'frame', layer: walk.id, t }));
}

/**
 * The cap a walk (`durationS` long) or a clip (`durationMs`) hits at one frame every `everyS`
 * seconds, so the person can be told the end is not covered; null when every frame fits.
 */
export function frameCap(
  source: { kind: 'walk'; durationS: number } | { kind: 'clip'; durationMs: number },
  everyS: number,
): number | null {
  const [durationS, max] =
    source.kind === 'walk'
      ? [source.durationS, MAX_WALK_FRAMES]
      : [source.durationMs / 1000, MAX_CLIP_FRAMES];
  return sampleTimes(durationS, everyS, max + 1).length > max ? max : null;
}

/** Frames of a video clip (`durationMs` long) to check: one every `everyS` seconds. */
export function clipItems(clipId: string, durationMs: number, everyS: number): DetectItem[] {
  return sampleTimes(durationMs / 1000, everyS, MAX_CLIP_FRAMES).map((t) => ({
    kind: 'frame',
    layer: clipId,
    t,
  }));
}
