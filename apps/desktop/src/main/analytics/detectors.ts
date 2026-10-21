/**
 * Detector storage: `detectors/<id>/detector.json` (`aio.vlm-detector/1`) in three places, the
 * Analytics pack (shipped, `<pack>/detectors/<assetType>/<id>/`, read only), the user's library
 * (`<userData>/detectors/<id>/`) and the project (`<project>/detectors/<id>/`). A detector travels
 * as a gzipped tar `<id>.aiodet` whose one top folder is `<id>/`: `detector.json`, plus the
 * `samples/` and `examples/` files it names. Import never trusts the archive: names go through
 * `archiveSegments`, links and anything outside the folder are refused, and 50 MB is the most it
 * unpacks to.
 */
import { VLM_DETECTOR_SCHEMA, VlmDetector, type DetectorWhere } from '@aio/schema';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { create, Parser, type ReadEntry } from 'tar';
import { readJson, renameRetrying, writeJsonAtomic } from '../fsutil';
import { archiveSegments } from '../jobs/packInstall';
import type { AnalyticsPack } from './pack';

export interface DetectorOptions {
  pack: AnalyticsPack | null;
  userData: string;
  projectDir?: string | undefined;
}

export type DetectorSource = 'project' | 'library';

/** Most an archive may unpack to. */
export const MAX_DETECTOR_BYTES = 50 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

export function detectorDirs(o: DetectorOptions): {
  shipped: string | null;
  library: string;
  project: string | null;
} {
  return {
    shipped: o.pack ? join(o.pack.dir, 'detectors') : null,
    library: join(o.userData, 'detectors'),
    project: o.projectDir ? join(o.projectDir, 'detectors') : null,
  };
}

const isDir = async (p: string) => (await lstat(p).catch(() => null))?.isDirectory() ?? false;

/** The detector in `<dir>/<id>/detector.json`, or null when it is missing or not valid. */
async function readOne(dir: string): Promise<VlmDetector | null> {
  try {
    const parsed = VlmDetector.safeParse(await readJson(join(dir, 'detector.json')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names.sort()) if (!n.startsWith('.') && (await isDir(join(dir, n)))) out.push(n);
  return out;
}

/** Folders that hold one detector each under `root`; shipped has the asset type between. */
async function detectorFolders(where: DetectorWhere, root: string): Promise<string[]> {
  if (where !== 'shipped') return (await subdirs(root)).map((n) => join(root, n));
  const out: string[] = [];
  for (const type of await subdirs(root)) {
    for (const id of await subdirs(join(root, type))) out.push(join(root, type, id));
  }
  return out;
}

function rootOf(o: DetectorOptions, where: DetectorWhere): string | null {
  return detectorDirs(o)[where];
}

function needRoot(o: DetectorOptions, where: DetectorSource): string {
  const root = rootOf(o, where);
  if (root === null) throw new Error('This detector needs a project, and none is open.');
  return root;
}

async function findFolder(
  o: DetectorOptions,
  where: DetectorWhere,
  id: string,
): Promise<string | null> {
  if (!ID.test(id)) return null;
  const root = rootOf(o, where);
  if (root === null) return null;
  if (where !== 'shipped') {
    const dir = join(root, id);
    return (await readOne(dir)) ? dir : null;
  }
  for (const dir of await detectorFolders('shipped', root)) {
    if (basename(dir) === id && (await readOne(dir))) return dir;
  }
  return null;
}

export async function listDetectors(
  o: DetectorOptions,
): Promise<{ where: DetectorWhere; detector: VlmDetector; modelMismatch: boolean }[]> {
  const sha = o.pack?.manifest.model.sha256;
  const out: { where: DetectorWhere; detector: VlmDetector; modelMismatch: boolean }[] = [];
  for (const where of ['shipped', 'library', 'project'] as const) {
    const root = rootOf(o, where);
    if (root === null) continue;
    for (const dir of await detectorFolders(where, root)) {
      const detector = await readOne(dir);
      if (detector === null) continue;
      out.push({
        where,
        detector,
        modelMismatch: sha !== undefined && detector.tunedOn.modelSha256 !== sha,
      });
    }
  }
  return out;
}

/** Save a detector (never into the pack). Answers the version stored. */
export async function saveDetector(
  o: DetectorOptions,
  where: DetectorSource,
  d: VlmDetector,
): Promise<number> {
  const root = needRoot(o, where);
  const dir = join(root, d.id);
  const have = await readOne(dir);
  const version = have ? have.version + 1 : Math.max(1, d.version);
  const stored: VlmDetector = VlmDetector.parse({
    ...d,
    version,
    updatedAt: new Date().toISOString(),
    source: d.source === 'imported' ? 'imported' : 'user',
  });
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, 'detector.json'), stored);
  return version;
}

