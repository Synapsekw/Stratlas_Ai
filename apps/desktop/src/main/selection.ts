/**
 * Point selections of placed findings (`<root>/selections/<name>.sel`, data-conventions section
 * 35): written whole through a temporary file and a rename, after the bytes are checked. Binary
 * assets beside issues.json, not journalled (like the thumbnail cache). Packages are refused by
 * the IPC handler before this runs.
 */
import { decodeSelection, type IpcResponse } from '@aio/schema';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SELECTIONS_DIR = 'selections';

export async function writeSelection(
  root: string,
  name: string,
  data: Uint8Array,
): Promise<IpcResponse<'project:writeSelection'>> {
  if (!decodeSelection(data))
    return { ok: false, error: 'The point selection is not a valid selection file.' };
  const dir = join(root, SELECTIONS_DIR);
  const file = join(dir, `${name}.sel`);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, file);
    return { ok: true, path: `${SELECTIONS_DIR}/${name}.sel` };
  } catch (e) {
    return {
      ok: false,
      error: `The point selection was not saved: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
