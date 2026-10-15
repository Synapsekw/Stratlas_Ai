/**
 * The library as this computer shows it, kept in userData `library-view.json`
 * (`aio.library-view/1`, beside `library.json`): cards the person removed from the library, the
 * library folders and which card sits in which folder. Nothing here touches a project.
 *
 * Cards are named by a library key (`libraryKey`): the resolved path, or `demo:<folder name>`
 * for a demo project, so the bundled demo and its working copy are one card, and a removed demo
 * stays removed after an update moves the app.
 *
 * Every write reads the file again and runs one at a time, so two quick moves both land. A file
 * saved by a newer build, or one that cannot be read or parsed, reads as empty and is never
 * written over. A missing file is empty and writable.
 */
import { LibraryFolder, type LibraryEntry } from '@aio/schema';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';
import { newerThanThisBuild } from './newer';
import type { Handle } from './notYet';

export const LIBRARY_VIEW_SCHEMA = 'aio.library-view/1';

export interface LibraryView {
  hidden: string[];
  folders: LibraryFolder[];
  /** library key -> folder id */
  placed: Record<string, string>;
}

/**
 * `newer`: saved by a newer build. `broken`: there but unreadable or not in the format (a lock
 * that outlasts one retry, cut-off JSON, a hand edit). Either way the view reads as empty and every
 * write is refused with that message, so the hidden list and the folders are never written over.
 */
export interface ViewRead {
  view: LibraryView;
  newer: string | null;
  broken: string | null;
}

export interface LibraryViewStore {
  read(): Promise<ViewRead>;
  hide(key: string): Promise<void>;
  unhide(key: string): Promise<void>;
  /** After a delete: drop the key from hidden and placed. */
  forget(key: string): Promise<void>;
  createFolder(name: string): Promise<LibraryFolder>;
  renameFolder(id: string, name: string): Promise<void>;
  /** Projects in it become loose. */
  deleteFolder(id: string): Promise<void>;
  move(key: string, folderId: string | null): Promise<void>;
}

const ViewFile = z.object({
  schema: z.literal(LIBRARY_VIEW_SCHEMA),
  hidden: z.array(z.string()).default([]),
  folders: z.array(LibraryFolder).default([]),
  placed: z.record(z.string(), z.string()).default({}),
});

const empty = (): LibraryView => ({ hidden: [], folders: [], placed: {} });

/** `f_` and 10 hex characters. */
const newFolderId = () => `f_${randomBytes(5).toString('hex')}`;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function checkName(view: LibraryView, name: string, except?: string): string {
  const next = name.trim();
  if (next === '') throw new Error('A folder needs a name.');
  if (view.folders.some((f) => f.id !== except && sameName(f.name, next)))
    throw new Error(`A folder called "${next}" already exists.`);
  return next;
}

const BROKEN =
  'The library view file (library-view.json) could not be read, so folders and removed cards ' +
  'are not shown and cannot be changed. Close any program using it and reload the library.';

/** Codes Windows gives a read of a file another process holds at that moment. */
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

const GONE = 'That folder is no longer in the library. Reload the library.';

