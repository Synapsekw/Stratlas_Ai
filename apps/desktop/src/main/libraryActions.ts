/**
 * The menu of one project on the Projects screen: show its folder, rename it, take it out of the
 * library, move it to the recycle bin (`library:reveal`, `library:rename`, `library:remove`,
 * `library:delete`).
 *
 * The renderer names a project by its library id only; the path comes from the registry.
 *
 * Rename works on one kind of folder alone: a real folder (not a link) directly inside
 * `<data folder>/projects` that holds a `manifest.json`. Packages, the demo projects that ship
 * with the app and folders added from elsewhere are refused with a sentence that says why. It
 * changes `name` in `manifest.json` and nothing else: the folder on disk and the project id keep
 * their names (the id comes from the folder, and every path in the project is relative).
 *
 * Remove only hides the card on this computer (`library-view.json`); no file is touched.
 *
 * Delete takes any card (`deletableTarget` re-checks it on disk): a project folder or package in
 * the data folder, a folder or package added from elsewhere that `library.json` lists (never a
 * link, a drive root, or a folder that holds the data folder, userData, home or the app), and for
 * a demo its working copy, after which the demo is hidden. It always goes to the recycle bin
 * (`shell.trashItem`), never removed for good.
 */
import { PACKAGE_EXTENSION, parseManifest, type IpcResponse } from '@aio/schema';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import { detectFolder, type LibraryStore } from './library';
import { libraryKey, type LibraryViewStore } from './libraryView';
import type { Handle } from './notYet';
import { assertWritable } from './realDataGuard';

/**
 * The builder library loads on first use, as in builder.ts: a static import of it makes the main
 * bundle come out empty (rolldown, vite 8).
 */
const lib = () => import('@aio/project/builder');

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** The same file or folder by name (case ignored on Windows). */
export const samePath = (a: string, b: string) => fold(resolve(a)) === fold(resolve(b));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (error: string) => ({ ok: false as const, error });
const isPackagePath = (p: string) => p.toLowerCase().endsWith(PACKAGE_EXTENSION);

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

export type DeleteTarget =
  | { ok: true; path: string; what: 'folder' | 'package' | 'demo-copy' | 'nothing' }
  | { ok: false; error: string };

/** Is `inner` the same as `outer` or somewhere inside it (case ignored on Windows)? */
function within(inner: string, outer: string): boolean {
  const rel = relative(fold(resolve(outer)), fold(resolve(inner)));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The folder as written and, when it exists, where it really is (links, short names). */
async function spellings(p: string): Promise<string[]> {
  try {
    return [resolve(p), await realpath(p)];
  } catch {
    return [resolve(p)];
  }
}

/**
 * Every folder that must never go to the recycle bin with `path`: `path` must not be any of them
 * nor hold one. Checked on the name as written and on where both really are.
 */
async function holdsGuarded(path: string, roots: string[]): Promise<string | null> {
  const mine = await spellings(path);
  for (const root of roots) {
    if (root.trim() === '') continue;
    for (const g of await spellings(root)) if (mine.some((m) => within(g, m))) return resolve(root);
  }
  return null;
}

async function packageFile(path: string): Promise<DeleteTarget> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return fail(`${path} was not found. It may have been moved or deleted already.`);
  }
  if (info.isSymbolicLink())
    return fail(
      `${path} is a link to a file somewhere else. Delete that file in the file manager.`,
    );
  if (!info.isFile()) return fail(`${path} is not a package file.`);
  return { ok: true, path, what: 'package' };
}

/**
 * What a delete of the library entry at `path` moves to the recycle bin, checked on disk now.
 *
 * A demo (`demoCopy` not undefined): its working copy in userData, or nothing when there is none.
 * Directly in `<dataRoot>/projects`: a `.aio` file, or a folder `managedProjectFolder` accepts.
 * Anywhere else the path must be listed in `library.json`, must not be a link or a drive root,
 * must not be or hold the data folder or a guard root, and must be a `.aio` file or a folder
 * that holds a project (`detectFolder`: our manifest or a known kit export).
 */
