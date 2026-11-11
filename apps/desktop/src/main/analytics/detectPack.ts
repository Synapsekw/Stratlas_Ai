/*
 * The `detect.vlm` job runs in the processing tools of pack DETECT_MIN_PACK or later. `jobs:start`
 * asks here first, so an older pack gets the update message, not a failed job (as `rfPack.ts`).
 */
import { DETECT_FRAMES_MIN_PACK } from '@aio/schema';
import { compareVersions } from '../jobs/pack';

export const DETECT_MIN_PACK = '0.28.0';

/** What the processing tools must be for `detect.vlm` (Settings, Processing tools lists it). */
export const DETECT_PACK_FEATURE = { label: 'Detectors', minVersion: DETECT_MIN_PACK };

/** What the processing tools must be for `detect.vlm` on 360 walk frames (`frames`). */
export const DETECT_FRAMES_PACK_FEATURE = {
  label: 'Detectors on 360 walks',
  minVersion: DETECT_FRAMES_MIN_PACK,
};

/** The run reads walk frames (a new run's params, or the saved params of a resumed one). */
const readsFrames = (params: unknown): boolean => {
  if (typeof params !== 'object' || params === null || !('frames' in params)) return false;
  const frames: unknown = params.frames;
  return Array.isArray(frames) && frames.length > 0;
};

/**
 * Why `jobs:start` refuses `detect.vlm` on the installed processing tools, or null: every run
 * needs DETECT_MIN_PACK, a run over walk frames DETECT_FRAMES_MIN_PACK (photos-only runs are as
 * before). A development pack (`dev`) and no pack (the job runner says so itself) pass.
 */
export function detectPackRefusal(
  pipeline: string,
  packVersion: string | null,
  params?: unknown,
): string | null {
  if (pipeline !== 'detect.vlm' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, DETECT_MIN_PACK) < 0)
    return `${DETECT_PACK_FEATURE.label} need processing tools ${DETECT_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
  if (readsFrames(params) && compareVersions(packVersion, DETECT_FRAMES_MIN_PACK) < 0)
    return `${DETECT_FRAMES_PACK_FEATURE.label} need processing tools ${DETECT_FRAMES_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
  return null;
}

/**
 * The first processing tools whose `detect.vlm` takes few-shot example crops on a detector item
 * (`examples`). An older pack refuses the key, so its runs get none and run exactly as before.
 */
export const DETECT_EXAMPLES_MIN_PACK = '0.33.0';

/** Whether a run on these processing tools may carry example crops. A development pack may. */
export function packTakesExamples(packVersion: string | null): boolean {
  if (packVersion === 'dev') return true;
  return packVersion !== null && compareVersions(packVersion, DETECT_EXAMPLES_MIN_PACK) >= 0;
}
