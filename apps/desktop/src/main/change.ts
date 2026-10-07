/**
 * Change sets between capture dates (M8 stream C1, FUS-12): `change:list|read|write|compute|cancel`
 * and the `change:progress` event. Change sets live in `<project>/change/<id>.json`
 * (`aio.change/1`, data-conventions section 14), written atomically with a `.bak`. A package's
 * change sets are read in place and never written; nothing computes in a package.
 */
import { ChangeCancelled, computeInApp, summarize } from '@aio/change/core';
import { fromWgs84, isKnownCrs, projectToLocal } from '@aio/geo';
import {
  CHANGE_DIR,
  ChangeSet,
  DEFAULT_CHANGE_THRESHOLDS,
  type ChangeSetInput,
  type ChangeSetSummary,
  type ChangeThresholds,
  type IpcEvent,
  type IpcResponse,
  type ProjectManifest,
  type Vec3,
} from '@aio/schema';
import { captureIndex } from '@aio/workspace/captures';
import { imageSize } from '@aio/project/image';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { folderFiles, readDetectionPasses } from './detections';
import {
  isChangedOnDisk,
  readBytesSeen,
  readJson,
  seenFiles,
  writeJsonAtomic,
  writeJsonSeen,
  type SeenFiles,
} from './fsutil';
import type { Handle } from './notYet';
import { readIssues, readManifest, type ProjectRegistry } from './project';
import { resolveInside } from './protocol/paths';

/** A folder file's text, remembered in `seen` (compare-before-write); ENOENT when missing. */
async function readSeen(path: string, seen: SeenFiles): Promise<string> {
  const buf = await readBytesSeen(path, seen);
  if (buf === null) throw Object.assign(new Error(`${path} not found`), { code: 'ENOENT' });
  return buf.toString('utf8');
}

/** Enough of a photo file for its size (JPEG frames come after the EXIF block). */
const HEAD_BYTES = 256 * 1024;

async function readHead(path: string, bytes: number): Promise<Uint8Array> {
  const f = await open(path, 'r');
  try {
    const buf = new Uint8Array(bytes);
    const { bytesRead } = await f.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

export interface Archive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

export interface ChangeIpcDeps {
  handle: Handle;
  registry: Pick<ProjectRegistry, 'root' | 'package'>;
  /** Send `change:progress` to the window. */
  emit?: (event: IpcEvent<'change:progress'>) => void;
  /** The person's change thresholds (Settings), else the founder defaults. */
  thresholds?: () => ChangeThresholds;
  now?: () => string;
}

const READ_ONLY = 'This project is a read-only package. Change reviews are not saved into it.';

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function invalid(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `invalid${where}: ${first?.message ?? 'unknown error'}`;
}

const isSetName = (n: string) => n.toLowerCase().endsWith('.json') && !n.startsWith('.');

function parseSet(name: string, text: string): { set: ChangeSet } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { error: `not JSON: ${String(e).slice(0, 200)}` };
  }
  const parsed = ChangeSet.safeParse(raw);
  if (!parsed.success) return { error: invalid(parsed.error) };
  if (`${parsed.data.id}.json` !== name)
    return { error: `its id "${parsed.data.id}" does not match the file name` };
  return { set: parsed.data };
}

/** Every change set of a project folder or package, newest first. */
export async function listChangeSets(
  src: { root: string } | { archive: Archive },
  seen?: SeenFiles,
): Promise<IpcResponse<'change:list'>> {
  const files: { name: string; read: () => Promise<string> }[] = [];
  if ('root' in src) {
    let names: string[] = [];
    try {
      const list = await readdir(join(src.root, CHANGE_DIR), { withFileTypes: true });
      names = list.filter((e) => e.isFile() && isSetName(e.name)).map((e) => e.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        return { ok: false, error: `Could not read the change sets: ${why(e)}` };
    }
    for (const name of names) {
      const path = join(src.root, CHANGE_DIR, name);
      files.push({ name, read: () => (seen ? readSeen(path, seen) : readFile(path, 'utf8')) });
    }
  } else {
    for (const key of src.archive.entries.keys()) {
      if (!key.startsWith(`${CHANGE_DIR}/`)) continue;
      const name = key.slice(CHANGE_DIR.length + 1);
      if (name.includes('/') || !isSetName(name)) continue;
      files.push({ name, read: async () => (await src.archive.read(key)).toString('utf8') });
    }
  }
  const sets: ChangeSetSummary[] = [];
  const problems: { name: string; error: string }[] = [];
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    let text: string;
    try {
      text = await f.read();
    } catch (e) {
      problems.push({ name: f.name, error: why(e) });
      continue;
    }
    const r = parseSet(f.name, text);
    if ('set' in r) sets.push(summarize(r.set));
    else problems.push({ name: f.name, error: r.error });
  }
  sets.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
  return { ok: true, sets, problems, readOnly: !('root' in src) };
}

export async function readChangeSet(
  src: { root: string } | { archive: Archive },
  id: string,
  seen?: SeenFiles,
): Promise<IpcResponse<'change:read'>> {
  const name = `${id}.json`;
  let text: string | null;
  try {
    if ('root' in src) {
      const path = join(src.root, CHANGE_DIR, name);
      text = await (seen ? readSeen(path, seen) : readFile(path, 'utf8')).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      });
    } else {
      const key = `${CHANGE_DIR}/${name}`;
      text = src.archive.entries.has(key) ? (await src.archive.read(key)).toString('utf8') : null;
    }
  } catch (e) {
    return { ok: false, error: `Could not read the change set ${id}: ${why(e)}` };
  }
  if (text === null) return { ok: false, error: `There is no change set "${id}" in this project.` };
  const r = parseSet(name, text);
  return 'set' in r
    ? { ok: true, set: r.set, readOnly: !('root' in src) }
    : { ok: false, error: `change/${name} is ${r.error}` };
}