export function createLibraryViewStore(file: string): LibraryViewStore {
  let chain: Promise<unknown> = Promise.resolve();

  /** Once more after a short wait when Windows has the file locked (antivirus, indexer). */
  async function readOnce(): Promise<unknown> {
    try {
      return await readJson(file);
    } catch (e) {
      if (!LOCKED.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 150));
      return readJson(file);
    }
  }

  async function load(): Promise<ViewRead> {
    const brokenRead = (why: string): ViewRead => {
      console.warn(`Library view file ${file} ${why}; it is left as it is.`);
      return { view: empty(), newer: null, broken: BROKEN };
    };
    let raw: unknown;
    try {
      raw = await readOnce();
    } catch (e) {
      return brokenRead(`is unreadable (${String(e)})`);
    }
    if (raw === undefined) return { view: empty(), newer: null, broken: null };
    const newer = newerThanThisBuild(raw, 'aio.library-view', 'library-view.json');
    if (newer) {
      console.warn(newer);
      return { view: empty(), newer, broken: null };
    }
    const r = ViewFile.safeParse(raw);
    if (!r.success) return brokenRead(`is invalid (${r.error.issues[0]?.message ?? ''})`);
    const { hidden, folders, placed } = r.data;
    return { view: { hidden, folders, placed }, newer: null, broken: null };
  }

  /** One read-change-write at a time, each on the file as the previous one left it. */
  function write<T>(change: (v: LibraryView) => { view: LibraryView; result: T }): Promise<T> {
    const next = chain.then(async () => {
      const { view, newer, broken } = await load();
      if (newer) throw new Error(newer);
      if (broken) throw new Error(broken);
      const out = change(view);
      await writeJsonAtomic(file, { schema: LIBRARY_VIEW_SCHEMA, ...out.view });
      return out.result;
    });
    chain = next.catch(() => undefined);
    return next;
  }
  const update = (change: (v: LibraryView) => LibraryView) =>
    write((v) => ({ view: change(v), result: undefined }));

  const withoutKey = (placed: Record<string, string>, key: string) =>
    Object.fromEntries(Object.entries(placed).filter(([k]) => k !== key));

  return {
    read: async () => {
      // after the writes already asked for, so a read right after a write sees it
      await chain;
      return load();
    },
    hide: (key) =>
      update((v) => (v.hidden.includes(key) ? v : { ...v, hidden: [...v.hidden, key] })),
    unhide: (key) => update((v) => ({ ...v, hidden: v.hidden.filter((k) => k !== key) })),
    forget: (key) =>
      update((v) => ({
        ...v,
        hidden: v.hidden.filter((k) => k !== key),
        placed: withoutKey(v.placed, key),
      })),
    createFolder: (name) =>
      write((v) => {
        let id = newFolderId();
        while (v.folders.some((f) => f.id === id)) id = newFolderId();
        const folder = LibraryFolder.parse({ id, name: checkName(v, name) });
        return { view: { ...v, folders: [...v.folders, folder] }, result: folder };
      }),
    renameFolder: (id, name) =>
      update((v) => {
        if (!v.folders.some((f) => f.id === id)) throw new Error(GONE);
        const next = checkName(v, name, id);
        return { ...v, folders: v.folders.map((f) => (f.id === id ? { ...f, name: next } : f)) };
      }),
    deleteFolder: (id) =>
      update((v) => ({
        ...v,
        folders: v.folders.filter((f) => f.id !== id),
        placed: Object.fromEntries(Object.entries(v.placed).filter(([, f]) => f !== id)),
      })),
    move: (key, folderId) =>
      update((v) => {
        if (folderId === null) return { ...v, placed: withoutKey(v.placed, key) };
        if (!v.folders.some((f) => f.id === folderId)) throw new Error(GONE);
        return { ...v, placed: { ...v.placed, [key]: folderId } };
      }),
  };
}

/** `demo:<folder name>` for a demo, else the resolved path (lower case on Windows). */
export function libraryKey(path: string, demo: boolean): string {
  // a demo path can be either OS's spelling (bundled under resources, or the userData copy)
  if (demo) return `demo:${basename(path.replace(/\\/g, '/'))}`;
  const p = resolve(path);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export const entryKey = (e: LibraryEntry): string => libraryKey(e.path, e.demo !== undefined);

/**
 * The entries as this computer shows them: hidden cards dropped, each placed card given its
 * folder (when the folder still exists), and a per-computer cover put over the project's own.
 */
export async function applyLibraryView(
  entries: LibraryEntry[],
  view: LibraryView,
  coverStamp: (key: string) => Promise<{ hash: string; mtimeMs: number } | null>,
): Promise<LibraryEntry[]> {
  const hidden = new Set(view.hidden);
  const folders = new Set(view.folders.map((f) => f.id));
  const out: LibraryEntry[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (hidden.has(key)) continue;
    const e: LibraryEntry = { ...entry };
    delete e.folderId;
    delete e.customCover;
    const folderId = view.placed[key];
    if (folderId !== undefined && folders.has(folderId)) e.folderId = folderId;
    const cover = await coverStamp(key).catch(() => null);
    if (cover) {
      e.thumbnail = `aio://cover/${cover.hash}.jpg?v=${String(Math.round(cover.mtimeMs))}`;
      e.customCover = true;
    }
    out.push(e);
  }
  return out;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `library:folders`, `createFolder`, `renameFolder`, `deleteFolder` and `move`. */
export function registerLibraryFoldersIpc(d: {
  handle: Handle;
  view: LibraryViewStore;
  projects: { path(id: string): string | undefined };
  isDemo: (path: string) => Promise<boolean>;
}): void {
  const { handle, view } = d;
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: errorText(e) };
    }
  };

  handle('library:folders', async () => {
    const { view: v, newer, broken } = await view.read();
    if (newer ?? broken) return { ok: false, error: newer ?? broken ?? '' };
    return { ok: true, folders: v.folders };
  });

  handle('library:createFolder', async ({ name }) => {
    try {
      return { ok: true, folder: await view.createFolder(name) };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  });

  handle('library:renameFolder', ({ folderId, name }) =>
    attempt(() => view.renameFolder(folderId, name)),
  );

  handle('library:deleteFolder', ({ folderId }) => attempt(() => view.deleteFolder(folderId)));

  handle('library:move', async ({ projectId, folderId }) => {
    const path = d.projects.path(projectId);
    if (path === undefined)
      return {
        ok: false,
        error: `There is no project "${projectId}" in the library. Reload the library.`,
      };
    const key = libraryKey(path, await d.isDemo(path));
    return attempt(() => view.move(key, folderId));
  });
}
