/*
 * The `detect.vlm` job runs in the processing tools of pack DETECT_MIN_PACK or later. `jobs:start`
 * asks here first, so an older pack gets the update message, not a failed job (as `rfPack.ts`).
 */
import { compareVersions } from '../jobs/pack';

export const DETECT_MIN_PACK = '0.23.0';

/**
 * Why `jobs:start` refuses `detect.vlm` on the installed processing tools, or null. A development
 * pack (`dev`) and no pack (the job runner says so itself) pass.
 */
export function detectPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'detect.vlm' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, DETECT_MIN_PACK) >= 0) return null;
  return `Detectors need processing tools ${DETECT_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