export async function removeDetector(
  o: DetectorOptions,
  where: DetectorSource,
  id: string,
): Promise<void> {
  const root = needRoot(o, where);
  if (!ID.test(id)) throw new Error(`"${id}" is not a detector id.`);
  const dir = join(root, id);
  if (!(await isDir(dir))) throw new Error(`There is no detector "${id}" here.`);
  await rm(dir, { recursive: true, force: true });
}

/** The stored copies, in the order of `refs`; an unknown (where, id) throws. */
export async function resolveDetectors(
  o: DetectorOptions,
  refs: { where: DetectorWhere; id: string }[],
): Promise<VlmDetector[]> {
  const out: VlmDetector[] = [];
  for (const ref of refs) {
    const dir = await findFolder(o, ref.where, ref.id);
    const d = dir ? await readOne(dir) : null;
    if (d === null) {
      throw new Error(`The detector "${ref.id}" (${ref.where}) is not there any more.`);
    }
    out.push(d);
  }
  return out;
}

const referenced = (d: VlmDetector): string[] => [
  ...(d.samples ?? []).map((s) => s.file),
  ...(d.examples ?? []).map((e) => e.file),
];

/** Write a gzipped tar of one detector to `dest`, top folder `<id>/`. */
export async function exportDetector(
  o: DetectorOptions,
  where: DetectorWhere,
  id: string,
  dest: string,
  includeSamples: boolean,
): Promise<void> {
  const dir = await findFolder(o, where, id);
  const d = dir ? await readOne(dir) : null;
  if (dir === null || d === null) throw new Error(`There is no detector "${id}" to export.`);
  const stage = join(dirname(dest), `.aiodet-${randomBytes(6).toString('hex')}`);
  const tmpDest = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const top = join(stage, id);
    await mkdir(top, { recursive: true });
    const out: VlmDetector = { ...d };
    if (includeSamples) {
      for (const rel of referenced(d)) {
        const from = join(dir, ...rel.split('/'));
        const st = await lstat(from).catch(() => null);
        if (!st?.isFile()) throw new Error(`The sample ${rel} of "${id}" is missing.`);
        await mkdir(dirname(join(top, ...rel.split('/'))), { recursive: true });
        await copyFile(from, join(top, ...rel.split('/')));
      }
    } else {
      delete out.samples;
      delete out.examples;
    }
    await writeFile(join(top, 'detector.json'), `${JSON.stringify(out, null, 2)}\n`);
    await create({ gzip: true, cwd: stage, file: tmpDest, portable: true }, [id]);
    await renameRetrying(tmpDest, dest);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpDest, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- import

const refused = (why: string) => new Error(`This is not a detector file I can use: ${why}.`);

/** Read the archive into memory, refusing anything unsafe. Keys are paths below `<id>/`. */
async function readArchive(archive: string): Promise<{ top: string; files: Map<string, Buffer> }> {
  const files = new Map<string, Buffer>();
  const state: { top: string | null; failure: Error | null } = { top: null, failure: null };
  let total = 0;
  const source = createReadStream(archive);
  const parser = new Parser({ strict: true });
  const fail = (e: unknown) => {
    if (state.failure) return;
    state.failure = e instanceof Error ? e : new Error(String(e));
    source.destroy();
    try {
      parser.abort(new Error('stopped'));
    } catch {
      // reported through the error event, already handled
    }
  };

  parser.on('entry', (entry: ReadEntry) => {
    if (state.failure) {
      entry.resume();
      return;
    }
    try {
      const path = archiveSegments(entry.path);
      if (!path.ok) throw refused(`it holds ${path.why}`);
      const [first = '', ...rel] = path.segments;
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        throw refused('it holds a link');
      }
      if (state.top === null) state.top = first;
      else if (first !== state.top) throw refused('it holds more than the detector folder');
      if (entry.type === 'Directory') {
        entry.resume();
        return;
      }
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'ContiguousFile') {
        throw refused('it holds something that is not a file or a folder');
      }
      const okName =
        (rel.length === 1 && rel[0] === 'detector.json') ||
        (rel.length === 2 && (rel[0] === 'samples' || rel[0] === 'examples'));
      if (!okName) throw refused(`it holds ${rel.join('/') || first}, which a detector does not`);
      total += entry.size;
      if (total > MAX_DETECTOR_BYTES) throw refused('it unpacks to more than 50 MB');
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => files.set(rel.join('/'), Buffer.concat(chunks)));
    } catch (e) {
      entry.resume();
      fail(e);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const stop = (e: unknown) => {
      reject(state.failure ?? (e instanceof Error ? e : new Error(String(e))));
    };
    parser.on('error', stop);
    parser.on('end', () => {
      if (state.failure) stop(state.failure);
      else resolve();
    });
    source.on('error', stop);
    source.on('close', () => {
      if (state.failure) stop(state.failure);
    });
    source.pipe(parser);
  });
  const top = state.top;
  if (top === null) throw refused('it is empty');
  return { top, files };
}

