import type { LibraryEntry } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLibraryView,
  createLibraryViewStore,
  libraryKey,
  registerLibraryFoldersIpc,
  type LibraryView,
  type LibraryViewStore,
} from './libraryView';
import { collectHandlers } from './notYet';

let dir: string;
let file: string;
let store: LibraryViewStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-libview-'));
  file = join(dir, 'library-view.json');
  store = createLibraryViewStore(file);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const empty: LibraryView = { hidden: [], folders: [], placed: {} };

describe('LibraryViewStore', () => {
  it('starts empty when there is no file', async () => {
    expect((await store.read()).view).toEqual({ hidden: [], folders: [], placed: {} });
  });

  it('hides, un-hides and forgets by key', async () => {
    await store.hide('k1');
    await store.hide('k1');
    await store.hide('k2');
    expect((await store.read()).view.hidden).toEqual(['k1', 'k2']);
    await store.unhide('k1');
    expect((await store.read()).view.hidden).toEqual(['k2']);
    const f = await store.createFolder('A');
    await store.move('k2', f.id);
    await store.forget('k2');
    const { view } = await store.read();
    expect(view.hidden).toEqual([]);
    expect(view.placed).toEqual({});
    const saved = JSON.parse(await readFile(file, 'utf8')) as { schema: string };
    expect(saved.schema).toBe('aio.library-view/1');
  });

  it('creates, renames and deletes a folder; its projects go loose', async () => {
    const f = await store.createFolder('  Yard  ');
    expect(f.id).toMatch(/^f_[a-z0-9]{10}$/);
    expect(f.name).toBe('Yard');
    await store.renameFolder(f.id, 'Quarry');
    await store.move('k1', f.id);
    expect((await store.read()).view.folders).toEqual([{ id: f.id, name: 'Quarry' }]);
    await store.deleteFolder(f.id);
    const { view } = await store.read();
    expect(view.folders).toEqual([]);
    expect(view.placed).toEqual({});
  });

  it('refuses a second folder of the same name, case ignored', async () => {
    const f = await store.createFolder('Yard');
    await expect(store.createFolder('yard')).rejects.toThrow(
      'A folder called "yard" already exists.',
    );
    const g = await store.createFolder('Pit');
    await expect(store.renameFolder(g.id, 'YARD')).rejects.toThrow(/already exists/);
    await store.renameFolder(f.id, 'yard');
    expect((await store.read()).view.folders.map((x) => x.name)).toEqual(['yard', 'Pit']);
  });

  it('moves to a folder and back to loose', async () => {
    const f = await store.createFolder('A');
    await store.move('k1', f.id);
    expect((await store.read()).view.placed).toEqual({ k1: f.id });
    await store.move('k1', null);
    expect((await store.read()).view.placed).toEqual({});
    await expect(store.move('k1', 'f_0000000000')).rejects.toThrow(/Reload the library/);
  });

  it('keeps both moves made at once', async () => {
    const f = await store.createFolder('A');
    await Promise.all([store.move('k1', f.id), store.move('k2', f.id)]);
    expect((await store.read()).view.placed).toEqual({ k1: f.id, k2: f.id });
  });

  it('refuses every write to a newer file and leaves it as it was', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(file, JSON.stringify({ schema: 'aio.library-view/2' }));
    const before = await readFile(file);
    await expect(store.hide('k')).rejects.toThrow(/newer version/);
    await expect(store.createFolder('A')).rejects.toThrow(/newer version/);
    await expect(store.move('k', null)).rejects.toThrow(/newer version/);
    expect(await readFile(file)).toEqual(before);
    const r = await store.read();
    expect(r.view.hidden).toEqual([]);
    expect(r.newer).toMatch(/newer version/);
  });

  it('reads a broken file as empty and says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(file, '{ not json');
    expect((await store.read()).view).toEqual(empty);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('library-view.json'));
  });

  it('keys a demo by its folder name, so the bundled folder and the working copy are one card', () => {
    expect(libraryKey('C:\\App\\resources\\demo\\survey-demo', true)).toBe('demo:survey-demo');
    expect(libraryKey('C:\\Users\\a\\AppData\\Q\\demo\\survey-demo', true)).toBe(
      'demo:survey-demo',
    );
  });

  it.runIf(process.platform === 'win32')('keys a path in lower case on Windows', () => {
    expect(libraryKey('C:\\Data\\Projects\\Yard', false)).toBe('c:\\data\\projects\\yard');
  });
});

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'a',
  name: 'A',
  path: join(tmpdir(), 'a'),
  kind: 'native',
  ...over,
});

