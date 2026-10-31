import { brand } from '@aio/brand';
import { detectPackageKind, type PackageKind } from '@aio/project';
import { openPackage, openZip } from '@aio/project/package';
import {
  MapPackInfo,
  PACKAGE_EXTENSION,
  projectPurpose,
  type IpcResponse,
  type LibraryEntry,
  type ProjectManifest,
} from '@aio/schema';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { FLYABILITY_MIN_PACK, flyabilityPackRefusal } from './builder';
import { compareVersions } from './jobs/pack';
import { readJson, writeJsonAtomic } from './fsutil';
import { newerThanThisBuild } from './newer';
import { readManifest, type ProjectRegistry } from './project';

/** Folders the person added by hand, kept in userData/library.json. */
export interface LibraryStore {
  paths(): Promise<string[]>;
  add(path: string): Promise<void>;
  /** Forget an added path (case ignored on Windows); nothing on disk changes. */
  remove(path: string): Promise<void>;
}

/**
 * `aio.library/1` since 0.9; files from 0.8 and earlier have no schema id and read the same. 0.8
 * keeps reading the list (it ignores the id). A newer list is refused, never saved over.
 */
export const LIBRARY_SCHEMA = 'aio.library/1';
const LibraryFile = z.object({
  schema: z.literal(LIBRARY_SCHEMA).optional(),
  paths: z.array(z.string()),
});

/**
 * Beside `thumbnail.jpg` in a native project: the project's own picture, kept once before Change
 * thumbnail first replaced it, so it can be put back (covers.ts).
 */
export const THUMBNAIL_ORIGINAL = 'thumbnail.original.jpg';

const sameKey = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

