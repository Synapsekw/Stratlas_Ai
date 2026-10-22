/*
 * The `telecom.antennas` job needs the processing tools of pack 0.14.0 or later. `jobs:start` asks
 * here first, so an older pack gets the update message, not a failed job (as `evidencePack.ts`).
 */
import {
  TELECOM_ANTENNAS_FEATURE,
  TELECOM_ANTENNAS_MIN_PACK,
  TELECOM_FLAG_FEATURE,
  TELECOM_FLAG_MIN_PACK,
  type AntennasFile,
} from '@aio/schema';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `telecom.antennas` (Settings, Processing tools lists it). */
export const ANTENNA_PACK_FEATURE = {
  label: TELECOM_ANTENNAS_FEATURE,
  minVersion: TELECOM_ANTENNAS_MIN_PACK,
};

/** What the processing tools must be for `telecom.flag` (Settings, Processing tools lists it). */
export const ANTENNA_FLAG_PACK_FEATURE = {
  label: TELECOM_FLAG_FEATURE,
  minVersion: TELECOM_FLAG_MIN_PACK,
};

const VALUE_KEYS = [
  'azimuthGridDeg',
  'downtiltDeg',
  'plumbDeg',
  'elevationDeg',
  'diameterM',
  'centreHeightM',
  'widthM',
  'heightM',
  'depthM',
] as const;

/** True when a person flagged a unit or typed a value: an older pack would drop or overwrite it. */
export function hasPersonOwned(file: AntennasFile): boolean {
  return file.units.some(
    (u) => u.origin === 'flagged' || VALUE_KEYS.some((k) => u[k]?.basis === 'user'),
  );
}

/**
 * Why `jobs:start` refuses `telecom.antennas` or `telecom.flag` on the installed pack, or null. A
 * development pack (`dev`) and no pack (the job runner says so itself) pass. A re-detect below
 * 0.23.0 is refused only when the file holds something a person owns (`inventory`).
 */
export function antennaPackRefusal(
  pipeline: string,
  packVersion: string | null,
  inventory?: AntennasFile | null,
): string | null {
  if (packVersion === null || packVersion === 'dev') return null;
  if (pipeline === 'telecom.flag') {
    if (compareVersions(packVersion, TELECOM_FLAG_MIN_PACK) >= 0) return null;
    return flagMessage(packVersion);
  }
  if (pipeline !== 'telecom.antennas') return null;
  if (inventory && hasPersonOwned(inventory)) {
    if (compareVersions(packVersion, TELECOM_FLAG_MIN_PACK) < 0) return flagMessage(packVersion);
  }
  if (compareVersions(packVersion, TELECOM_ANTENNAS_MIN_PACK) >= 0) return null;
  return `${TELECOM_ANTENNAS_FEATURE} needs processing tools ${TELECOM_ANTENNAS_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

const flagMessage = (v: string) =>
  `${TELECOM_FLAG_FEATURE} needs processing tools ${TELECOM_FLAG_MIN_PACK} or later (these are ${v}). Update them in Settings, Processing tools.`;