export async function deletableTarget(o: {
  path: string;
  dataRoot: string;
  listed: string[];
  demoCopy: string | null | undefined;
  guardRoots: string[];
}): Promise<DeleteTarget> {
  const path = resolve(o.path);
  const guarded = [o.dataRoot, ...o.guardRoots];

  if (o.demoCopy !== undefined) {
    if (o.demoCopy === null) return { ok: true, path, what: 'nothing' };
    const copy = resolve(o.demoCopy);
    let info;
    try {
      info = await lstat(copy);
    } catch {
      return { ok: true, path, what: 'nothing' };
    }
    if (info.isSymbolicLink() || !info.isDirectory() || dirname(copy) === copy)
      return fail(`${copy} is not the working copy folder of a demo. Nothing was deleted.`);
    const held = await holdsGuarded(copy, guarded);
    if (held !== null)
      return fail(`${copy} is or holds ${held}, a folder the app needs. It is never deleted.`);
    return { ok: true, path: copy, what: 'demo-copy' };
  }

  if (o.dataRoot.trim() !== '' && samePath(dirname(path), resolve(o.dataRoot, 'projects'))) {
    if (isPackagePath(path)) return packageFile(path);
    const m = await managedProjectFolder(o.dataRoot, path);
    return m.ok ? { ok: true, path: m.root, what: 'folder' } : m;
  }

  if (!o.listed.some((l) => samePath(l, path)))
    return fail(
      `${path} is not in the data folder and was not added to the library, so it is not deleted here. Reload the library.`,
    );
  let info;
  try {
    info = await lstat(path);
  } catch {
    return fail(`${path} was not found. It may have been moved or deleted already.`);
  }
  if (info.isSymbolicLink())
    return fail(
      `${path} is a link to somewhere else. Delete what it points to in the file manager.`,
    );
  const real = (await spellings(path)).at(-1) ?? path;
  if (dirname(path) === path || dirname(real) === real)
    return fail(`${path} is the root of a drive. It is never deleted.`);
  const held = await holdsGuarded(path, guarded);
  if (held !== null)
    return fail(`${path} is or holds ${held}, a folder the app needs. It is never deleted.`);
  if (info.isFile() && isPackagePath(path)) return { ok: true, path, what: 'package' };
  if (!info.isDirectory()) return fail(`${path} is not a project folder or a package.`);
  if ((await detectFolder(path)) === null)
    return fail(
      `${path} holds no project (no manifest.json and no known kit export), so it is not deleted here.`,
    );
  return { ok: true, path, what: 'folder' };
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
  // read and written in one turn among the builder's saves of this manifest, so neither a rename
  // nor a save made at the same moment (a survey date, a layer) replaces the other. The write
  // stays `writeJsonAtomic` of the file as read: the builder's own save keeps known keys only.
  const { withManifest } = await lib();
  return withManifest(root, async (): Promise<IpcResponse<'library:rename'>> => {
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
  });
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
  /** Cards this computer hides, and what it forgets of a deleted one. */
  view: Pick<LibraryViewStore, 'hide' | 'forget'>;
  /** Folders and packages added to the library (userData `library.json`). */
  store: Pick<LibraryStore, 'paths' | 'remove'>;
  /** Working copy of a demo entry (userData demo/<id>) or null when none; undefined: not a demo. */
  demoCopy?: (path: string) => Promise<string | null | undefined>;
  /** Folders never deleted, nor any folder holding one: userData, home, app, resources. */
  guardRoots: () => string[];
  /** Drop the per-computer cover of a library key. */
  dropCover?: (key: string) => Promise<void>;
  /** Drop the opened package of a library id. */
  forgetPackage?: (projectId: string) => void;
}

/** A step after a delete: a failure is logged, the delete still counts. */
async function bestEffort(what: string, step: () => Promise<void> | void): Promise<void> {
  try {
    await step();
  } catch (e) {
    console.warn(`Library: could not ${what} after deleting it (${errorText(e)}).`);
  }
}

const JOB_RUNNING =
  'A job is running in this project. Cancel it in Processing (the title bar chip; a project that is not open shows it under Running in other projects) or wait for it to finish, then delete the project.';

export function registerLibraryActionsIpc(deps: LibraryActionsDeps): void {
  const { handle, projects } = deps;

  const unknown = (projectId: string) =>
    fail(`There is no project "${projectId}" in the library. Reload the library.`);

  /** The folder of a library id when the app may rename it, else why not. */
  async function managed(projectId: string, verb: 'renamed'): Promise<ManagedFolder> {
    const path = projects.path(projectId);
    if (path === undefined) return unknown(projectId);
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

  // take the card out of the library on this computer: hidden by its key, no file touched
  handle('library:remove', async ({ projectId }) => {
    const path = projects.path(projectId);
    if (path === undefined) return unknown(projectId);
    const demo = (await deps.isDemo?.(path)) ?? false;
    try {
      await deps.view.hide(libraryKey(path, demo));
    } catch (e) {
      return fail(`${basename(path)} could not be removed from the library: ${errorText(e)}`);
    }
    return { ok: true };
  });

  handle('library:delete', async ({ projectId }) => {
    const path = projects.path(projectId);
    if (path === undefined) return unknown(projectId);
    const isDemo = (await deps.isDemo?.(path)) ?? false;
    let demoCopy = deps.demoCopy ? await deps.demoCopy(path) : undefined;
    // a demo whose copy nobody can name: hide it, delete nothing
    if (demoCopy === undefined && isDemo) demoCopy = null;
    const demo = demoCopy !== undefined;
    let listed: string[];
    try {
      listed = await deps.store.paths();
    } catch (e) {
      return fail(`Could not read the library list: ${errorText(e)}. Nothing was deleted.`);
    }
    const target = await deletableTarget({
      path,
      dataRoot: deps.dataRoot(),
      listed,
      demoCopy,
      guardRoots: deps.guardRoots(),
    });
    if (!target.ok) return target;
    const folder = target.what === 'folder' || target.what === 'demo-copy';
    if (folder && (deps.jobRunningIn?.(target.path) || deps.jobRunningIn?.(path)))
      return fail(JOB_RUNNING);
    if (target.what !== 'nothing') {
      const r = await deleteProject(target.path, {
        trash: deps.trash,
        ...(folder && deps.release ? { release: deps.release } : {}),
        ...(folder && deps.forget ? { forget: deps.forget } : {}),
      });
      if (!r.ok) return r;
    }
    const key = libraryKey(path, demo);
    await bestEffort(`drop ${path} from library.json`, () => deps.store.remove(path));
    await bestEffort(`forget the card of ${path}`, () => deps.view.forget(key));
    const { dropCover, forgetPackage } = deps;
    if (dropCover) await bestEffort(`drop the cover of ${path}`, () => dropCover(key));
    if (forgetPackage)
      await bestEffort(`forget package ${projectId}`, () => {
        forgetPackage(projectId);
      });
    // the bundled demo stays where the app put it: hidden, so it does not come back
    if (demo) await bestEffort(`hide the demo ${path}`, () => deps.view.hide(key));
    return { ok: true };
  });
}
