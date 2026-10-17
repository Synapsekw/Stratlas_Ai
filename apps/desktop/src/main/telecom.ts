/**
 * The antenna inventory of the telecom detection (`telecom/antennas.json`): read and written here
 * with the same rules as the measurements (`survey.ts`): atomic with a `.bak`, refused for packages,
 * never over a file a newer version saved or one that changed on disk since it was read. The write
 * is journaled (`telecom:writeAntennas` in `journal.ts`). The detection itself is the
 * `telecom.antennas` pipeline job; the pack gate is `telecomPack.ts`.
 */
import { ANTENNAS_FILE, ANTENNA_CROPS_DIR, AntennasFile, type IpcResponse } from '@aio/schema';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk } from './newer';
import type { Handle } from './notYet';
import { parseAs, readArchiveJson, why, type SurveyProjects } from './survey';

export { antennaPackRefusal } from './telecomPack';

const READ_ONLY_ANTENNAS = 'This project is a read-only package. Its antennas cannot be changed.';

export async function readAntennas(
  projects: SurveyProjects,
  projectId: string,
): Promise<IpcResponse<'telecom:readAntennas'>> {
  const root = projects.root(projectId);
  const pkg = root === undefined ? projects.package(projectId) : undefined;
  if (root === undefined && !pkg)
    return { ok: false, error: `Project "${projectId}" is not open.` };
  let raw: unknown;
  try {
    raw =
      root !== undefined
        ? await readJsonSeen(join(root, ...ANTENNAS_FILE.split('/')))
        : pkg && (await readArchiveJson(pkg.archive, ANTENNAS_FILE));
  } catch (e) {
    return { ok: false, error: `Could not read the antennas: ${why(e)}` };
  }
  const readOnly = root === undefined;
  if (raw === undefined) return { ok: true, file: null, readOnly };
  const r = parseAs(raw, AntennasFile, 'aio.antennas', ANTENNAS_FILE);
  return r.ok ? { ok: true, file: r.value, readOnly } : r;
}

export async function writeAntennas(
  projects: SurveyProjects,
  projectId: string,
  input: AntennasFile,
): Promise<IpcResponse<'telecom:writeAntennas'>> {
  if (projects.package(projectId))
    return { ok: false, error: READ_ONLY_ANTENNAS, code: 'read-only' };
  const root = projects.root(projectId);
  if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
  const file = AntennasFile.parse(input);
  const path = join(root, ...ANTENNAS_FILE.split('/'));
  const newer = await newerOnDisk(path, 'aio.antennas', ANTENNAS_FILE);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name: ANTENNAS_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The antennas were not saved: ${why(e)}` };
  }
}

const SAFE_UNIT_ID = /^ant-[a-z0-9-]{1,60}$/;

/** The crop image of a unit, only from `telecom/crops` and only for a safe unit id; else null. */
export async function readAntennaCrop(
  root: string,
  unitId: string,
): Promise<{ path: string; bytes: Buffer } | null> {
  if (!SAFE_UNIT_ID.test(unitId)) return null;
  const path = join(root, ...ANTENNA_CROPS_DIR.split('/'), `${unitId}.jpg`);
  try {
    return { path, bytes: await readFile(path) };
  } catch {
    return null;
  }
}

export function registerTelecomIpc({
  handle,
  projects,
}: {
  handle: Handle;
  projects: SurveyProjects;
}): void {
  handle('telecom:readAntennas', ({ projectId }) => readAntennas(projects, projectId));
  handle('telecom:writeAntennas', ({ projectId, file }) =>
    writeAntennas(projects, projectId, file),
  );
}