export function createLibraryStore(file: string): LibraryStore {
  async function load(): Promise<{ paths: string[]; newer: string | null }> {
    try {
      const raw = await readJson(file);
      const newer = newerThanThisBuild(raw, 'aio.library', 'library.json');
      if (newer) {
        console.warn(newer);
        return { paths: [], newer };
      }
      const r = LibraryFile.safeParse(raw);
      return { paths: r.success ? r.data.paths : [], newer: null };
    } catch (e) {
      console.warn(`Library file ${file} is unreadable, ignoring it: ${String(e)}`);
      return { paths: [], newer: null };
    }
  }
  // add and remove read, change and write the file one at a time, so neither drops the other's
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (run: () => Promise<void>): Promise<void> => {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    paths: async () => (await load()).paths,
    add: (path) =>
      serial(async () => {
        const current = await load();
        if (current.newer) throw new Error(current.newer);
        if (current.paths.some((p) => sameKey(p) === sameKey(path))) return;
        await writeJsonAtomic(file, {
          schema: LIBRARY_SCHEMA,
          paths: [...current.paths, resolve(path)],
        });
      }),
    remove: (path) =>
      serial(async () => {
        const current = await load();
        if (current.newer) throw new Error(current.newer);
        const paths = current.paths.filter((p) => sameKey(p) !== sameKey(path));
        if (paths.length === current.paths.length) return;
        await writeJsonAtomic(file, { schema: LIBRARY_SCHEMA, paths });
      }),
  };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

const isPackageFile = (p: string) => p.toLowerCase().endsWith(PACKAGE_EXTENSION);

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

/** Summary fields shared by folders and packages. */
function summarise(m: ProjectManifest, entry: LibraryEntry): LibraryEntry {
  const layerCounts: Record<string, number> = {};
  for (const l of m.layers) layerCounts[l.kind] = (layerCounts[l.kind] ?? 0) + 1;
  const captureDate = m.captures
    .map((c) => c.date)
    .sort()
    .at(-1);
  const out: LibraryEntry = { ...entry, name: m.name, layerCounts };
  if (m.customer !== undefined) out.customer = m.customer;
  if (m.site !== undefined) out.site = m.site;
  if (captureDate !== undefined) out.captureDate = captureDate;
  const purpose = projectPurpose(m);
  if (purpose !== undefined) out.purpose = purpose;
  return out;
}

/** `?v=<mtime>` so a changed picture gets a new URL (the renderer caches by URL). */
const stamp = (mtimeMs: number) => `?v=${String(Math.round(mtimeMs))}`;

async function mtimeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** A package's thumbnail URL, stamped with the package file's mtime (a re-export changes it). */
async function packageThumbnail(id: string, file: string): Promise<string> {
  return `aio://project/${id}/thumbnail.jpg${stamp((await mtimeOf(file)) ?? 0)}`;
}

/**
 * A `.aio` package. Plain packages are opened (directory and manifest only) and registered so
 * their thumbnail streams from inside; encrypted ones show by file name until unlocked.
 */
async function buildPackageEntry(file: string, registry: ProjectRegistry): Promise<Built> {
  const fallbackName = basename(file).slice(0, -PACKAGE_EXTENSION.length);
  let encrypted: boolean;
  let sizeBytes: number;
  try {
    const zip = await openZip(file);
    encrypted = zip.encrypted;
    sizeBytes = zip.sizeBytes;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (encrypted) {
    const id = registry.register(file);
    // Unlocked earlier in this session: show it like a plain package.
    const unlocked = registry.package(id);
    if (unlocked) {
      const entry = summarise(unlocked.manifest, {
        id,
        name: fallbackName,
        path: file,
        kind: 'native',
        sizeBytes,
        package: { encrypted: true, readOnly: unlocked.header.readOnly },
      });
      if (unlocked.archive.entries.has('thumbnail.jpg')) {
        entry.thumbnail = await packageThumbnail(id, file);
      }
      return { ok: true, entry };
    }
    return {
      ok: true,
      entry: {
        id,
        name: fallbackName,
        path: file,
        kind: 'native',
        sizeBytes,
        package: { encrypted: true, readOnly: true },
      },
    };
  }
  const r = await openPackage(file);
  if (!r.ok) return r;
  const { archive, header, manifest } = r.value;
  const id = registry.registerPackage({ file, archive, header, manifest });
  const entry = summarise(manifest, {
    id,
    name: fallbackName,
    path: file,
    kind: 'native',
    sizeBytes,
    package: { encrypted: false, readOnly: header.readOnly },
  });
  if (archive.entries.has('thumbnail.jpg')) entry.thumbnail = await packageThumbnail(id, file);
  return { ok: true, entry };
}

async function buildEntry(dir: string, registry: ProjectRegistry): Promise<Built> {
  if (isPackageFile(dir) && (await isFile(dir))) return buildPackageEntry(dir, registry);
  const kind = await detectFolder(dir);
  if (kind === null) {
    return {
      ok: false,
      error: `${dir} is not a ${brand.productName} project or a known kit export. Pick the folder that holds manifest.json.`,
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
  const id = registry.register(dir);
  const entry = summarise(manifest.value, {
    id,
    name: manifest.value.name,
    path: dir,
    kind: 'native',
    sizeBytes: await folderSize(dir),
  });
  const thumbTime = await mtimeOf(join(dir, 'thumbnail.jpg'));
  if (thumbTime !== null) entry.thumbnail = `aio://project/${id}/thumbnail.jpg${stamp(thumbTime)}`;
  // Change thumbnail kept the project's own picture beside the new one (covers.ts)
  if ((await mtimeOf(join(dir, THUMBNAIL_ORIGINAL))) !== null) entry.customCover = true;
  return { ok: true, entry };
}

/** Projects and `.aio` packages under `<dataRoot>/projects/*` plus folders and packages the person added. */
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
      else if (e.isFile() && isPackageFile(e.name)) candidates.push(dir);
    }
  } catch {
    // No projects folder yet: only user-added folders.
  }
  for (const p of o.extraPaths) {
    if ((await isDir(p)) || (isPackageFile(p) && (await isFile(p)))) candidates.push(resolve(p));
  }

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

/** What a Flyability Inspector export folder is called where the app names folder kinds. */
export const INSPECTOR_LABEL = 'Flyability Inspector export';

/**
 * A Flyability Inspector export dropped on the library: a project for it (local frame, the
 * confined-space template) named after the asset, else the folder. The picker then asks which
 * inspections to import into it. Null when the folder is not an export.
 */
async function projectForInspectorExport(
  dir: string,
  dataRoot: string,
  packVersion: () => Promise<string | null>,
): Promise<{ root: string } | { error: string } | null> {
  const lib = await import('@aio/project/builder');
  const found = await lib.findInspectorExport(dir);
  if (found === null) return null;
  if (!dataRoot)
    return { error: `${INSPECTOR_LABEL}: set a data folder in Settings first; projects go there.` };
  // the processing tools read the export: without them (or too old) no project is made
  const version = await packVersion().catch(() => null);
  if (version === null)
    return {
      error: `${INSPECTOR_LABEL}: the processing tools are not installed. Install them in Settings, Processing tools, then add the folder again.`,
    };
  if (version !== 'dev' && compareVersions(version, FLYABILITY_MIN_PACK) < 0)
    return {
      error: `${INSPECTOR_LABEL}: ${String(flyabilityPackRefusal('flyability.import', version))}`,
    };
  try {
    const scan = await lib.scanInspectorExport(found, null);
    const asset = (scan.asset ?? '').trim();
    const made = await lib.createProject(
      dataRoot,
      {
        name: asset === '' ? basename(dir) : asset,
        type: 'inspection',
        purpose: 'confined-space',
        epsg: 4326,
        origin: [0, 0, 0],
        severityTemplate: null,
      },
      lib.CONFINED_SPACE_TEMPLATE,
      { local: 'flyability' },
    );
    return { root: made.root };
  } catch (e) {
    return { error: `${INSPECTOR_LABEL}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function addToLibrary(
  path: string,
  store: LibraryStore,
  registry: ProjectRegistry,
  dataRoot = '',
  packVersion: () => Promise<string | null> = () => Promise.resolve('dev'),
  flyabilityUi?: boolean,
): Promise<IpcResponse<'library:add'>> {
  const dir = resolve(path);
  if (!(await isDir(dir)) && !(isPackageFile(dir) && (await isFile(dir)))) {
    return {
      ok: false,
      error: `Not found: ${dir}. Pick an existing project folder or ${PACKAGE_EXTENSION} package.`,
    };
  }
  let target = dir;
  if (
    (flyabilityUi ?? (await import('@aio/project/builder')).FLYABILITY_IMPORT_UI) &&
    (await isDir(dir)) &&
    (await detectFolder(dir)) === null
  ) {
    const made = await projectForInspectorExport(dir, dataRoot, packVersion);
    if (made !== null) {
      if ('error' in made) return { ok: false, error: made.error };
      target = made.root;
    }
  }
  const created = target !== dir;
  // a project made for an export is removed again when it cannot be listed
  const undo = () => (created ? rm(target, { recursive: true, force: true }) : Promise.resolve());
  const r = await buildEntry(target, registry);
  if (!r.ok) {
    await undo();
    return r;
  }
  try {
    await store.add(target);
  } catch (e) {
    await undo();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
