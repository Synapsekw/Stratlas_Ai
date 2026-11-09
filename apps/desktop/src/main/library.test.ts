import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as builderLib from '@aio/project/builder';
import { writeInspectorFixture } from '@aio/project/builder/testing';
import { addToLibrary, createLibraryStore, listLibrary, listPacks } from './library';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

const failCreate = vi.hoisted(() => ({ on: false }));
vi.mock('@aio/project/builder', async (importOriginal) => {
  const real = await importOriginal<typeof builderLib>();
  return {
    ...real,
    createProject: (...a: Parameters<typeof real.createProject>) =>
      failCreate.on ? Promise.reject(new Error('disk full')) : real.createProject(...a),
  };
});

/** A pack version for tests that add no export. */
const noPack = () => Promise.resolve<string | null>('dev');

let base: string;
let dataRoot: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-library-'));
  dataRoot = join(base, 'data');
  await mkdir(join(dataRoot, 'projects'), { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('listLibrary', () => {
  it('lists native projects under <dataRoot>/projects with their summary', async () => {
    await writeProject(join(dataRoot, 'projects', 'alzour'), sampleManifest(), {
      'thumbnail.jpg': 'jpg',
      'video/DJI_0789.mp4': '0123456789',
    });
    const entries = await listLibrary({
      dataRoot,
      extraPaths: [],
      registry: new ProjectRegistry(),
    });
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e).toMatchObject({
      id: 'alzour',
      name: 'Al-Zour LNG Terminal',
      path: join(dataRoot, 'projects', 'alzour'),
      customer: 'KIPIC',
      site: 'Al-Zour',
      kind: 'native',
      captureDate: '2024-01-10',
      thumbnail: expect.stringMatching(
        new RegExp(`^aio://project/${e?.id ?? ''}/thumbnail\\.jpg\\?v=\\d+$`),
      ) as string,
      layerCounts: { mesh: 1, video: 2 },
    });
    expect(e?.sizeBytes).toBeGreaterThanOrEqual(13);
  });

  it('carries the purpose and a thumbnail URL that changes with the file', async () => {
    const dir = await writeProject(
      join(dataRoot, 'projects', 'yard'),
      sampleManifest({ purpose: 'survey' }),
      { 'thumbnail.jpg': 'jpg' },
    );
    const [e] = await listLibrary({ dataRoot, extraPaths: [], registry: new ProjectRegistry() });
    const { mtimeMs } = await stat(join(dir, 'thumbnail.jpg'));
    expect(e?.purpose).toBe('survey');
    expect(e?.thumbnail).toBe(`aio://project/yard/thumbnail.jpg?v=${String(Math.round(mtimeMs))}`);
    expect(e?.customCover).toBeUndefined();
  });

  it("marks a changed cover when the project's own picture is kept beside it", async () => {
    await writeProject(join(dataRoot, 'projects', 'yard'), sampleManifest(), {
      'thumbnail.jpg': 'new',
      'thumbnail.original.jpg': 'own',
    });
    const [e] = await listLibrary({ dataRoot, extraPaths: [], registry: new ProjectRegistry() });
    expect(e?.customCover).toBe(true);
  });

  it('registers listed projects so their thumbnails resolve', async () => {
    await writeProject(join(dataRoot, 'projects', 'hcl'), sampleManifest({ name: 'HCl tank' }));
    const registry = new ProjectRegistry();
    await listLibrary({ dataRoot, extraPaths: [], registry });
    expect(registry.root('hcl')).toBe(join(dataRoot, 'projects', 'hcl'));
  });

  it('omits the thumbnail when there is none', async () => {
    await writeProject(join(dataRoot, 'projects', 'hcl'));
    const [e] = await listLibrary({ dataRoot, extraPaths: [], registry: new ProjectRegistry() });
    expect(e?.thumbnail).toBeUndefined();
  });

  it('includes user-added folders and skips duplicates and missing ones', async () => {
    const extra = await writeProject(
      join(base, 'elsewhere', 'tank'),
      sampleManifest({ name: 'Tank' }),
    );
    await writeProject(join(dataRoot, 'projects', 'alzour'));
    const entries = await listLibrary({
      dataRoot,
      extraPaths: [extra, extra, join(base, 'gone'), join(dataRoot, 'projects', 'alzour')],
      registry: new ProjectRegistry(),
    });
    expect(entries.map((e) => e.name).sort()).toEqual(['Al-Zour LNG Terminal', 'Tank']);
  });

  it('skips folders with a broken manifest instead of failing the whole list', async () => {
    await writeProject(join(dataRoot, 'projects', 'good'));
    await mkdir(join(dataRoot, 'projects', 'bad'));
    await writeFile(join(dataRoot, 'projects', 'bad', 'manifest.json'), '{');
    await mkdir(join(dataRoot, 'projects', 'empty'));
    const entries = await listLibrary({
      dataRoot,
      extraPaths: [],
      registry: new ProjectRegistry(),
    });
    expect(entries.map((e) => e.id)).toEqual(['good']);
  });

  it('returns an empty list when the data folder does not exist', async () => {
    const entries = await listLibrary({
      dataRoot: join(base, 'nowhere'),
      extraPaths: [],
      registry: new ProjectRegistry(),
    });
    expect(entries).toEqual([]);
  });
});

describe('library store and addToLibrary', () => {
  it('adds a native folder, remembers it and returns its entry', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const dir = await writeProject(join(base, 'mine'));
    const r = await addToLibrary(dir, store, new ProjectRegistry(), dataRoot, noPack);
    expect(r.ok && r.entry.kind).toBe('native');
    expect(await store.paths()).toEqual([dir]);
    await addToLibrary(dir, store, new ProjectRegistry(), dataRoot, noPack);
    expect(await createLibraryStore(join(base, 'library.json')).paths()).toEqual([dir]);
  });

  it('makes a local-frame confined-space project of a Flyability Inspector export', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const exp = join(base, 'export');
    await writeInspectorFixture(exp);
    const r = await addToLibrary(
      exp,
      store,
      new ProjectRegistry(),
      dataRoot,
      () => Promise.resolve('0.31.0'),
      true,
    );
    expect(r.ok && r.entry).toMatchObject({
      name: 'Synthetic chamber',
      kind: 'native',
      purpose: 'confined-space',
    });
    const made = r.ok ? r.entry.path : '';
    expect(made.startsWith(join(dataRoot, 'projects'))).toBe(true);
    const m = JSON.parse(await readFile(join(made, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(m.crs).toEqual({ local: 'flyability' });
    expect(m.origin).toEqual([0, 0, 0]);
    expect(JSON.stringify(m.severityModels)).toContain('confined-space-4');
    expect(await store.paths()).toEqual([made]);
    // processing tools missing or too old: said so, and no project is made
    const before = await readdir(join(dataRoot, 'projects'));
    for (const v of [null, '0.30.4']) {
      const old = await addToLibrary(
        exp,
        store,
        new ProjectRegistry(),
        dataRoot,
        () => Promise.resolve(v),
        true,
      );
      expect(old).toMatchObject({ ok: false });
    }
    expect(await readdir(join(dataRoot, 'projects'))).toEqual(before);
    // without a data folder it says so
    expect(await addToLibrary(exp, store, new ProjectRegistry(), '', noPack, true)).toMatchObject({
      ok: false,
    });
  });

  it('the same export dropped twice adds no second project', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const exp = join(base, 'export');
    const ids = await writeInspectorFixture(exp);
    const registry = new ProjectRegistry();
    const packV = () => Promise.resolve('0.31.0');
    const one = await addToLibrary(exp, store, registry, dataRoot, packV, true);
    expect(one.ok).toBe(true);
    // once the import ran, the project holds the inspection's space
    const mf = join(one.ok ? one.entry.path : '', 'manifest.json');
    const m = JSON.parse(await readFile(mf, 'utf8')) as Record<string, unknown>;
    m.spaces = [
      {
        id: 's1',
        name: 'Chamber',
        crs: { local: 'flyability' },
        origin: [0, 0, 0],
        source: { kind: 'flyability', inspectionId: ids.inspectionId },
      },
    ];
    await writeFile(mf, JSON.stringify(m));
    const two = await addToLibrary(exp, store, registry, dataRoot, packV, true);
    expect(await readdir(join(dataRoot, 'projects'))).toHaveLength(1);
    expect(one.ok && two.ok && two.entry.id).toBe(one.ok ? one.entry.id : '');
  });

  it('the same export dropped again before any import adds no second project', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const exp = join(base, 'export');
    await writeInspectorFixture(exp);
    const registry = new ProjectRegistry();
    const packV = () => Promise.resolve('0.31.0');
    const one = await addToLibrary(exp, store, registry, dataRoot, packV, true);
    // the picker was cancelled: the project has no space yet
    const two = await addToLibrary(exp, store, registry, dataRoot, packV, true);
    expect(await readdir(join(dataRoot, 'projects'))).toHaveLength(1);
    expect(one.ok && two.ok && two.entry.id).toBe(one.ok ? one.entry.id : '');
    // the note holds hashes, never the folder path
    const note = await readFile(
      join(one.ok ? one.entry.path : '', 'flyability-source.json'),
      'utf8',
    );
    expect(JSON.parse(note)).toMatchObject({ schema: 'aio.flyability-source/1' });
    expect(note).not.toContain('export');
    // another export still gets its own project
    const other = join(base, 'export2');
    await writeInspectorFixture(other);
    await addToLibrary(other, store, registry, dataRoot, packV, true);
    expect(await readdir(join(dataRoot, 'projects'))).toHaveLength(2);
  });

  it('a mission folder makes one project for all its chambers, and reopens it when dropped again', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const mission = join(base, 'Mission 1');
    await writeInspectorFixture(join(mission, 'Exports', 'Chamber A'));
    await writeInspectorFixture(join(mission, 'Exports', 'Chamber B'), { seed: 1 });
    await mkdir(join(mission, 'Raw drone data'), { recursive: true });
    const registry = new ProjectRegistry();
    const packV = () => Promise.resolve('0.31.0');
    const one = await addToLibrary(mission, store, registry, dataRoot, packV, true);
    // named after the mission folder, not one chamber's asset
    expect(one.ok && one.entry).toMatchObject({ name: 'Mission 1', purpose: 'confined-space' });
    const note = JSON.parse(
      await readFile(join(one.ok ? one.entry.path : '', 'flyability-source.json'), 'utf8'),
    ) as { sha256: string[] };
    // the mission and each chamber, as hashes only
    expect(note.sha256).toHaveLength(3);
    expect(JSON.stringify(note)).not.toContain('Mission');
    const two = await addToLibrary(mission, store, registry, dataRoot, packV, true);
    expect(one.ok && two.ok && two.entry.id).toBe(one.ok ? one.entry.id : '');
    // one chamber dropped on its own goes to the same project
    const three = await addToLibrary(
      join(mission, 'Exports', 'Chamber B'),
      store,
      registry,
      dataRoot,
      packV,
      true,
    );
    expect(one.ok && three.ok && three.entry.id).toBe(one.ok ? one.entry.id : '');
    expect(await readdir(join(dataRoot, 'projects'))).toHaveLength(1);
  });

  it('an export project that cannot be made leaves no folder', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const exp = join(base, 'export');
    await writeInspectorFixture(exp);
    failCreate.on = true;
    const r = await addToLibrary(
      exp,
      store,
      new ProjectRegistry(),
      dataRoot,
      () => Promise.resolve('0.31.0'),
      true,
    );
    failCreate.on = false;
    expect(r).toMatchObject({ ok: false });
    expect(await readdir(join(dataRoot, 'projects'))).toEqual([]);
  });

  it('adds no project for an Inspector export while its picker is not shipped', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const exp = join(base, 'export');
    await writeInspectorFixture(exp);
    const before = await readdir(join(dataRoot, 'projects')).catch(() => [] as string[]);
    const r = await addToLibrary(
      exp,
      store,
      new ProjectRegistry(),
      dataRoot,
      () => Promise.resolve('0.31.0'),
      false,
    );
    expect(r.ok).toBe(false);
    expect(await readdir(join(dataRoot, 'projects')).catch(() => [] as string[])).toEqual(before);
    expect(await store.paths()).toEqual([]);
  });

  it('with the flag on an export makes its project', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const exp = join(base, 'export');
    await writeInspectorFixture(exp);
    const r = await addToLibrary(exp, store, new ProjectRegistry(), dataRoot, () =>
      Promise.resolve('0.31.0'),
    );
    expect(r.ok).toBe(true);
    expect(await readdir(join(dataRoot, 'projects'))).toHaveLength(1);
  });

  it('recognises a kit export by its files', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const dir = join(base, 'twin');
    await mkdir(dir);
    await writeFile(join(dir, 'layers.json'), '{}');
    await writeFile(join(dir, 'flights.json'), '{}');
    const r = await addToLibrary(dir, store, new ProjectRegistry(), dataRoot, noPack);
    expect(r.ok && r.entry).toMatchObject({ kind: 'twin', name: 'twin' });
  });

  it('refuses a folder that is neither a project nor a known export', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const dir = join(base, 'random');
    await mkdir(dir);
    const r = await addToLibrary(dir, store, new ProjectRegistry(), dataRoot, noPack);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/manifest\.json/);
    expect(await store.paths()).toEqual([]);
  });

  it('reads a list without a schema id (0.8 and earlier) and saves it as aio.library/1', async () => {
    const file = join(base, 'library.json');
    const old = await writeProject(join(base, 'old'));
    await writeFile(file, JSON.stringify({ paths: [old] }));
    const store = createLibraryStore(file);
    expect(await store.paths()).toEqual([old]);
    const dir = await writeProject(join(base, 'mine'));
    expect((await addToLibrary(dir, store, new ProjectRegistry(), dataRoot, noPack)).ok).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.library/1',
      paths: [old, dir],
    });
    expect(await createLibraryStore(file).paths()).toEqual([old, dir]);
  });

  it('keeps both an add and a remove made at once', async () => {
    const file = join(base, 'library.json');
    const a = join(base, 'a');
    const b = join(base, 'b');
    const c = join(base, 'c');
    await writeFile(file, JSON.stringify({ schema: 'aio.library/1', paths: [a, b] }));
    const store = createLibraryStore(file);
    await Promise.all([store.remove(a), store.add(c), store.remove(b)]);
    expect(await store.paths()).toEqual([c]);
  });

  it('refuses a list saved by a newer version and never saves over it', async () => {
    const file = join(base, 'library.json');
    const newer = `${JSON.stringify({ schema: 'aio.library/2', folders: [{ path: 'x' }] })}\n`;
    await writeFile(file, newer);
    const store = createLibraryStore(file);
    expect(await store.paths()).toEqual([]);
    const dir = await writeProject(join(base, 'mine'));
    expect(await addToLibrary(dir, store, new ProjectRegistry(), dataRoot, noPack)).toEqual({
      ok: false,
      error:
        'library.json was saved by a newer version of Quadrion AI (aio.library/2). Update the app to open it. The file was not changed.',
    });
    await expect(store.add(dir)).rejects.toThrow(/newer version of Quadrion AI/);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('removes a path, case ignored on Windows', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const a = await writeProject(join(base, 'a'));
    const b = await writeProject(join(base, 'b'));
    await store.add(a);
    await store.add(b);
    await store.remove(process.platform === 'win32' ? a.toUpperCase() : a);
    expect(await store.paths()).toEqual([b]);
    await store.remove(join(base, 'never-added'));
    expect(await store.paths()).toEqual([b]);
  });

  it('refuses a missing folder', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const r = await addToLibrary(
      join(base, 'missing'),
      store,
      new ProjectRegistry(),
      dataRoot,
      noPack,
    );
    expect(r.ok).toBe(false);
  });
});

describe('listPacks', () => {
  it('reads valid MapPackInfo files and skips the rest', async () => {
    const packs = join(base, 'packs');
    await mkdir(packs);
    const gcc = { id: 'gcc', label: 'GCC', bbox: [34, 12, 60, 32], maxZoom: 15, sizeBytes: 100 };
    await writeFile(join(packs, 'gcc.json'), JSON.stringify(gcc));
    await writeFile(join(packs, 'bad.json'), JSON.stringify({ id: 'BAD' }));
    await writeFile(join(packs, 'gcc.pmtiles'), 'x');
    expect(await listPacks(packs)).toEqual([gcc]);
  });

  it('returns no packs when the folder is missing', async () => {
    expect(await listPacks(join(base, 'none'))).toEqual([]);
  });
});