const taken = async (root: string, id: string) => isDir(join(root, id));

/** Import a `.aiodet` into the project or library. */
export async function importDetector(
  o: DetectorOptions,
  archive: string,
  where: DetectorSource,
  onConflict?: 'update' | 'keep-both',
): Promise<{ id: string } | { conflict: { id: string; have: number; incoming: number } }> {
  const root = needRoot(o, where);
  const { top, files } = await readArchive(archive);
  const raw = files.get('detector.json');
  if (raw === undefined) throw refused('it has no detector.json');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw refused('detector.json is not valid');
  }
  const schema = (json as { schema?: unknown } | null)?.schema;
  if (typeof schema === 'string' && schema !== VLM_DETECTOR_SCHEMA) {
    throw new Error(
      `This detector uses ${schema}, a newer format than this app reads (${VLM_DETECTOR_SCHEMA}). Update the app to use it.`,
    );
  }
  const parsed = VlmDetector.safeParse(json);
  if (!parsed.success) throw refused('detector.json is not a valid detector');
  let d: VlmDetector = { ...parsed.data, source: 'imported' };
  if (d.id !== top) throw refused(`its folder "${top}" is not the detector id "${d.id}"`);
  for (const rel of referenced(d)) {
    const name = rel.split('/')[1];
    if (name === undefined || name === '.' || name === '..' || !files.has(rel)) {
      throw refused(`it names ${rel}, which is not a file in it`);
    }
  }

  const have = await readOne(join(root, d.id));
  const exists = have !== null || (await taken(root, d.id));
  if (exists && onConflict === undefined) {
    return { conflict: { id: d.id, have: have?.version ?? 0, incoming: d.version } };
  }
  if (exists && onConflict === 'keep-both') {
    let n = 2;
    for (;;) {
      const suffix = `-${n}`;
      const id = `${d.id.slice(0, 61 - suffix.length)}${suffix}`;
      if (!(await taken(root, id))) {
        d = { ...d, id, name: `${d.name.slice(0, 80 - ` (${n})`.length)} (${n})` };
        break;
      }
      n += 1;
    }
  }

  await mkdir(root, { recursive: true });
  const tmp = join(root, `.import-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(tmp);
    await writeFile(join(tmp, 'detector.json'), `${JSON.stringify(d, null, 2)}\n`);
    for (const rel of referenced(d)) {
      const to = join(tmp, ...rel.split('/'));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, files.get(rel) ?? Buffer.alloc(0));
    }
    const final = join(root, d.id);
    if (await taken(root, d.id)) {
      const old = join(root, `.old-${randomBytes(6).toString('hex')}`);
      await renameRetrying(final, old);
      try {
        await renameRetrying(tmp, final);
      } catch (e) {
        await renameRetrying(old, final).catch(() => undefined);
        throw e;
      }
      await rm(old, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await renameRetrying(tmp, final);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  return { id: d.id };
}
