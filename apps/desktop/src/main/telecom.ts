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
  ANTENNA_HISTORY_DIR,
  ANTENNA_DELETIONS_FILE,
  ANTENNA_DELETIONS_SCHEMA,
  AntennaDeletionsFile,
  AntennaHistoryFile,
  AntennasFile,
  type AntennaDeletion,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isChangedOnDisk, readBytesSeen, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, parseJsonText } from './newer';
import type { Handle } from './notYet';
import { parseAs, readArchiveJson, why, type SurveyArchive, type SurveyProjects } from './survey';

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

/** Ids of the units the person deleted (the deletions sidecar); none when it is missing or bad. */
async function deletedIds(
  root: string | undefined,
  archive: SurveyArchive | undefined,
): Promise<Set<string>> {
  try {
    const raw = archive
      ? await readArchiveJson(archive, ANTENNA_DELETIONS_FILE)
      : parseJsonText(
          await readFile(join(root ?? '', ...ANTENNA_DELETIONS_FILE.split('/')), 'utf8'),
        );
    const r = AntennaDeletionsFile.safeParse(raw);
    return new Set(r.success ? r.data.deletions.map((d) => d.unitId) : []);
  } catch {
    return new Set();
  }
}

/**
 * What each survey date measured (`telecom/history/<captureId>.json`, Wave 3 M2), by file name.
 * A missing folder is none; a file that does not parse is skipped and counted.
 */
export async function readAntennaHistory(
  projects: SurveyProjects,
  projectId: string,
): Promise<IpcResponse<'telecom:readAntennaHistory'>> {
  const root = projects.root(projectId);
  const archive = root === undefined ? projects.package(projectId)?.archive : undefined;
  if (root === undefined && !archive)
    return { ok: false, error: `Project "${projectId}" is not open.` };
  const prefix = `${ANTENNA_HISTORY_DIR}/`;
  let names: string[];
  try {
    names = archive
      ? [...archive.entries.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
      : await readdir(join(root ?? '', ...ANTENNA_HISTORY_DIR.split('/'))).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw e;
        });
  } catch (e) {
    return { ok: false, error: `Could not read the antenna history: ${why(e)}` };
  }
  names = names
    .filter((n) => n.endsWith('.json') && !n.includes('/'))
    .sort()
    .slice(0, 500);
  const deleted = await deletedIds(root, archive);
  const files: AntennaHistoryFile[] = [];
  let skipped = 0;
  for (const name of names) {
    const rel = `${prefix}${name}`;
    try {
      const raw = archive
        ? await readArchiveJson(archive, rel)
        : parseJsonText(await readFile(join(root ?? '', ...rel.split('/')), 'utf8'));
      const r = AntennaHistoryFile.safeParse(raw);
      if (r.success)
        files.push({ ...r.data, units: r.data.units.filter((u) => !deleted.has(u.id)) });
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, files, skipped };
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
  // the ids on disk now, read plainly (the version the renderer saw stays the one the write checks);
  // null when the file cannot be read, so nothing is taken for a unit coming back
  const before = await unitIdsOnDisk(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name: ANTENNAS_FILE });
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The antennas were not saved: ${why(e)}` };
  }
  // any save that brings an id back is taken as its delete undone (crop and deletion record go
  // back). Safe while the renderer's store is the only writer and edits the file as it is at its
  // turn (a stale file is refused above); a second writer would need an explicit restore flag in
  // the contract
  if (before !== null) {
    const back = file.units.map((u) => u.id).filter((id) => !before.has(id));
    if (back.length > 0) await restoreDeleted(root, back);
  }
  return { ok: true };
}

/** The unit ids of the inventory on disk: none when there is no file, null when it is unreadable. */
async function unitIdsOnDisk(path: string): Promise<Set<string> | null> {
  try {
    const r = AntennasFile.safeParse(parseJsonText(await readFile(path, 'utf8')));
    return r.success ? new Set(r.data.units.map((u) => u.id)) : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null;
  }
}

const cropPath = (root: string, id: string) =>
  join(root, ...ANTENNA_CROPS_DIR.split('/'), `${id}.jpg`);
/** Where a deleted unit's crop waits, so an undo of the delete can bring it back. */
const parkedCropPath = (root: string, id: string) =>
  join(root, ...ANTENNA_CROPS_DIR.split('/'), PARKED_CROPS_DIR, `${id}.jpg`);
const PARKED_CROPS_DIR = 'deleted';

/**
 * Units a save brings back (the undo of a delete: the inventory written as it was): each gets its
 * parked crop back and leaves the deletion record, so the history records show it again and a
 * re-run pairs the find with it. The inventory is already written, which is the one journaled
 * change; this follows it, best effort: a crop or record that cannot be moved fails nothing.
 */
async function restoreDeleted(root: string, ids: readonly string[]): Promise<void> {
  const safe = ids.filter((id) => SAFE_UNIT_ID.test(id));
  for (const id of safe) {
    const live = cropPath(root, id);
    // a crop already in place (a re-run cut a new one) is kept
    const there = await stat(live).catch(() => null);
    if (!there) await rename(parkedCropPath(root, id), live).catch(() => undefined);
  }
  const sidecarPath = join(root, ...ANTENNA_DELETIONS_FILE.split('/'));
  try {
    const bytes = await readBytesSeen(sidecarPath);
    if (bytes === null) return;
    const old = AntennaDeletionsFile.safeParse(parseJsonText(bytes.toString('utf8')));
    if (!old.success) return;
    const back = new Set(safe);
    const kept = old.data.deletions.filter((d) => !back.has(d.unitId));
    if (kept.length === old.data.deletions.length) return;
    await writeJsonSeen(
      sidecarPath,
      { schema: ANTENNA_DELETIONS_SCHEMA, deletions: kept },
      { backup: true, name: ANTENNA_DELETIONS_FILE },
    );
  } catch (e) {
    console.warn(`Could not take restored antennas out of ${ANTENNA_DELETIONS_FILE}: ${why(e)}`);
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
 * changed since this call read it. Crops go last, best effort, into `telecom/crops/deleted/`.
 *
 * The undo of a delete is a `telecom:writeAntennas` of the inventory with the units back: that save
 * returns their crops and takes them out of the deletion record (`restoreDeleted`), all under the
 * one journaled change of the inventory. A redo is this delete again.
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
      // parked, not removed, so an undo of the delete brings it back (`restoreDeleted`); a
      // missing or locked crop is not worth failing a delete that is done
      await mkdir(dirname(parkedCropPath(root, u.id)), { recursive: true })
        .then(() => rename(cropPath(root, u.id), parkedCropPath(root, u.id)))
        .catch(() => undefined);
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
  handle('telecom:readAntennaHistory', ({ projectId }) => readAntennaHistory(projects, projectId));
  handle('telecom:writeAntennas', ({ projectId, file }) =>
    writeAntennas(projects, projectId, file),
  );
  handle('telecom:deleteAntennas', ({ projectId, ids }) =>
    deleteAntennas(projects, projectId, ids),
  );
}
