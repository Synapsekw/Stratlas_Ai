/**
 * Saved custom requests (`aio.ai-request/1`): one JSON file per request in the project
 * (`<project>/requests/<id>.json`, travels with the project) or in this computer's library
 * (`<userData>/requests/<id>.json`). Shared as a single `.aioreq` file. Written atomically with a
 * `.bak` of the previous file; a file that cannot be read is listed under `problems`, never lost.
 */
import { AiRequest, type AiRequestId } from '@aio/schema';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil';

export type RequestWhere = 'project' | 'library';

export interface RequestOptions {
  userData: string;
  projectDir?: string | undefined;
}

export interface RequestList {
  items: { where: RequestWhere; request: AiRequest }[];
  problems: { file: string; error: string }[];
}

/** An imported request file may be at most this large. */
export const REQUEST_IMPORT_MAX_BYTES = 64 * 1024;

export function requestDirs(o: RequestOptions): { library: string; project: string | null } {
  return {
    library: join(o.userData, 'requests'),
    project: o.projectDir === undefined ? null : join(o.projectDir, 'requests'),
  };
}

function dirOf(o: RequestOptions, where: RequestWhere): string {
  const d = requestDirs(o);
  if (where === 'library') return d.library;
  if (d.project === null) throw new Error('This needs a project, and none was given.');
  return d.project;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parse(raw: unknown): AiRequest {
  const r = AiRequest.safeParse(raw);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  const at = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  throw new Error(`Not a valid request${at}: ${first?.message ?? 'unknown error'}.`);
}

async function listDir(dir: string, where: RequestWhere): Promise<RequestList> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], problems: [] };
    throw e;
  }
  const items: RequestList['items'] = [];
  const problems: RequestList['problems'] = [];
  for (const file of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const raw = await readJson(join(dir, file));
      if (raw === undefined) continue;
      items.push({ where, request: parse(raw) });
    } catch (e) {
      problems.push({ file, error: message(e) });
    }
  }
  items.sort((a, b) => a.request.name.localeCompare(b.request.name));
  return { items, problems };
}

/** Project requests first, then the library's, each by name; unreadable files under `problems`. */
export async function listRequests(o: RequestOptions): Promise<RequestList> {
  const d = requestDirs(o);
  const project: RequestList =
    d.project === null ? { items: [], problems: [] } : await listDir(d.project, 'project');
  const library = await listDir(d.library, 'library');
  return {
    items: [...project.items, ...library.items],
    problems: [...project.problems, ...library.problems],
  };
}

export async function saveRequest(
  o: RequestOptions,
  where: RequestWhere,
  r: AiRequest,
): Promise<void> {
  const dir = dirOf(o, where);
  const valid = parse(r);
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, `${valid.id}.json`), valid, { backup: true });
}

export async function removeRequest(
  o: RequestOptions,
  where: RequestWhere,
  id: AiRequestId,
): Promise<void> {
  await rm(join(dirOf(o, where), `${id}.json`), { force: true });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function exportRequest(
  o: RequestOptions,
  where: RequestWhere,
  id: AiRequestId,
  file: string,
): Promise<void> {
  const raw = await readJson(join(dirOf(o, where), `${id}.json`));
  if (raw === undefined) throw new Error(`There is no request "${id}" here.`);
  await writeJsonAtomic(file, parse(raw));
}

/** Read a `.aioreq` (at most 64 KB), validate it and save it; an id already there gets `-2`, `-3`. */
export async function importRequest(
  o: RequestOptions,
  where: RequestWhere,
  file: string,
): Promise<AiRequest> {
  const dir = dirOf(o, where);
  if ((await stat(file)).size > REQUEST_IMPORT_MAX_BYTES) {
    throw new Error('That file is larger than 64 KB, so it is not a request.');
  }
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch {
    throw new Error('That file is not a request (it is not valid JSON).');
  }
  const r = parse(raw);
  let id: string = r.id;
  for (let n = 2; await exists(join(dir, `${id}.json`)); n += 1) {
    const suffix = `-${n}`;
    id = `${r.id.slice(0, 61 - suffix.length)}${suffix}`;
  }
  const saved = { ...r, id };
  await saveRequest(o, where, saved);
  return saved;
}
