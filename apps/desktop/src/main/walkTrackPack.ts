/*
 * The `walk.track` job needs the processing tools of pack WALK_TRACK_MIN_PACK or later. `jobs:start`
 * asks here first, so an older pack gets the update message, not a failed job (as `thermalPack.ts`).
 * The renderer starts it quietly after a local model run over walk frames and keeps the drafts as
 * they are when it is refused.
 */
import { WALK_TRACK_FEATURE, WALK_TRACK_MIN_PACK } from '@aio/schema';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `walk.track` (Settings, Processing tools lists it). */
export const WALK_TRACK_PACK_FEATURE = {
  label: WALK_TRACK_FEATURE,
  minVersion: WALK_TRACK_MIN_PACK,
};

/**
 * Why `jobs:start` refuses `walk.track` on the installed pack, or null. A development pack (`dev`)
 * and no pack (the job runner says so itself) pass.
 */
export function walkTrackPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'walk.track' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, WALK_TRACK_MIN_PACK) >= 0) return null;
  return `${WALK_TRACK_FEATURE} needs processing tools ${WALK_TRACK_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
