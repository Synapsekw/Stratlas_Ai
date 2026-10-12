import {
  WALKS_DIR,
  WALK_PROCESS_MAX_BYTES,
  WalkProcessFile,
  readVersioned,
  walkProcessSummary,
  type WalkProcessSummary,
} from '@aio/schema';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * What `walks:list` says about processed walks: the summary of each `walks/<id>/process.json`
 * (`aio.walk-process/1`) the `walk.process` pipeline wrote last. A record that is broken, too
 * large, of a newer version or of another walk is left out, and so is the walk.
 */

/** An id that names one folder under `walks/` (never a path). */
const isFolderId = (id: string): boolean =>
  id.length > 0 && !id.startsWith('.') && !/[/\\]/.test(id);

/** A `process.json` text as the summary of the walk `id`, or null when it is not its record. */
export function parseProcessSummary(json: string | null, id: string): WalkProcessSummary | null {
  if (json === null || json.length > WALK_PROCESS_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const r = readVersioned(raw, { family: 'aio.walk-process', schema: WalkProcessFile });
  return r.ok && r.value.walk === id ? walkProcessSummary(r.value) : null;
}

/** The summaries of the processed walks among `ids` in a project folder. */
export async function readProcessSummaries(
  root: string,
  ids: readonly string[],
): Promise<Record<string, WalkProcessSummary>> {
  const out: Record<string, WalkProcessSummary> = {};
  for (const id of ids) {
    if (!isFolderId(id)) continue;
    const file = join(root, WALKS_DIR, id, 'process.json');
    const json = await stat(file)
      .then((s) => (s.size > WALK_PROCESS_MAX_BYTES ? null : readFile(file, 'utf8')))
      .catch(() => null);
    const summary = parseProcessSummary(json, id);
    if (summary) out[id] = summary;
  }
  return out;
}

/** The summaries of the processed walks among `ids` that a package carries, read in place. */
export async function packageProcessSummaries(
  archive: {
    entries: ReadonlyMap<string, unknown>;
    read(name: string): Promise<Buffer>;
  },
  ids: readonly string[],
): Promise<Record<string, WalkProcessSummary>> {
  const out: Record<string, WalkProcessSummary> = {};
  for (const id of ids) {
    if (!isFolderId(id)) continue;
    const name = `${WALKS_DIR}/${id}/process.json`;
    if (!archive.entries.has(name)) continue;
    // a member larger than a record can be is not unpacked
    const size = (archive.entries.get(name) as { size?: unknown } | null | undefined)?.size;
    if (typeof size === 'number' && size > WALK_PROCESS_MAX_BYTES) continue;
    const json = await archive
      .read(name)
      .then((b) => b.toString('utf8'))
      .catch(() => null);
    const summary = parseProcessSummary(json, id);
    if (summary) out[id] = summary;
  }
  return out;
}
