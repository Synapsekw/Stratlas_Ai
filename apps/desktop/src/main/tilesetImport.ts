/**
 * **Import 3D Tiles** (M10 G7 follow-up, IPC `tilesets:import`): a tileset exported by another
 * program (Bentley, Pix4D, DJI Terra, Cesium tools) becomes an `imported` entry of the project's
 * `tilesets.json`, its folder copied to `<project>/tiles/<id>/`.
 *
 * What is checked before anything is copied (the folder is someone else's export, so it is
 * treated as untrusted):
 *
 * - the root and every external tileset JSON it references parse, are 3D Tiles 1.0 or 1.1
 *   (`asset.version`), have a `root` tile with a bounding volume and a geometric error, and stay
 *   under the size caps (`IMPORT_LIMITS`);
 * - every URI they name (tile contents, external tilesets, implicit tiling subtrees, the metadata
 *   schema) is relative and stays inside the root's folder: absolute paths, drive letters and any
 *   scheme (`http:`, `file:`, `data:`) are refused, so the copy never reaches outside the folder
 *   and the tiles never ask for the network; a named file must exist (template URIs of implicit
 *   tiling are checked for their path only);
 * - the folder holds no links (a link could point anywhere), and its file count and size are
 *   capped; a folder that holds the project itself is refused.
 *
 * Placement: ours and most exports carry an ECEF root (a root `transform`, or a root box, in Earth
 * centred coordinates), which the site view and the Globe place through the project CRS. Such a
 * tileset is listed visible. One in a local frame has nothing to place it by: it is listed hidden
 * until a person places it (`transform`, `confirmedAt`; the placement step is not built yet).
 */
import { TILES_DIR, TilesetId, type TilesetEntry } from '@aio/schema';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';

export const IMPORT_LIMITS = {
  /** One tileset JSON (the root or an external one). */
  jsonBytes: 64 * 1024 * 1024,
  /** Tileset JSON files read (the root and the external tilesets it references). */
  jsonFiles: 5_000,
  /** Tiles across all of them. */
  tiles: 2_000_000,
  /** Files in the folder. */
  files: 250_000,
  /** Bytes in the folder. */
  bytes: 64 * 1024 ** 3,
} as const;

export class TilesetImportError extends Error {}

const refuse = (message: string): never => {
  throw new TilesetImportError(message);
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const nums = (v: unknown, n: number): number[] | null =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? (v as number[])
    : null;

/** Implicit tiling template variables (3D Tiles 1.1). */
const TEMPLATE = /\{(level|x|y|z)\}/;

/**
 * A URI named in a tileset JSON at `fromDir` (posix, relative to the root folder) as a path
 * relative to the root folder; refused when absolute, with a scheme, or outside the folder.
 */
export function insideUri(uri: unknown, fromDir: string, where: string): string {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048)
    return refuse(`${where} names an empty or overlong URI.`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || /^[\\/]/.test(uri))
    return refuse(`${where} points outside the tileset folder (${uri.slice(0, 120)}).`);
  const bare = uri.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return refuse(`${where} names a URI that is not valid (${uri.slice(0, 120)}).`);
  }
  if (decoded.includes('\0')) return refuse(`${where} names a URI that is not valid.`);
  const p = posix.normalize(posix.join(fromDir, decoded.replace(/\\/g, '/')));
  if (p === '..' || p.startsWith('../') || posix.isAbsolute(p) || /^[A-Za-z]:/.test(p))
    return refuse(`${where} points outside the tileset folder (${uri.slice(0, 120)}).`);
  return p;
}

/** Earth-centred: a translation between 6200 and 6500 km from the centre. */
const ecefScale = (x: number, y: number, z: number): boolean => {
  const d = Math.hypot(x, y, z);
  return d > 6.2e6 && d < 6.5e6;
};

/** True when the root tile sits in Earth centred coordinates (placed through the project CRS). */
export function ecefRoot(root: unknown): boolean {
  if (!isObj(root)) return false;
  const t = nums(root.transform, 16);
  if (t) return ecefScale(t[12] ?? 0, t[13] ?? 0, t[14] ?? 0);
  const bv = isObj(root.boundingVolume) ? root.boundingVolume : {};
  const box = nums(bv.box, 12);
  if (box) return ecefScale(box[0] ?? 0, box[1] ?? 0, box[2] ?? 0);
  const sphere = nums(bv.sphere, 4);
  if (sphere) return ecefScale(sphere[0] ?? 0, sphere[1] ?? 0, sphere[2] ?? 0);
  return false;
}

