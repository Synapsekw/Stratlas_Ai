/**
 * 3D Tiles of a project (M10 stream G7): `<project>/tilesets.json` (`aio.tilesets/1`,
 * data-conventions section 22) read and written atomically with a `.bak`, refused for packages.
 * Tilesets are made by the `tiles.mesh` and `tiles.cloud` pipelines (which add their own entry) or
 * imported from other software (`tilesets:import`, checked and copied by `tilesetImport.ts`); the
 * site view and the Globe read the list from here.
 */
import {
  TILES_DIR,
  TILESETS_FILE,
  TilesetsFile,
  emptyTilesets,
  type IpcRequest,
  type IpcResponse,
} from '@aio/schema';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, seenFiles, writeJsonSeen } from './fsutil';
import type { Handle } from './notYet';
import {
  copyTileset,
  defaultName,
  importedEntry,
  planImport,
  TilesetImportError,
  tilesetIdFrom,
  type ImportPlan,
} from './tilesetImport';

/** The slice of an open `.aio` package this module reads. */
export interface PackageMembers {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

export interface TilesetsIpcDeps {
  handle: Handle;
  /** The folder of an open project, or undefined. */
  projectRoot: (projectId: string) => string | undefined;
  /** The archive of an open package (read-only), or undefined. */
  projectPackage: (projectId: string) => PackageMembers | undefined;
}

type ListResponse = IpcResponse<'tilesets:list'>;

function parse(raw: unknown, where: string): ListResponse {
  if (raw === undefined) return { ok: true, file: emptyTilesets() };
  const r = TilesetsFile.safeParse(raw);
  if (r.success) return { ok: true, file: r.data };
  const first = r.error.issues[0];
  const at = first?.path.length ? ` at ${first.path.join('.')}` : '';
  return { ok: false, error: `${where} is invalid${at}: ${first?.message ?? 'unknown error'}` };
}

/** `<root>/tilesets.json`, remembered so a later write notices someone else's change. */
export async function readTilesetsFile(root: string): Promise<ListResponse> {
  const file = join(root, TILESETS_FILE);
  let raw: unknown;
  try {
    raw = await readJsonSeen(file, seenFiles);
  } catch (e) {
    return { ok: false, error: `Could not read ${file}: ${String(e)}` };
  }
  return parse(raw, file);
}

export async function readPackageTilesets(pkg: PackageMembers): Promise<ListResponse> {
  if (!pkg.entries.has(TILESETS_FILE)) return { ok: true, file: emptyTilesets() };
  let raw: unknown;
  try {
    raw = JSON.parse((await pkg.read(TILESETS_FILE)).toString('utf8'));
  } catch (e) {
    return { ok: false, error: `Could not read ${TILESETS_FILE} from the package: ${String(e)}` };
  }
  return parse(raw, TILESETS_FILE);
}

/** Write `<root>/tilesets.json` atomically, the previous file kept as `tilesets.json.bak`. */
export async function writeTilesetsFile(
  root: string,
  file: TilesetsFile,
): Promise<IpcResponse<'tilesets:write'>> {
  const path = join(root, TILESETS_FILE);
  try {
    await writeJsonSeen(path, file, { backup: true, name: TILESETS_FILE });
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `Could not save ${path}: ${String(e)}` };
  }
  return { ok: true };
}

/**
 * Import a tileset from another program into `<root>/tiles/<id>/` and list it (`imported`).
 * Nothing is copied unless every check passes; the copy is removed when the list cannot be saved.
 */
export async function importTileset(
  root: string,
  req: Omit<IpcRequest<'tilesets:import'>, 'projectId'>,
): Promise<IpcResponse<'tilesets:import'>> {
  const listed = await readTilesetsFile(root);
  if (!listed.ok) return listed;
  let plan: ImportPlan;
  try {
    plan = await planImport(req.path, root);
  } catch (e) {
    if (e instanceof TilesetImportError) return { ok: false, error: e.message };
    return { ok: false, error: `Could not read the 3D Tiles: ${String(e)}` };
  }
  const name = req.name?.trim().length ? req.name.trim() : defaultName(req.path);
  const folders = await readdir(join(root, TILES_DIR)).catch(() => [] as string[]);
  const id = tilesetIdFrom(name, new Set([...listed.file.entries.map((e) => e.id), ...folders]));
  let dest: string;
  try {
    dest = await copyTileset(plan, root, id);
  } catch (e) {
    return { ok: false, error: `Could not copy the 3D Tiles into the project: ${String(e)}` };
  }
  const entry = importedEntry(id, name, plan, req.attribution?.trim());
  const parsed = TilesetsFile.safeParse({
    ...listed.file,
    entries: [...listed.file.entries, entry],
  });
  const saved = parsed.success
    ? await writeTilesetsFile(root, parsed.data)
    : { ok: false as const, error: parsed.error.issues[0]?.message ?? 'Invalid tileset entry' };
  if (!saved.ok) {
    await rm(dest, { recursive: true, force: true });
    return saved;
  }
  return { ok: true, entry };
}

export function registerTilesetsIpc({
  handle,
  projectRoot,
  projectPackage,
}: TilesetsIpcDeps): void {
  handle('tilesets:list', ({ projectId }) => {
    const root = projectRoot(projectId);
    if (root !== undefined) return readTilesetsFile(root);
    const pkg = projectPackage(projectId);
    if (pkg) return readPackageTilesets(pkg);
    return { ok: false, error: `Project "${projectId}" is not open.` };
  });
  handle('tilesets:write', ({ projectId, file }) => {
    if (projectPackage(projectId))
      return {
        ok: false,
        code: 'read-only',
        error: 'This project is a read-only package. Its 3D Tiles cannot be changed.',
      };
    const root = projectRoot(projectId);
    if (root === undefined)
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
    return writeTilesetsFile(root, file);
  });
  handle('tilesets:import', ({ projectId, ...req }) => {
    if (projectPackage(projectId))
      return {
        ok: false,
        code: 'read-only',
        error: 'This project is a read-only package. 3D Tiles cannot be imported into it.',
      };
    const root = projectRoot(projectId);
    if (root === undefined)
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
    return importTileset(root, req);
  });
}
