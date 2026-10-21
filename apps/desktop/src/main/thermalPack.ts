/*
 * The `thermal.decode` job needs the processing tools of pack 0.21.0 or later. `jobs:start` asks
 * here first, so an older pack gets the update message, not a failed job (as `telecomPack.ts`).
 */
import { THERMAL_MIN_PACK } from '@aio/schema';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `thermal.decode` (Settings, Processing tools lists it). */
export const THERMAL_PACK_FEATURE = {
  label: 'Thermal analysis',
  minVersion: THERMAL_MIN_PACK,
};

/**
 * Why `jobs:start` refuses `thermal.decode` on the installed pack, or null. A development pack
 * (`dev`) and no pack (the job runner says so itself) pass.
 */
export function thermalPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'thermal.decode' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, THERMAL_MIN_PACK) >= 0) return null;
  return `${THERMAL_PACK_FEATURE.label} needs processing tools ${THERMAL_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
