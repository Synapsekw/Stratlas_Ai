/**
 * Point selections of placed findings (`<root>/selections/<name>.sel`, data-conventions section
 * 35): written whole through a temporary file and a rename, after the bytes are checked. Binary
 * assets beside issues.json, not journalled (like the thumbnail cache). Packages are refused by
 * the IPC handler before this runs.
 */
import { decodeSelection, type IpcResponse, SelectionName } from '@aio/schema';
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SELECTIONS_DIR = 'selections';

/** The write of each file on its way: a write starts when the one before it has settled, so two renames over one file never overlap (Windows refuses that). */
const turns = new Map<string, Promise<unknown>>();

export function writeSelection(
  root: string,
  name: string,
  data: Uint8Array,
): Promise<IpcResponse<'project:writeSelection'>> {
  const key = join(root, SELECTIONS_DIR, name);
  const run = (turns.get(key) ?? Promise.resolve()).then(() => write(root, name, data));
  const tail = run.finally(() => {
    if (turns.get(key) === tail) turns.delete(key);
  });
  turns.set(key, tail);
  return run;
}

async function write(
  root: string,
  name: string,
  data: Uint8Array,
): Promise<IpcResponse<'project:writeSelection'>> {
  if (!SelectionName.safeParse(name).success)
    return { ok: false, error: 'The point selection name is not valid.' };
  if (!decodeSelection(data))
    return { ok: false, error: 'The point selection is not a valid selection file.' };
  const dir = join(root, SELECTIONS_DIR);
  const file = join(dir, `${name}.sel`);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, file);
    return { ok: true, path: `${SELECTIONS_DIR}/${name}.sel` };
  } catch (e) {
    await rm(tmp, { force: true });
    return {
      ok: false,
      error: `The point selection was not saved: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
