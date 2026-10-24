/**
 * The antenna inventory of the telecom detection (`telecom/antennas.json`): read and written here
 * with the same rules as the measurements (`survey.ts`): atomic with a `.bak`, refused for packages,
 * never over a file a newer version saved or one that changed on disk since it was read. The write
 * is journaled (`telecom:writeAntennas` in `journal.ts`). The detection itself is the
 * `telecom.antennas` pipeline job; the pack gate is `telecomPack.ts`.
 */
import {
  ANTENNAS_FILE,
  ANTENNA_CROPS_DIR,
  ANTENNA_DELETIONS_FILE,
  ANTENNA_DELETIONS_SCHEMA,
  AntennaDeletionsFile,
  AntennasFile,
  type AntennaDeletion,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isChangedOnDisk, readBytesSeen, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, parseJsonText } from './newer';
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

/**
 * Delete units so they stay deleted. Detected units leave a record in the sidecar (a re-run reads
 * it and drops the same find again), flagged units leave none (nothing re-finds a person's flag).
 * The sidecar is written first: if the inventory write then fails, the unit is still in the file
 * and the merge pairs it first. The inventory is refused when it changed since the renderer read it
 * (`readAntennas` remembers the version); the sidecar, which the renderer never reads, when it
 * changed since this call read it. Crops go last, best effort.
 */
export async function deleteAntennas(
  projects: SurveyProjects,
  projectId: string,
  ids: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<IpcResponse<'telecom:deleteAntennas'>> {
  if (projects.package(projectId))
    return { ok: false, error: READ_ONLY_ANTENNAS, code: 'read-only' };
  const root = projects.root(projectId);
  if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
  const path = join(root, ...ANTENNAS_FILE.split('/'));
  const sidecarPath = join(root, ...ANTENNA_DELETIONS_FILE.split('/'));
  const newer =
    (await newerOnDisk(path, 'aio.antennas', ANTENNAS_FILE)) ??
    (await newerOnDisk(sidecarPath, 'aio.antenna-deletions', ANTENNA_DELETIONS_FILE));
  if (newer) return { ok: false, error: newer };

  // the inventory is read plainly: the version the renderer saw stays the one the write checks
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: false, error: 'There are no antennas to delete.' };
    return { ok: false, error: `Could not read the antennas: ${why(e)}` };
  }
  const parsed = parseAs(parseJsonText(text), AntennasFile, 'aio.antennas', ANTENNAS_FILE);
  if (!parsed.ok) return parsed;
  const file = parsed.value;

  const wanted = new Set(ids);
  const gone = file.units.filter((u) => wanted.has(u.id));
  if (gone.length === 0) return { ok: true, deleted: [], file };

  try {
    const detected = gone.filter((u) => u.origin !== 'flagged');
    if (detected.length > 0) {
      const bytes = await readBytesSeen(sidecarPath);
      let deletions: AntennaDeletion[] = [];
      if (bytes !== null) {
        const old = AntennaDeletionsFile.safeParse(parseJsonText(bytes.toString('utf8')));
        if (!old.success)
          return {
            ok: false,
            error: `${ANTENNA_DELETIONS_FILE} could not be read, so nothing was deleted.`,
          };
        deletions = old.data.deletions;
      }
      const have = new Set(deletions.map((d) => d.unitId));
      const at = now();
      const added = detected
        .filter((u) => !have.has(u.id))
        .map((u): AntennaDeletion => ({
          unitId: u.id,
          name: u.name,
          kind: u.kind,
          box: u.box,
          ...(file.run.captureId ? { captureId: file.run.captureId } : {}),
          deletedAt: at,
        }));
      if (added.length > 0)
        await writeJsonSeen(
          sidecarPath,
          { schema: ANTENNA_DELETIONS_SCHEMA, deletions: [...deletions, ...added] },
          { backup: true, name: ANTENNA_DELETIONS_FILE },
        );
    }
    const updated: AntennasFile = { ...file, units: file.units.filter((u) => !wanted.has(u.id)) };
    await writeJsonSeen(path, updated, { backup: true, name: ANTENNAS_FILE });
    for (const u of gone) {
      if (!SAFE_UNIT_ID.test(u.id)) continue;
      // a missing or locked crop is not worth failing a delete that is done
      await unlink(join(root, ...ANTENNA_CROPS_DIR.split('/'), `${u.id}.jpg`)).catch(
        () => undefined,
      );
    }
    return { ok: true, deleted: gone.map((u) => u.id), file: updated };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The antennas were not deleted: ${why(e)}` };
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
  handle('telecom:deleteAntennas', ({ projectId, ids }) =>
    deleteAntennas(projects, projectId, ids),
  );
}