export interface FolderFile {
  /** Posix path relative to the folder. */
  rel: string;
  size: number;
}

/** Every file below `dir` (no links), within the caps. */
export async function listFolder(dir: string): Promise<FolderFile[]> {
  const out: FolderFile[] = [];
  let bytes = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    const items = await readdir(abs, { withFileTypes: true });
    for (const d of items) {
      const childAbs = join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      // lstat: a link (or a Windows junction) is never followed
      const s = await lstat(childAbs);
      if (s.isSymbolicLink())
        refuse(`The tileset folder holds a link (${childRel}); copy the real files instead.`);
      if (s.isDirectory()) await walk(childAbs, childRel);
      else if (s.isFile()) {
        out.push({ rel: childRel, size: s.size });
        bytes += s.size;
        if (out.length > IMPORT_LIMITS.files)
          refuse(`The tileset folder holds more than ${String(IMPORT_LIMITS.files)} files.`);
        if (bytes > IMPORT_LIMITS.bytes)
          refuse(
            `The tileset folder is larger than ${String(IMPORT_LIMITS.bytes / 1024 ** 3)} GB.`,
          );
      }
    }
  };
  await walk(dir, '');
  return out;
}

export interface CheckedTileset {
  /** The 3D Tiles version of the root (`1.0` or `1.1`). */
  version: string;
  /** Placed by its own Earth centred root. */
  ecef: boolean;
  /** Tileset JSON files read (root first). */
  jsonFiles: string[];
  tiles: number;
}

/**
 * Check the root tileset (`rootRel` inside `dir`) and every external tileset it references
 * against the folder's files.
 */
export async function checkTileset(
  dir: string,
  rootRel: string,
  files: ReadonlySet<string>,
): Promise<CheckedTileset> {
  const seen = new Set<string>();
  const queue = [rootRel];
  let tiles = 0;
  let version = '';
  let ecef = false;
  while (queue.length) {
    const rel = queue.shift() ?? '';
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (seen.size > IMPORT_LIMITS.jsonFiles)
      refuse(`The tileset references more than ${String(IMPORT_LIMITS.jsonFiles)} tileset files.`);
    const abs = join(dir, ...rel.split('/'));
    const s = await stat(abs).catch(() => null);
    if (!s?.isFile()) return refuse(`${rel} is missing from the tileset folder.`);
    if (s.size > IMPORT_LIMITS.jsonBytes)
      refuse(`${rel} is larger than ${String(IMPORT_LIMITS.jsonBytes / 1024 ** 2)} MB.`);
    let doc: unknown;
    try {
      const text = (await readFile(abs)).toString('utf8');
      doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return refuse(`${rel} is not a JSON file.`);
    }
    if (!isObj(doc) || !isObj(doc.asset)) return refuse(`${rel} is not a 3D Tiles tileset.`);
    const v = doc.asset.version;
    if (v !== '1.0' && v !== '1.1')
      refuse(
        `${rel} is 3D Tiles version ${typeof v === 'string' ? `"${v.slice(0, 20)}"` : 'unknown'}; 1.0 and 1.1 can be imported.`,
      );
    if (!isObj(doc.root)) return refuse(`${rel} has no root tile.`);
    if (rel === rootRel) {
      version = String(v);
      ecef = ecefRoot(doc.root);
    }
    const from = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    const named = (uri: unknown, what: string, template = false) => {
      const p = insideUri(uri, from, `${rel} (${what})`);
      if (template || TEMPLATE.test(p)) return null;
      if (!files.has(p)) refuse(`${rel} names ${p}, which is not in the tileset folder.`);
      return p;
    };
    if (doc.schemaUri !== undefined) named(doc.schemaUri, 'metadata schema');
    const stack: unknown[] = [doc.root];
    while (stack.length) {
      const tile = stack.pop();
      if (!isObj(tile)) return refuse(`${rel} has a tile that is not an object.`);
      if (++tiles > IMPORT_LIMITS.tiles)
        refuse(`The tileset has more than ${String(IMPORT_LIMITS.tiles)} tiles.`);
      if (!isObj(tile.boundingVolume)) refuse(`${rel} has a tile without a bounding volume.`);
      if (typeof tile.geometricError !== 'number' || !Number.isFinite(tile.geometricError))
        refuse(`${rel} has a tile without a geometric error.`);
      const contents = [
        ...(isObj(tile.content) ? [tile.content] : []),
        ...(Array.isArray(tile.contents) ? (tile.contents as unknown[]) : []),
      ];
      const implicit = isObj(tile.implicitTiling) ? tile.implicitTiling : null;
      for (const c of contents) {
        if (!isObj(c)) return refuse(`${rel} has tile content that is not an object.`);
        // 3D Tiles 1.0 tilesets from older tools say `url`
        const uri = c.uri ?? c.url;
        const p = named(uri, 'tile content', implicit !== null);
        if (p && /\.json$/i.test(p)) queue.push(p);
      }
      if (implicit) {
        const subtrees = isObj(implicit.subtrees) ? implicit.subtrees : {};
        named(subtrees.uri, 'implicit tiling subtrees', true);
      }
      if (Array.isArray(tile.children)) stack.push(...(tile.children as unknown[]));
      else if (tile.children !== undefined) refuse(`${rel} has tile children that are not a list.`);
    }
  }
  return { version, ecef, jsonFiles: [...seen], tiles };
}

