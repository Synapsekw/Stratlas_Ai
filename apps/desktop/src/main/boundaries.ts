import { VolumesFile, type BoundaryEditsFile } from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * Save the stockpile toe lines corrected by hand to `<root>/edits/boundaries.json` (atomic, with a
 * `.bak` of the previous file). Every edit must name a pile and survey of the project's
 * volumes.json (data-conventions section 8).
 */
export async function writeBoundaries(
  root: string,
  file: BoundaryEditsFile,
): Promise<{ ok: boolean; error?: string }> {
  const volumesPath = join(root, 'volumes.json');
  let raw: unknown;
  try {
    raw = await readJson(volumesPath);
  } catch (e) {
    return { ok: false, error: `Could not read ${volumesPath}: ${String(e)}` };
  }
  if (raw === undefined)
    return { ok: false, error: `No volumes.json in ${root}, so there are no piles to edit.` };
  const volumes = VolumesFile.safeParse(raw);
  if (!volumes.success)
    return { ok: false, error: `${volumesPath} is invalid: ${volumes.error.message}` };
  const piles = new Set(volumes.data.piles.map((p) => p.id));
  const epochs = new Set(volumes.data.captures.map((c) => c.epoch));
  for (const e of file.edits) {
    if (!piles.has(e.pile)) return { ok: false, error: `Pile ${e.pile} is not in this project.` };
    if (!epochs.has(e.epoch))
      return { ok: false, error: `Survey ${e.epoch} is not in this project.` };
  }
  const dir = join(root, 'edits');
  try {
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, 'boundaries.json'), file, { backup: true });
  } catch (e) {
    return { ok: false, error: `Could not save ${join(dir, 'boundaries.json')}: ${String(e)}` };
  }
  return { ok: true };
}
