import {
  BoundaryEditsFile,
  VolumesFile,
  type IpcResponse,
  type BoundaryEditsFile as BoundaryEdits,
} from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';

type Read<T> = { ok: true; value: T | null } | { ok: false; error: string };

/** Read and validate a JSON file of the project; null when it does not exist. */
async function readValid<S extends z.ZodType>(file: string, schema: S): Promise<Read<z.output<S>>> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (e) {
    return { ok: false, error: `Could not read ${file}: ${String(e)}` };
  }
  if (raw === undefined) return { ok: true, value: null };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return { ok: false, error: `${file} is invalid${where}: ${first?.message ?? 'unknown error'}` };
  }
  return { ok: true, value: parsed.data };
}

/** `<root>/volumes.json` and `<root>/edits/boundaries.json` (data-conventions section 8). */
export async function readVolumes(root: string): Promise<IpcResponse<'project:readVolumes'>> {
  const volumes = await readValid(join(root, 'volumes.json'), VolumesFile);
  if (!volumes.ok) return volumes;
  const edits = await readValid(join(root, 'edits', 'boundaries.json'), BoundaryEditsFile);
  if (!edits.ok) return edits;
  return { ok: true, volumes: volumes.value, edits: edits.value };
}

/**
 * Save the stockpile toe lines corrected by hand to `<root>/edits/boundaries.json` (atomic, with a
 * `.bak` of the previous file). Every edit must name a pile and survey of the project's
 * volumes.json (data-conventions section 8).
 */
export async function writeBoundaries(
  root: string,
  file: BoundaryEdits,
): Promise<{ ok: boolean; error?: string }> {
  const volumes = await readValid(join(root, 'volumes.json'), VolumesFile);
  if (!volumes.ok) return volumes;
  if (!volumes.value)
    return { ok: false, error: `No volumes.json in ${root}, so there are no piles to edit.` };
  const piles = new Set(volumes.value.piles.map((p) => p.id));
  const epochs = new Set(volumes.value.captures.map((c) => c.epoch));
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
