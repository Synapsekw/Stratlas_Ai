import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addToLibrary, createLibraryStore, listLibrary, listPacks } from './library';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

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
      thumbnail: 'aio://project/alzour/thumbnail.jpg',
      layerCounts: { mesh: 1, video: 2 },
    });
    expect(e?.sizeBytes).toBeGreaterThanOrEqual(13);
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
    const r = await addToLibrary(dir, store, new ProjectRegistry());
    expect(r.ok && r.entry.kind).toBe('native');
    expect(await store.paths()).toEqual([dir]);
    await addToLibrary(dir, store, new ProjectRegistry());
    expect(await createLibraryStore(join(base, 'library.json')).paths()).toEqual([dir]);
  });

  it('recognises a kit export by its files', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const dir = join(base, 'twin');
    await mkdir(dir);
    await writeFile(join(dir, 'layers.json'), '{}');
    await writeFile(join(dir, 'flights.json'), '{}');
    const r = await addToLibrary(dir, store, new ProjectRegistry());
    expect(r.ok && r.entry).toMatchObject({ kind: 'twin', name: 'twin' });
  });

  it('refuses a folder that is neither a project nor a known export', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const dir = join(base, 'random');
    await mkdir(dir);
    const r = await addToLibrary(dir, store, new ProjectRegistry());
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
    expect((await addToLibrary(dir, store, new ProjectRegistry())).ok).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.library/1',
      paths: [old, dir],
    });
    expect(await createLibraryStore(file).paths()).toEqual([old, dir]);
  });

  it('refuses a list saved by a newer version and never saves over it', async () => {
    const file = join(base, 'library.json');
    const newer = `${JSON.stringify({ schema: 'aio.library/2', folders: [{ path: 'x' }] })}\n`;
    await writeFile(file, newer);
    const store = createLibraryStore(file);
    expect(await store.paths()).toEqual([]);
    const dir = await writeProject(join(base, 'mine'));
    expect(await addToLibrary(dir, store, new ProjectRegistry())).toEqual({
      ok: false,
      error:
        'library.json was saved by a newer version of Stratlas (aio.library/2). Update the app to open it. The file was not changed.',
    });
    await expect(store.add(dir)).rejects.toThrow(/newer version of Stratlas/);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('refuses a missing folder', async () => {
    const store = createLibraryStore(join(base, 'library.json'));
    const r = await addToLibrary(join(base, 'missing'), store, new ProjectRegistry());
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
