import { detectPackageKind, type PackageKind } from '@aio/project';
import { MapPackInfo, type IpcResponse, type LibraryEntry } from '@aio/schema';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';
import { readManifest, type ProjectRegistry } from './project';

/** Folders the person added by hand, kept in userData/library.json. */
export interface LibraryStore {
  paths(): Promise<string[]>;
  add(path: string): Promise<void>;
}

const LibraryFile = z.object({ paths: z.array(z.string()) });

const sameKey = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

export function createLibraryStore(file: string): LibraryStore {
  async function paths(): Promise<string[]> {
    try {
      const r = LibraryFile.safeParse(await readJson(file));
      return r.success ? r.data.paths : [];
    } catch (e) {
      console.warn(`Library file ${file} is unreadable, ignoring it: ${String(e)}`);
      return [];
    }
  }
  return {
    paths,
    async add(path) {
      const current = await paths();
      if (current.some((p) => sameKey(p) === sameKey(path))) return;
      await writeJsonAtomic(file, { paths: [...current, resolve(path)] });
    },
  };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const SIZE_FILE_LIMIT = 20_000;

/** Total size of a folder, stopping after a fixed number of files (a fast estimate). */
async function folderSize(root: string): Promise<number> {
  let total = 0;
  let files = 0;
  const queue = [root];
  while (queue.length > 0 && files < SIZE_FILE_LIMIT) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const sizes = await Promise.all(
      entries.map(async (e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          queue.push(p);
          return 0;
        }
        if (!e.isFile()) return 0;
        files++;
        try {
          return (await stat(p)).size;
        } catch {
          return 0;
        }
      }),
    );
    for (const s of sizes) total += s;
  }
  return total;
}

/** Relative file paths up to a small depth, enough for detectPackageKind. */
async function listFiles(root: string, depth = 3): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, level: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (level < depth) await walk(p, level + 1);
      } else {
        out.push(relative(root, p).replace(/\\/g, '/'));
      }
      if (out.length > 5000) return;
    }
  }
  await walk(root, 1);
  return out;
}

/** native when the folder holds our manifest.json, else a known kit export, else null. */
export async function detectFolder(dir: string): Promise<PackageKind | null> {
  if (await exists(join(dir, 'manifest.json'))) return 'native';
  return detectPackageKind(await listFiles(dir));
}

type Built = { ok: true; entry: LibraryEntry } | { ok: false; error: string };

async function buildEntry(dir: string, registry: ProjectRegistry): Promise<Built> {
  const kind = await detectFolder(dir);
  if (kind === null) {
    return {
      ok: false,
      error: `${dir} is not a Stratlas project or a known kit export. Pick the folder that holds manifest.json.`,
    };
  }
  if (kind !== 'native') {
    const id = registry.register(dir);
    return {
      ok: true,
      entry: { id, name: basename(dir), path: dir, kind, sizeBytes: await folderSize(dir) },
    };
  }
  const manifest = await readManifest(dir);
  if (!manifest.ok) return manifest;
  const m = manifest.value;
  const id = registry.register(dir);
  const layerCounts: Record<string, number> = {};
  for (const l of m.layers) layerCounts[l.kind] = (layerCounts[l.kind] ?? 0) + 1;
  const captureDate = m.captures
    .map((c) => c.date)
    .sort()
    .at(-1);
  const entry: LibraryEntry = {
    id,
    name: m.name,
    path: dir,
    kind: 'native',
    sizeBytes: await folderSize(dir),
    layerCounts,
  };
  if (m.customer !== undefined) entry.customer = m.customer;
  if (m.site !== undefined) entry.site = m.site;
  if (captureDate !== undefined) entry.captureDate = captureDate;
  if (await exists(join(dir, 'thumbnail.jpg'))) {
    entry.thumbnail = `aio://project/${id}/thumbnail.jpg`;
  }
  return { ok: true, entry };
}

/** Projects under `<dataRoot>/projects/*` plus folders the person added. */
export async function listLibrary(o: {
  dataRoot: string;
  extraPaths: string[];
  registry: ProjectRegistry;
}): Promise<LibraryEntry[]> {
  const candidates: string[] = [];
  const projectsDir = join(o.dataRoot, 'projects');
  try {
    for (const e of await readdir(projectsDir, { withFileTypes: true })) {
      const dir = join(projectsDir, e.name);
      if (e.isDirectory() && (await exists(join(dir, 'manifest.json')))) candidates.push(dir);
    }
  } catch {
    // No projects folder yet: only user-added folders.
  }
  for (const p of o.extraPaths) if (await isDir(p)) candidates.push(resolve(p));

  const seen = new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const dir of candidates) {
    const key = sameKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await buildEntry(dir, o.registry);
    if (r.ok) entries.push(r.entry);
    else console.warn(`Library: skipped ${dir}: ${r.error}`);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function addToLibrary(
  path: string,
  store: LibraryStore,
  registry: ProjectRegistry,
): Promise<IpcResponse<'library:add'>> {
  const dir = resolve(path);
  if (!(await isDir(dir))) {
    return { ok: false, error: `Folder not found: ${dir}. Pick an existing project folder.` };
  }
  const r = await buildEntry(dir, registry);
  if (!r.ok) return r;
  await store.add(dir);
  return r;
}

/** Map packs described by `<packsDir>/<id>.json` (MapPackInfo). */
export async function listPacks(packsDir: string): Promise<MapPackInfo[]> {
  let names: string[];
  try {
    names = (await readdir(packsDir)).filter((n) => n.toLowerCase().endsWith('.json')).sort();
  } catch {
    return [];
  }
  const packs: MapPackInfo[] = [];
  for (const name of names) {
    const file = join(packsDir, name);
    try {
      const r = MapPackInfo.safeParse(await readJson(file));
      if (r.success) packs.push(r.data);
      else console.warn(`Map pack ${file} is invalid: ${r.error.issues[0]?.message ?? ''}`);
    } catch (e) {
      console.warn(`Map pack ${file} is unreadable: ${String(e)}`);
    }
  }
  return packs;
}
