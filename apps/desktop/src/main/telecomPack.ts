/*
 * The `telecom.antennas` job needs the processing tools of pack 0.14.0 or later. `jobs:start` asks
 * here first, so an older pack gets the update message, not a failed job (as `evidencePack.ts`).
 */
import { TELECOM_ANTENNAS_FEATURE, TELECOM_ANTENNAS_MIN_PACK } from '@aio/schema';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `telecom.antennas` (Settings, Processing tools lists it). */
export const ANTENNA_PACK_FEATURE = {
  label: TELECOM_ANTENNAS_FEATURE,
  minVersion: TELECOM_ANTENNAS_MIN_PACK,
};

/**
 * Why `jobs:start` refuses `telecom.antennas` on the installed pack, or null. A development pack
 * (`dev`) and no pack (the job runner says so itself) pass.
 */
export function antennaPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'telecom.antennas' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, TELECOM_ANTENNAS_MIN_PACK) >= 0) return null;
  return `${TELECOM_ANTENNAS_FEATURE} needs processing tools ${TELECOM_ANTENNAS_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
