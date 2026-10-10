/**
 * The menu of one project on the Projects screen: show its folder, rename it, move it to the
 * recycle bin (`library:reveal`, `library:rename`, `library:delete`).
 *
 * The renderer names a project by its library id only; the folder comes from the registry. Rename
 * and delete then work on one kind of folder alone: a real folder (not a link) directly inside
 * `<data folder>/projects` that holds a `manifest.json`. Packages, the demo projects that ship
 * with the app and folders added from elsewhere are refused with a sentence that says why.
 *
 * Rename changes `name` in `manifest.json` and nothing else: the folder on disk and the project
 * id keep their names (the id comes from the folder, and every path in the project is relative).
 * Delete moves the whole folder to the recycle bin, never removes it for good.
 */
import { PACKAGE_EXTENSION, parseManifest, type IpcResponse } from '@aio/schema';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import type { Handle } from './notYet';
import { assertWritable } from './realDataGuard';

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** The same file or folder by name (case ignored on Windows). */
export const samePath = (a: string, b: string) => fold(resolve(a)) === fold(resolve(b));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (error: string) => ({ ok: false as const, error });

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export type ManagedFolder = { ok: true; root: string } | { ok: false; error: string };

/**
 * Is `path` a project folder the app may rename or move to the recycle bin? It must be a real
 * folder (not a link or junction) directly inside `<dataRoot>/projects` that holds a
 * `manifest.json`. Never the data folder itself, `projects`, or a place reached through `..`.
 */
export async function managedProjectFolder(dataRoot: string, path: string): Promise<ManagedFolder> {
  if (dataRoot.trim() === '') return fail('No data folder is set. Choose one in Settings first.');
  const projects = resolve(dataRoot, 'projects');
  const root = resolve(path);
  const outside = fail(
    `${root} is not a project folder inside ${projects}. Only projects kept in the data folder can be renamed or deleted here.`,
  );
  if (!samePath(dirname(root), projects) || basename(root) === '') return outside;
  let info;
  try {
    info = await lstat(root);
  } catch {
    return fail(`Folder not found: ${root}. It may have been moved or deleted already.`);
  }
  if (info.isSymbolicLink())
    return fail(
      `${root} is a link to a folder somewhere else. Rename or delete that folder in the file manager.`,
    );
  if (!info.isDirectory()) return fail(`${root} is not a folder.`);
  // a link higher up, or a short name: where the folder really is must be inside projects too
  try {
    const [realRoot, realProjects] = await Promise.all([realpath(root), realpath(projects)]);
    if (!samePath(dirname(realRoot), realProjects)) return outside;
  } catch (e) {
    return fail(`Could not check ${root}: ${errorText(e)}`);
  }
  if (!(await isFile(join(root, 'manifest.json'))))
    return fail(`${root} holds no manifest.json, so it is not a project folder.`);
  return { ok: true, root };
}

/**
 * Set `name` in `<root>/manifest.json`, keeping the previous file as `manifest.json.bak`. Every
 * other key of the file is written back as it was read, also the ones this build does not know.
 */
export async function renameProject(
  root: string,
  name: string,
): Promise<IpcResponse<'library:rename'>> {
  const next = name.trim();
  if (next === '') return fail('A project needs a name.');
  const file = join(root, 'manifest.json');
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (e) {
    return fail(`Could not read ${file}: ${errorText(e)}`);
  }
  if (raw === undefined) return fail(`No manifest.json in ${root}.`);
  const parsed = parseManifest(raw);
  if (!parsed.ok) return fail(`${file}: ${parsed.error}`);
  if (parsed.value.name === next) return { ok: true, name: next };
  try {
    await writeJsonAtomic(
      file,
      { ...(raw as Record<string, unknown>), name: next },
      { backup: true },
    );
  } catch (e) {
    return fail(`Could not save ${file}: ${errorText(e)}`);
  }
  return { ok: true, name: next };
}

export interface DeleteDeps {
  /** Move a folder to the recycle bin (Electron `shell.trashItem`); rejects when it cannot. */
  trash: (path: string) => Promise<void>;
  /** Close what this process keeps open in the folder (the journal's segment) before the move. */
  release?: (root: string) => Promise<void>;
  /** After the folder is gone: drop what the app remembers of it. */
  forget?: (root: string) => Promise<void>;
}

