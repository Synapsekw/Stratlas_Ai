/*
 * The `telecom.antennas` job needs the processing tools of pack 0.14.0 or later. `jobs:start` asks
 * here first, so an older pack gets the update message, not a failed job (as `evidencePack.ts`).
 */
import { readFile } from 'node:fs/promises';
import { resolveInside } from '@aio/project/fs';
import {
  ANTENNAS_FILE,
  AntennasFile,
  TELECOM_ANTENNAS_FEATURE,
  TELECOM_ANTENNAS_MIN_PACK,
  TELECOM_FLAG_FEATURE,
  TELECOM_FLAG_MIN_PACK,
} from '@aio/schema';
import { compareVersions } from './jobs/pack';

/**
 * The inventory as the gate sees it: the file, null when there is none, or `unreadable` when it
 * is there but cannot be read or is not an inventory (it may hold what a person owns).
 */
export type GateInventory = AntennasFile | null | 'unreadable';

/** The project's antenna inventory for the pack gate of `telecom.antennas` and `telecom.flag`. */
export async function readAntennaInventory(
  pipeline: string,
  project: string | undefined,
): Promise<GateInventory> {
  if (!project || (pipeline !== 'telecom.antennas' && pipeline !== 'telecom.flag')) return null;
  try {
    const at = await resolveInside(project, ANTENNAS_FILE);
    if (!at.ok) return at.status === 404 ? null : 'unreadable';
    const r = AntennasFile.safeParse(JSON.parse(await readFile(at.path, 'utf8')));
    return r.success ? r.data : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

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
 * 0.23.0 is refused only when the file holds something a person owns (`inventory`), or when it is
 * there but unreadable (it may).
 */
export function antennaPackRefusal(
  pipeline: string,
  packVersion: string | null,
  inventory?: GateInventory,
): string | null {
  if (packVersion === null || packVersion === 'dev') return null;
  if (pipeline === 'telecom.flag') {
    if (compareVersions(packVersion, TELECOM_FLAG_MIN_PACK) >= 0) return null;
    return flagMessage(packVersion);
  }
  if (pipeline !== 'telecom.antennas') return null;
  if (inventory === 'unreadable' || (inventory && hasPersonOwned(inventory))) {
    if (compareVersions(packVersion, TELECOM_FLAG_MIN_PACK) < 0) return flagMessage(packVersion);
  }
  if (compareVersions(packVersion, TELECOM_ANTENNAS_MIN_PACK) >= 0) return null;
  return `${TELECOM_ANTENNAS_FEATURE} needs processing tools ${TELECOM_ANTENNAS_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

const flagMessage = (v: string) =>
  `${TELECOM_FLAG_FEATURE} needs processing tools ${TELECOM_FLAG_MIN_PACK} or later (these are ${v}). Update them in Settings, Processing tools.`;