/**
 * Write a change set. With `seen` (a review the person saved), the write compares with what was
 * last read or written here first and is refused when someone else changed the file meanwhile.
 */
export async function writeChangeSet(
  root: string,
  input: ChangeSetInput,
  seen?: SeenFiles,
): Promise<IpcResponse<'change:write'>> {
  const set = ChangeSet.parse(input);
  const file = join(root, CHANGE_DIR, `${set.id}.json`);
  try {
    await mkdir(join(root, CHANGE_DIR), { recursive: true });
    if (seen) await writeJsonSeen(file, set, { backup: true, name: `change/${set.id}.json` }, seen);
    else await writeJsonAtomic(file, set, { backup: true });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The change review was not saved: ${why(e)}` };
  }
}

/** Lon/lat of a map layer to the project local frame (ground height 0), when the CRS is known. */
export function lonLatToLocal(
  manifest: Pick<ProjectManifest, 'crs' | 'origin'>,
): ((ll: [number, number]) => Vec3) | undefined {
  const epsg = 'epsg' in manifest.crs ? manifest.crs.epsg : undefined;
  if (epsg === undefined || !isKnownCrs(epsg)) return undefined;
  return ([lon, lat]) => {
    const [x, , z] = projectToLocal(
      fromWgs84([lon, lat, manifest.origin[2]], epsg),
      manifest.origin,
    );
    return [x, 0, z];
  };
}

interface Running {
  cancelled: boolean;
}

export function registerChangeIpc(deps: ChangeIpcDeps): void {
  const { handle, registry } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const running = new Map<string, Running>();
  const source = (projectId: string): { root: string } | { archive: Archive } | null => {
    const pkg = registry.package(projectId);
    if (pkg) return { archive: pkg.archive };
    const root = registry.root(projectId);
    return root === undefined ? null : { root };
  };
  const notOpen = (projectId: string) => ({
    ok: false as const,
    error: `Project "${projectId}" is not open. Open it, then try again.`,
  });

  handle('change:list', ({ projectId }) => {
    const src = source(projectId);
    return src ? listChangeSets(src, seenFiles) : notOpen(projectId);
  });
  handle('change:read', ({ projectId, id }) => {
    const src = source(projectId);
    return src ? readChangeSet(src, id, seenFiles) : notOpen(projectId);
  });
  handle('change:write', ({ projectId, set }) => {
    if (registry.package(projectId)) return { ok: false, error: READ_ONLY, code: 'read-only' };
    const root = registry.root(projectId);
    return root === undefined ? notOpen(projectId) : writeChangeSet(root, set, seenFiles);
  });
  handle('change:compute', async ({ jobId, projectId, from, to, kinds }) => {
    if (registry.package(projectId))
      return {
        ok: false,
        error: 'This project is a read-only package. Change is not computed in it.',
        code: 'read-only',
      };
    const root = registry.root(projectId);
    if (root === undefined) return notOpen(projectId);
    if (running.has(jobId)) return { ok: false, error: `The run ${jobId} is already going.` };
    const manifest = await readManifest(root);
    if (!manifest.ok) return { ok: false, error: manifest.error };
    const m = manifest.value;
    const run: Running = { cancelled: false };
    running.set(jobId, run);
    const toLocal = lonLatToLocal(m);
    try {
      const sets = await computeInApp(
        {
          manifest: m,
          index: captureIndex(m),
          thresholds: deps.thresholds?.() ?? DEFAULT_CHANGE_THRESHOLDS,
          issues: async () => {
            const r = await readIssues(root);
            if (!r.ok) throw new Error(r.error);
            return r.value;
          },
          passes: async () => {
            const r = await readDetectionPasses(folderFiles(root, null), m, false);
            return r.ok ? r.files : [];
          },
          photoSize: async (_layer, photo) => {
            const src = photo.src as { path?: unknown } | undefined;
            if (typeof src?.path !== 'string') return null;
            const p = await resolveInside(root, src.path.replace(/\\/g, '/'));
            if (!p.ok) return null;
            const size = imageSize(
              await readHead(p.path, HEAD_BYTES).catch(() => new Uint8Array()),
            );
            return size ? ([size.width, size.height] as const) : null;
          },
          geojson: async (layer) => {
            if (!('path' in layer.src)) return null;
            const p = await resolveInside(root, layer.src.path.replace(/\\/g, '/'));
            if (!p.ok) return null;
            return readJson(p.path).catch(() => null);
          },
          previous: async (id) => {
            const r = await readChangeSet({ root }, id);
            return r.ok ? r.set : null;
          },
          ...(toLocal ? { toLocal } : {}),
          now,
          jobId,
          progress: (phase, done, total) => {
            deps.emit?.({ jobId, phase, done, total });
          },
          cancelled: () => run.cancelled,
        },
        from,
        to,
        kinds,
      );
      for (const s of sets) {
        if (run.cancelled) throw new ChangeCancelled();
        const w = await writeChangeSet(root, s);
        if (!w.ok) return w;
      }
      return { ok: true, ids: sets.map((s) => s.id) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      running.delete(jobId);
    }
  });
  handle('change:cancel', ({ jobId }) => {
    const r = running.get(jobId);
    if (!r) return { ok: false };
    r.cancelled = true;
    return { ok: true };
  });
}
