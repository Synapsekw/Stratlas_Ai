/**
 * `<project>/detections.json` (BLD-5): detections waiting for review, as drawn, proposed by a
 * vision model or by a pipeline. Read from folders and packages; written only into folders,
 * atomically with a `.bak`. The contents are validated with `@aio/annotate/detections` (the local
 * adapter for `aio.detections/1` until the schema lands in `@aio/schema`).
 */
import { DETECTIONS_FILE, parseDetectionsFile, toDetectionsFile } from '@aio/annotate/detections';
import type { IpcResponse } from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

type ReadResult = IpcResponse<'detections:read'>;

function checked(raw: unknown, where: string): ReadResult {
  if (raw === undefined) return { ok: true, file: null, readOnly: false };
  const parsed = parseDetectionsFile(raw);
  if (!parsed.ok) return { ok: false, error: `${where}: ${parsed.error}.` };
  return {
    ok: true,
    file: { ...toDetectionsFile(parsed.value.detections, parsed.value.runs) },
    readOnly: false,
  };
}

export async function readDetections(root: string): Promise<ReadResult> {
  const file = join(root, DETECTIONS_FILE);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (e) {
    return { ok: false, error: `Could not read ${file}: ${String(e)}` };
  }
  return checked(raw, file);
}

/** The review inside a `.aio` package (read only). */
export async function readPackageDetections(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): Promise<ReadResult> {
  if (!archive.entries.has(DETECTIONS_FILE)) return { ok: true, file: null, readOnly: true };
  let raw: unknown;
  try {
    raw = JSON.parse((await archive.read(DETECTIONS_FILE)).toString('utf8'));
  } catch (e) {
    return { ok: false, error: `Could not read ${DETECTIONS_FILE} from the package: ${String(e)}` };
  }
  const r = checked(raw, DETECTIONS_FILE);
  return r.ok ? { ...r, readOnly: true } : r;
}

/** Validate, then replace `<root>/detections.json` atomically, keeping the previous file as `.bak`. */
export async function writeDetections(
  root: string,
  raw: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseDetectionsFile(raw);
  if (!parsed.ok) return { ok: false, error: `The detections were not saved: ${parsed.error}.` };
  const file = join(root, DETECTIONS_FILE);
  try {
    await writeJsonAtomic(file, toDetectionsFile(parsed.value.detections, parsed.value.runs), {
      backup: true,
    });
  } catch (e) {
    return { ok: false, error: `Could not save ${file}: ${String(e)}` };
  }
  return { ok: true };
}
