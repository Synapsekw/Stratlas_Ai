/**
 * The report narrative of a project (BLD-7): `<root>/report/narrative.json` (`aio.narrative/1`),
 * every saved version of the executive summary, method and findings text. Written atomically with
 * a `.bak` of the previous file; a package's narrative is read in place and never written.
 */
import { NarrativeFile, type IpcResponse } from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';

export const NARRATIVE_PATH = 'report/narrative.json';

function invalid(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `report/narrative.json is invalid${where}: ${first?.message ?? 'unknown error'}`;
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

export async function readNarrative(root: string): Promise<IpcResponse<'report:readNarrative'>> {
  let raw: unknown;
  try {
    raw = await readJson(join(root, NARRATIVE_PATH));
  } catch (e) {
    return { ok: false, error: `Could not read the report text: ${why(e)}` };
  }
  if (raw === undefined) return { ok: true, file: null, readOnly: false };
  const newer = newerThanThisBuild(raw, 'aio.narrative', NARRATIVE_PATH);
  if (newer) return { ok: false, error: newer };
  const parsed = NarrativeFile.safeParse(raw);
  return parsed.success
    ? { ok: true, file: parsed.data, readOnly: false }
    : { ok: false, error: invalid(parsed.error) };
}

/** A package's narrative, read from the archive in place. */
export async function readPackageNarrative(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): Promise<IpcResponse<'report:readNarrative'>> {
  if (!archive.entries.has(NARRATIVE_PATH)) return { ok: true, file: null, readOnly: true };
  try {
    const raw: unknown = JSON.parse((await archive.read(NARRATIVE_PATH)).toString('utf8'));
    const newer = newerThanThisBuild(raw, 'aio.narrative', NARRATIVE_PATH);
    if (newer) return { ok: false, error: newer };
    const parsed = NarrativeFile.safeParse(raw);
    return parsed.success
      ? { ok: true, file: parsed.data, readOnly: true }
      : { ok: false, error: invalid(parsed.error) };
  } catch (e) {
    return { ok: false, error: `Could not read the report text from the package: ${why(e)}` };
  }
}

export async function writeNarrative(
  root: string,
  file: NarrativeFile,
): Promise<IpcResponse<'report:writeNarrative'>> {
  const newer = await newerOnDisk(join(root, NARRATIVE_PATH), 'aio.narrative', NARRATIVE_PATH);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(join(root, 'report'), { recursive: true });
    await writeJsonAtomic(join(root, NARRATIVE_PATH), file, { backup: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `The report text was not saved: ${why(e)}` };
  }
}