/** A tileset id from a name: file-name safe, unique among `taken` (compared ignoring case). */
export function tilesetIdFrom(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .replace(/-+$/, '')
      .slice(0, 60)
      .replace(/[^A-Za-z0-9]+$/, '') || 'tileset';
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let id = slug;
  for (let n = 2; lower.has(id.toLowerCase()); n++) id = `${slug}-${String(n)}`;
  return TilesetId.parse(id);
}

const same = (a: string) => (process.platform === 'win32' ? a.toLowerCase() : a);
/** True when `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const r = relative(same(resolve(parent)), same(resolve(child)));
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r));
}

export interface ImportPlan {
  srcDir: string;
  rootRel: string;
  files: FolderFile[];
  checked: CheckedTileset;
}

/** Everything checked before a byte is copied. */
export async function planImport(path: string, projectRoot: string): Promise<ImportPlan> {
  const rootFile = resolve(path);
  const srcDir = dirname(rootFile);
  const rootRel = basename(rootFile);
  if (!/\.json$/i.test(rootRel)) refuse('Pick the root tileset.json of the 3D Tiles.');
  const s = await lstat(rootFile).catch(() => null);
  if (!s?.isFile()) refuse(`${rootFile} does not exist.`);
  if (isInside(join(projectRoot, TILES_DIR), srcDir))
    refuse('That folder holds this project. Pick the folder of the 3D Tiles export.');
  const files = await listFolder(srcDir);
  const checked = await checkTileset(srcDir, rootRel, new Set(files.map((f) => f.rel)));
  return { srcDir, rootRel, files, checked };
}

/**
 * Copy the planned folder to `<projectRoot>/tiles/<id>/` through a temporary folder (renamed when
 * complete, removed on any failure).
 */
export async function copyTileset(plan: ImportPlan, projectRoot: string, id: string) {
  const tilesDir = join(projectRoot, TILES_DIR);
  const dest = join(tilesDir, id);
  const tmp = join(tilesDir, `.import-${id}-${String(process.pid)}-${String(Date.now())}`);
  await mkdir(tmp, { recursive: true });
  try {
    for (const f of plan.files) {
      const to = join(tmp, ...f.rel.split('/'));
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(plan.srcDir, ...f.rel.split('/')), to, constants.COPYFILE_EXCL);
    }
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

/** The new entry: visible when its own ECEF root places it, else hidden until placed. */
export function importedEntry(
  id: string,
  name: string,
  plan: ImportPlan,
  attribution?: string,
): TilesetEntry {
  return {
    id,
    name,
    kind: 'imported',
    src: `${TILES_DIR}/${id}/${plan.rootRel}`,
    visible: plan.checked.ecef,
    ...(attribution ? { attribution } : {}),
  };
}

/** The name of the folder holding the root (an export's folder is usually named for the site). */
export function defaultName(path: string): string {
  const folder = basename(dirname(resolve(path)));
  return folder && !/^[A-Za-z]:\\?$/.test(folder) ? folder.slice(0, 200) : 'Imported 3D Tiles';
}