const noCover = () => Promise.resolve(null);

describe('applyLibraryView', () => {
  it('drops hidden cards, a hidden demo whichever path it lists by', async () => {
    const view: LibraryView = {
      ...empty,
      hidden: [libraryKey(join(tmpdir(), 'b'), false), 'demo:survey-demo'],
    };
    const out = await applyLibraryView(
      [
        entry(),
        entry({ id: 'b', path: join(tmpdir(), 'b') }),
        entry({
          id: 'd1',
          path: 'C:\\App\\resources\\demo\\survey-demo',
          demo: { primary: true },
        }),
        entry({
          id: 'd2',
          path: 'C:\\Users\\a\\AppData\\Q\\demo\\survey-demo',
          demo: { primary: true },
        }),
      ],
      view,
      noCover,
    );
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('sets folderId only for a folder that exists', async () => {
    const view: LibraryView = {
      hidden: [],
      folders: [{ id: 'f_aaaaaaaaaa', name: 'Yard' }],
      placed: {
        [libraryKey(join(tmpdir(), 'a'), false)]: 'f_aaaaaaaaaa',
        [libraryKey(join(tmpdir(), 'b'), false)]: 'f_bbbbbbbbbb',
      },
    };
    const [a, b] = await applyLibraryView(
      [entry(), entry({ id: 'b', path: join(tmpdir(), 'b') })],
      view,
      noCover,
    );
    expect(a?.folderId).toBe('f_aaaaaaaaaa');
    expect(b?.folderId).toBeUndefined();
  });

  it('prefers a custom cover and marks it', async () => {
    const [e] = await applyLibraryView(
      [entry({ thumbnail: 'aio://project/a/thumbnail.jpg?v=1' })],
      empty,
      () => Promise.resolve({ hash: 'ab', mtimeMs: 7 }),
    );
    expect(e).toMatchObject({ thumbnail: 'aio://cover/ab.jpg?v=7', customCover: true });
  });

  it('keeps the project picture when there is no custom cover', async () => {
    const [e] = await applyLibraryView(
      [entry({ thumbnail: 'aio://project/a/thumbnail.jpg?v=1' })],
      empty,
      noCover,
    );
    expect(e?.thumbnail).toBe('aio://project/a/thumbnail.jpg?v=1');
    expect(e?.customCover).toBeUndefined();
  });
});

describe('folders IPC', () => {
  function setup() {
    const paths: Record<string, string> = {
      a: join(tmpdir(), 'a'),
      d: 'C:\\App\\resources\\demo\\survey-demo',
    };
    return collectHandlers((handle) => {
      registerLibraryFoldersIpc({
        handle,
        view: store,
        projects: { path: (id) => paths[id] },
        isDemo: (p) => Promise.resolve(p.includes('demo')),
      });
    });
  }

  it('creates a folder, then lists it', async () => {
    const h = setup();
    const r = await h.call('library:createFolder', { name: 'Yard' });
    expect(r.ok).toBe(true);
    expect(await h.call('library:folders', {})).toEqual({
      ok: true,
      folders: [r.ok ? r.folder : null],
    });
    expect(await h.call('library:createFolder', { name: 'yard' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already exists') as string,
    });
  });

  it('renames and deletes a folder', async () => {
    const h = setup();
    const r = await h.call('library:createFolder', { name: 'Yard' });
    if (!r.ok) throw new Error(r.error);
    expect(await h.call('library:renameFolder', { folderId: r.folder.id, name: 'Pit' })).toEqual({
      ok: true,
    });
    expect(await h.call('library:deleteFolder', { folderId: r.folder.id })).toEqual({ ok: true });
    expect(await h.call('library:folders', {})).toEqual({ ok: true, folders: [] });
  });

  it('moves by projectId, a demo by its demo key', async () => {
    const h = setup();
    const r = await h.call('library:createFolder', { name: 'Yard' });
    if (!r.ok) throw new Error(r.error);
    expect(await h.call('library:move', { projectId: 'a', folderId: r.folder.id })).toEqual({
      ok: true,
    });
    expect(await h.call('library:move', { projectId: 'd', folderId: r.folder.id })).toEqual({
      ok: true,
    });
    expect((await store.read()).view.placed).toEqual({
      [libraryKey(join(tmpdir(), 'a'), false)]: r.folder.id,
      'demo:survey-demo': r.folder.id,
    });
  });

  it('fails a move of an unknown projectId with "Reload the library"', async () => {
    const h = setup();
    const r = await h.call('library:move', { projectId: 'zz', folderId: null });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? '' : r.error).toMatch(/Reload the library/);
  });
});