/** Move the project folder `root` to the recycle bin. A failure leaves the folder where it is. */
export async function deleteProject(
  root: string,
  deps: DeleteDeps,
): Promise<IpcResponse<'library:delete'>> {
  const name = basename(root);
  try {
    // the recycle bin is not an fs call: ask the e2e real-data guard by hand (realDataGuard.ts)
    assertWritable(root, 'move to the recycle bin');
    await deps.release?.(root);
    await deps.trash(root);
  } catch (e) {
    return fail(
      `The project folder ${name} could not be moved to the recycle bin: ${errorText(e)}. Nothing was deleted. Close any program that has files of the project open, then try again.`,
    );
  }
  if (await exists(root))
    return fail(
      `The project folder ${name} is still in ${dirname(root)}: the recycle bin did not take it. Nothing was deleted.`,
    );
  try {
    await deps.forget?.(root);
  } catch (e) {
    console.warn(`Library: could not forget ${root} after deleting it (${errorText(e)}).`);
  }
  return { ok: true };
}

export interface LibraryActionsDeps {
  handle: Handle;
  /** Where a library id points: a project folder or a `.aio` file. */
  projects: { path(id: string): string | undefined; package(id: string): unknown };
  dataRoot: () => string;
  /** Is this path one of the demo projects that ship with the app (or its working copy)? */
  isDemo?: (path: string) => Promise<boolean>;
  /** Does a pipeline job run in this project folder right now? */
  jobRunningIn?: (root: string) => boolean;
  /** Show a file or folder in the file manager (Electron `shell.showItemInFolder`). */
  reveal: (path: string) => void;
  /** A project was renamed (main keeps the names of the open ones). */
  renamed?: (projectId: string, name: string) => void;
  trash: DeleteDeps['trash'];
  release?: DeleteDeps['release'];
  forget?: DeleteDeps['forget'];
}

const isPackagePath = (p: string) => p.toLowerCase().endsWith(PACKAGE_EXTENSION);

export function registerLibraryActionsIpc(deps: LibraryActionsDeps): void {
  const { handle, projects } = deps;

  /** The folder of a library id when the app may rename or delete it, else why not. */
  async function managed(projectId: string, verb: 'renamed' | 'deleted'): Promise<ManagedFolder> {
    const path = projects.path(projectId);
    if (path === undefined)
      return fail(`There is no project "${projectId}" in the library. Reload the library.`);
    if (projects.package(projectId) !== undefined || isPackagePath(path))
      return fail(
        `${basename(path)} is a package, a single read-only file. It cannot be ${verb} here.`,
      );
    if (await deps.isDemo?.(path))
      return fail(`This is a demo project that ships with the app. It cannot be ${verb}.`);
    return managedProjectFolder(deps.dataRoot(), path);
  }

  handle('library:reveal', async ({ projectId }) => {
    const path = projects.path(projectId);
    if (path === undefined)
      return fail(`There is no project "${projectId}" in the library. Reload the library.`);
    if (!(await exists(path)))
      return fail(`Not found: ${path}. It may have been moved or deleted.`);
    deps.reveal(path);
    return { ok: true };
  });

  handle('library:rename', async ({ projectId, name }) => {
    const m = await managed(projectId, 'renamed');
    if (!m.ok) return m;
    const r = await renameProject(m.root, name);
    if (r.ok) deps.renamed?.(projectId, r.name);
    return r;
  });

  handle('library:delete', async ({ projectId }) => {
    const m = await managed(projectId, 'deleted');
    if (!m.ok) return m;
    if (deps.jobRunningIn?.(m.root))
      return fail(
        'A job is running in this project. Cancel it on the Jobs screen or wait for it to finish, then delete the project.',
      );
    return deleteProject(m.root, {
      trash: deps.trash,
      ...(deps.release ? { release: deps.release } : {}),
      ...(deps.forget ? { forget: deps.forget } : {}),
    });
  });
}
