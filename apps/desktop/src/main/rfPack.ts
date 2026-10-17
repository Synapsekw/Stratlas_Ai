/*
 * The `rf.coverage` job needs the processing tools of pack RF_COVERAGE_MIN_PACK or later.
 * `jobs:start` asks here first, so an older pack gets the update message, not a failed job (as
 * `telecomPack.ts`).
 */
import { RF_COVERAGE_FEATURE, RF_COVERAGE_MIN_PACK } from '@aio/schema';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `rf.coverage` (Settings, Processing tools lists it). */
export const RF_PACK_FEATURE = {
  label: RF_COVERAGE_FEATURE,
  minVersion: RF_COVERAGE_MIN_PACK,
};

/**
 * Why `jobs:start` refuses `rf.coverage` on the installed pack, or null. A development pack
 * (`dev`) and no pack (the job runner says so itself) pass.
 */
export function rfPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'rf.coverage' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, RF_COVERAGE_MIN_PACK) >= 0) return null;
  return `${RF_COVERAGE_FEATURE} needs processing tools ${RF_COVERAGE_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
