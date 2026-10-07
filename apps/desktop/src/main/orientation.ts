/**
 * Camera directions set by hand (`<root>/orientation.json`, `aio.orientation/1`): video direction
 * keyframes ("Align camera to map") and photo corrections ("Align photo to map"). Written
 * atomically with a `.bak` of the previous file, through the journal (`orientation:write` is a
 * journalled writer); a newer file is refused and never written over; a package's file is read in
 * place and never written.
 */
import { OrientationFile, type IpcResponse, type OrientationFileInput } from '@aio/schema';
import { join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';

export const ORIENTATION_PATH = 'orientation.json';

function invalid(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `orientation.json is invalid${where}: ${first?.message ?? 'unknown error'}`;
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function parse(raw: unknown, readOnly: boolean): IpcResponse<'orientation:read'> {
  const newer = newerThanThisBuild(raw, 'aio.orientation', ORIENTATION_PATH);
  if (newer) return { ok: false, error: newer };
  const parsed = OrientationFile.safeParse(raw);
  return parsed.success
    ? { ok: true, file: parsed.data, readOnly }
    : { ok: false, error: invalid(parsed.error) };
}

export async function readOrientation(root: string): Promise<IpcResponse<'orientation:read'>> {
  let raw: unknown;
  try {
    // remembered, so a save compares with what was read first (shared folders)
    raw = await readJsonSeen(join(root, ORIENTATION_PATH));
  } catch (e) {
    return { ok: false, error: `Could not read the camera directions: ${why(e)}` };
  }
  if (raw === undefined) return { ok: true, file: null, readOnly: false };
  return parse(raw, false);
}

/** A package's orientation file, read from the archive in place. */
export async function readPackageOrientation(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): Promise<IpcResponse<'orientation:read'>> {
  if (!archive.entries.has(ORIENTATION_PATH)) return { ok: true, file: null, readOnly: true };
  try {
    return parse(JSON.parse((await archive.read(ORIENTATION_PATH)).toString('utf8')), true);
  } catch (e) {
    return { ok: false, error: `Could not read the camera directions: ${why(e)}` };
  }
}

export async function writeOrientation(
  root: string,
  input: OrientationFileInput,
): Promise<IpcResponse<'orientation:write'>> {
  const file = OrientationFile.parse(input);
  const path = join(root, ORIENTATION_PATH);
  const newer = await newerOnDisk(path, 'aio.orientation', ORIENTATION_PATH);
  if (newer) return { ok: false, error: newer };
  try {
    await writeJsonSeen(path, file, { backup: true, name: ORIENTATION_PATH });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The camera directions were not saved: ${why(e)}` };
  }
}
