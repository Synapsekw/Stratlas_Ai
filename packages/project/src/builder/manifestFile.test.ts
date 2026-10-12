import { parseManifest, type ProjectManifest } from '@aio/schema';
import type * as FsPromises from 'node:fs/promises';
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  ensureCapture,
  removeCapture,
  updateCapture,
  updateLayers,
  updateManifestFile,
  withManifest,
  writeManifestFile,
} from './create';
import { NO_PIPELINE, importRawFiles, type ImportDeps, type PipelineJobs } from './raw';
import { withExif } from './testing';

// `rename` and `rm` pass through unless a test refuses them: a rename Windows refuses for good
// cannot be made on purpose with real files without waiting out the whole retry
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
const { rename: realRename, rm: realRm } =
  await vi.importActual<typeof FsPromises>('node:fs/promises');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-manifest-'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation(realRename);
  vi.mocked(rm).mockReset();
  vi.mocked(rm).mockImplementation(realRm);
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const refused = (code: string, what: string) =>
  Object.assign(new Error(`${code}: operation not permitted, ${what}`), { code });

/**
 * What a save ends with ('saved', or its error), with the waits between the tries of a refused
 * rename on Windows (about 2.5 s) passing at once. Fails when the save never ends.
 */
async function outcomeOf(save: Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const state = { settled: false };
  const outcome = save
    .then(
      () => 'saved' as const,
      (e: unknown) => e,
    )
    .finally(() => {
      state.settled = true;
    });
  // real time (only setTimeout is faked): the file work of a save takes milliseconds
  const giveUp = performance.now() + 3000;
  while (!state.settled) {
    if (performance.now() > giveUp)
      throw new Error('The save neither finished nor failed, though every retry wait had passed.');
    await vi.advanceTimersByTimeAsync(5000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  vi.useRealTimers();
  return outcome;
}

const readManifest = async (root: string): Promise<ProjectManifest> => {
  const r = parseManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** A tiny but valid GLB (an empty scene). */
function glb(): Uint8Array {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}]}  ');
  const out = new Uint8Array(12 + 8 + json.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  return out;
}

const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
  images: { resizeJpeg: () => Promise.resolve() },
  jobs: NO_PIPELINE,
  utcOffsetMin: 0,
  ...over,
});

/** A project with one model layer (`mesh-m`) and two survey dates (`c1`, `c2`). */
async function project(name = 'Synthetic site'): Promise<string> {
  const { root } = await createProject(dir, {
    name,
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 30],
    severityTemplate: null,
  });
  await writeFile(join(dir, 'm.glb'), glb());
  await importRawFiles(root, [join(dir, 'm.glb')], deps());
  await writeManifestFile(root, {
    ...(await readManifest(root)),
    captures: [
      { id: 'c1', label: 'First survey', date: '2026-01-10' },
      { id: 'c2', label: 'Second survey', date: '2026-03-10' },
    ],
  });
  return root;
}

const partials = async (root: string) =>
  (await readdir(root)).filter((n) => n.endsWith('.partial'));

const T = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1];

describe('saves of one manifest take turns', () => {
  it('keeps two survey dates added at the same moment', async () => {
    const root = await project();
    const [a, b] = await Promise.all([
      ensureCapture(root, '2026-02-01'),
      ensureCapture(root, '2026-04-01'),
    ]);
    expect(a).toMatchObject({ captureId: 'capture-2026-02-01', created: true });
    expect(b).toMatchObject({ captureId: 'capture-2026-04-01', created: true });
    expect((await readManifest(root)).captures.map((c) => c.id)).toEqual([
      'c1',
      'capture-2026-02-01',
      'c2',
      'capture-2026-04-01',
    ]);
    expect(await partials(root)).toEqual([]);
  });

  it('keeps a renamed survey date and a placed layer saved at the same moment', async () => {
    const root = await project();
    await Promise.all([
      updateCapture(root, 'c1', { label: 'Baseline' }),
      updateLayers(root, ['mesh-m'], { transform: T }),
    ]);
    const m = await readManifest(root);
    expect(m.captures[0]?.label).toBe('Baseline');
    expect(m.layers.find((l) => l.id === 'mesh-m')).toMatchObject({ transform: T });
    expect(await partials(root)).toEqual([]);
  });

  it('keeps a change saved while a slow save of the same project is on its way', async () => {
    const root = await project();
    // the slow save has read the manifest and is still working when the others are called
    const slow = updateManifestFile(root, async (m) => {
      await sleep(60);
      return { manifest: { ...m, name: 'Renamed slowly' } };
    });
    const date = ensureCapture(root, '2026-02-01');
    const label = updateCapture(root, 'c2', { label: 'Handover' });
    await Promise.all([slow, date, label]);
    const m = await readManifest(root);
    expect(m.name).toBe('Renamed slowly');
    expect(m.captures.map((c) => c.id)).toContain('capture-2026-02-01');
    expect(m.captures.find((c) => c.id === 'c2')?.label).toBe('Handover');
  });

  it('runs the saves of one project one at a time, in the order they were called', async () => {
    const root = await project();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`${name} starts`);
      await sleep(ms);
      log.push(`${name} ends`);
      return name;
    };
    const done = await Promise.all([
      withManifest(root, task('a', 30)),
      withManifest(root, task('b', 1)),
      withManifest(root, task('c', 10)),
    ]);
    expect(done).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends']);
  });

  it('goes on with the next save when one fails', async () => {
    const root = await project();
    const failed = withManifest(root, async () => {
      await sleep(10);
      throw new Error('disk full');
    });
    const refused = updateCapture(root, 'c9', { label: 'Nope' });
    const next = updateCapture(root, 'c1', { label: 'Baseline' });
    await expect(failed).rejects.toThrow('disk full');
    await expect(refused).rejects.toThrow(/c9/);
    await next;
    expect((await readManifest(root)).captures[0]?.label).toBe('Baseline');
  });

  it('takes two spellings of one folder for the same project', async () => {
    const root = await project();
    const other = process.platform === 'win32' ? root.toUpperCase() : join(root, 'models', '..');
    const log: string[] = [];
    await Promise.all([
      withManifest(root, async () => {
        await sleep(30);
        log.push('first');
      }),
      withManifest(other, () => {
        log.push('second');
        return Promise.resolve();
      }),
    ]);
    expect(log).toEqual(['first', 'second']);
  });

  it('lets another project save while one project is busy', async () => {
    const root = await project();
    const second = await project('Second site');
    let busy = true;
    const held = withManifest(root, async () => {
      await sleep(60);
      busy = false;
    });
    await updateCapture(second, 'c1', { label: 'Baseline' });
    expect(busy).toBe(true);
    await held;
  });
});

describe('updateManifestFile', () => {
  it('reads the manifest in its turn, saves the change and hands back what change adds', async () => {
    const root = await project();
    const first = updateCapture(root, 'c1', { label: 'Baseline' });
    const r = await updateManifestFile(root, (m) => ({
      manifest: { ...m, name: 'Renamed' },
      // what the save before this one wrote is what this one read
      seen: m.captures[0]?.label,
    }));
    await first;
    expect(r.seen).toBe('Baseline');
    expect(r.saved).toBe(true);
    expect(r.backup).toBe(join(root, 'manifest.json.bak'));
    expect(r.manifest.name).toBe('Renamed');
    const m = await readManifest(root);
    expect(m.name).toBe('Renamed');
    expect(m.captures[0]?.label).toBe('Baseline');
    expect(JSON.parse(await readFile(r.backup, 'utf8'))).toMatchObject({ name: 'Synthetic site' });
  });

  it('writes nothing when the change has nothing to save', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    const before = await readFile(file, 'utf8');
    await rm(`${file}.bak`);
    const r = await updateManifestFile(root, (m) => ({ manifest: null, layers: m.layers.length }));
    expect(r).toMatchObject({ saved: false, backup: '', layers: 1 });
    expect(r.manifest).toEqual(await readManifest(root));
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(root)).not.toContain('manifest.json.bak');
  });

  it('writes nothing when the change throws, and the next save goes through', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    const before = await readFile(file, 'utf8');
    await rm(`${file}.bak`);
    const failed = updateManifestFile(root, async () => {
      await sleep(5);
      throw new Error('no such layer');
    });
    const next = ensureCapture(root, '2026-02-01');
    await expect(failed).rejects.toThrow('no such layer');
    // nothing of the failed change is on disk: the next save backs up the manifest as it was
    await next;
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(before);
    expect((await readManifest(root)).captures.map((c) => c.id)).toContain('capture-2026-02-01');
  });

  it('refuses a manifest that is not valid and leaves the file alone', async () => {
    const root = await project();
    const before = await readFile(join(root, 'manifest.json'), 'utf8');
    await expect(
      updateManifestFile(root, (m) => ({
        manifest: { ...m, schema: 'aio.project/9' } as unknown as ProjectManifest,
      })),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
    expect(await partials(root)).toEqual([]);
  });
});

describe('the temporary file of a save', () => {
  it('has a name of its own for every save, still ending in .partial', async () => {
    const root = await project();
    vi.mocked(rename).mockClear();
    const m = await readManifest(root);
    await Promise.all([
      writeManifestFile(root, { ...m, name: 'One' }),
      writeManifestFile(root, { ...m, name: 'Two' }),
    ]);
    // by name: a rename Windows refuses for a moment is tried again with the same file
    const temps = [...new Set(vi.mocked(rename).mock.calls.map(([from]) => String(from)))];
    expect(temps).toHaveLength(2);
    for (const t of temps) {
      expect(t.startsWith(join(root, 'manifest.json.'))).toBe(true);
      expect(t.endsWith('.partial')).toBe(true);
    }
    // in the order of the calls: the later one stays
    expect((await readManifest(root)).name).toBe('Two');
    expect(await partials(root)).toEqual([]);
  });

  it('is removed when the rename is refused for good', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    const before = await readFile(file, 'utf8');
    const refusal = refused('EPERM', 'rename');
    vi.mocked(rename).mockImplementation(() => Promise.reject(refusal));
    expect(await outcomeOf(ensureCapture(root, '2026-02-01'))).toBe(refusal);
    expect(await partials(root)).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);

    // the refused save does not stand in the way of the next one
    vi.mocked(rename).mockImplementation(realRename);
    await ensureCapture(root, '2026-02-01');
    expect((await readManifest(root)).captures.map((c) => c.id)).toContain('capture-2026-02-01');
  });

  it('that cannot be removed either leaves the rename error as the one reported', async () => {
    // a scanner holding the temporary file refuses its removal too: the caller must still learn
    // why the save failed, not why the cleanup did
    const root = await project();
    const file = join(root, 'manifest.json');
    const before = await readFile(file, 'utf8');
    const refusal = refused('EPERM', 'rename');
    vi.mocked(rename).mockImplementation(() => Promise.reject(refusal));
    vi.mocked(rm).mockImplementation(() => Promise.reject(refused('EBUSY', 'unlink')));
    expect(await outcomeOf(ensureCapture(root, '2026-02-01'))).toBe(refusal);
    expect(vi.mocked(rm)).toHaveBeenCalledWith(expect.stringMatching(/\.partial$/), {
      force: true,
    });
    expect(await readFile(file, 'utf8')).toBe(before);

    // and the next save goes through
    vi.mocked(rename).mockImplementation(realRename);
    vi.mocked(rm).mockImplementation(realRm);
    await ensureCapture(root, '2026-02-01');
    expect((await readManifest(root)).captures.map((c) => c.id)).toContain('capture-2026-02-01');
  });
});

describe('saves that have nothing to write', () => {
  it('ensureCapture of a date that exists makes no backup and no write', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    await rm(`${file}.bak`);
    const before = await stat(file);
    const r = await ensureCapture(root, '2026-03-10');
    expect(r).toEqual({ manifest: await readManifest(root), captureId: 'c2', created: false });
    expect(await readdir(root)).not.toContain('manifest.json.bak');
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('updateLayers with a layer the project does not have throws and writes nothing', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    await rm(`${file}.bak`);
    const before = await readFile(file, 'utf8');
    await expect(updateLayers(root, ['mesh-m', 'nope'], { transform: T })).rejects.toThrow(
      'Layer "nope" is not in this project.',
    );
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(root)).not.toContain('manifest.json.bak');
    expect(await partials(root)).toEqual([]);
  });
});

describe('importRawFiles and the queue', () => {
  it('does not keep other saves waiting while it copies files', async () => {
    const root = await project();
    await writeFile(join(dir, 'n.glb'), glb());
    // the import has read the manifest and is busy (here: asking for the processing tools)
    let release: (pipeline: boolean) => void = () => undefined;
    const busy = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let importing = true;
    const imported = importRawFiles(
      root,
      [join(dir, 'n.glb')],
      deps({ jobs: { ...NO_PIPELINE, available: () => busy } }),
    ).finally(() => {
      importing = false;
    });
    await sleep(20);
    await updateCapture(root, 'c1', { label: 'Baseline' });
    expect(importing).toBe(true);
    expect((await readManifest(root)).captures[0]?.label).toBe('Baseline');
    release(false);
    const r = await imported;
    expect(r.items).toMatchObject([{ status: 'imported', layerId: 'mesh-n' }]);
    const after = await readManifest(root);
    expect(after.layers.map((l) => l.id)).toEqual(['mesh-m', 'mesh-n']);
    // the import saves what it added onto the manifest as it is at its end, so the name given
    // during the import stays
    expect(after.captures[0]?.label).toBe('Baseline');
    expect(r.manifest).toEqual(after);
    expect(await partials(root)).toEqual([]);
  });

  it('saves at its end in its turn, after the save that is on its way', async () => {
    const root = await project();
    await writeFile(join(dir, 'n.glb'), glb());
    let layersWhileHeld: string[] = [];
    const held = withManifest(root, async () => {
      await sleep(80);
      layersWhileHeld = (await readManifest(root)).layers.map((l) => l.id);
    });
    const r = await importRawFiles(root, [join(dir, 'n.glb')], deps());
    await held;
    expect(layersWhileHeld).toEqual(['mesh-m']);
    expect(r.backup).toBe(join(root, 'manifest.json.bak'));
    expect((await readManifest(root)).layers.map((l) => l.id)).toEqual(['mesh-m', 'mesh-n']);
    expect(await partials(root)).toEqual([]);
  });
});

describe('importRawFiles saves what it added onto the project as it is at its end', () => {
  const photo = (date?: string) =>
    withExif({
      lat: 29.0276,
      lon: 48.1352,
      ...(date ? { dateTimeOriginal: `${date.replaceAll('-', ':')} 09:00:00` } : {}),
    });

  /** `resizeJpeg` that runs `during` once, while the import is busy with its first photo. */
  const busyWith = (during: () => Promise<unknown>): ImportDeps['images'] => {
    let ran = false;
    return {
      resizeJpeg: async () => {
        if (ran) return;
        ran = true;
        await during();
      },
    };
  };

  const pack = (start: PipelineJobs['start']): PipelineJobs => ({
    available: () => Promise.resolve(true),
    start,
  });

  /**
   * What a conversion job does when it ends, as the processing tools do it (`register` of the
   * point cloud pipeline): from its own process, so outside the app's turns, it reads the
   * manifest, appends its layer, keeps the previous file as the backup and writes the file.
   */
  async function jobFilesItsCloud(root: string): Promise<void> {
    const file = join(root, 'manifest.json');
    const m = JSON.parse(await readFile(file, 'utf8')) as { layers: unknown[] };
    m.layers.push({
      kind: 'pointcloud',
      id: 'cloud-site',
      name: 'site.laz',
      visible: true,
      src: { path: 'clouds/site.copc.laz' },
      format: 'copc',
      pointCount: 3,
    });
    await copyFile(file, `${file}.bak`);
    await writeFile(file, `${JSON.stringify(m, null, 2)}\n`);
  }

  const photoIds = (m: ProjectManifest) => {
    const l = m.layers.find((x) => x.id === 'photos');
    return l?.kind === 'photos' ? l.items.map((p) => p.id) : null;
  };

  it('keeps a survey date renamed during the import, and has its own new layers and dates', async () => {
    const root = await project();
    await writeFile(join(dir, 'p.jpg'), photo('2026-02-01'));
    await writeFile(join(dir, 'n.glb'), glb());
    const r = await importRawFiles(
      root,
      [join(dir, 'p.jpg'), join(dir, 'n.glb')],
      deps({ images: busyWith(() => updateCapture(root, 'c1', { label: 'Baseline', colour: 3 })) }),
    );
    expect(r.items.map((i) => [i.status, i.layerId])).toEqual([
      ['imported', 'photos'],
      ['imported', 'mesh-n'],
    ]);
    const m = await readManifest(root);
    expect(m.captures).toEqual([
      { id: 'c1', label: 'Baseline', date: '2026-01-10', colour: 3 },
      { id: 'capture-2026-02-01', label: 'Survey', date: '2026-02-01' },
      { id: 'c2', label: 'Second survey', date: '2026-03-10' },
    ]);
    expect(m.layers.map((l) => l.id)).toEqual(['mesh-m', 'photos', 'mesh-n']);
    expect(photoIds(m)).toEqual(['p']);
    expect(r.manifest).toEqual(m);
    expect(await partials(root)).toEqual([]);
  });

  it('keeps a survey date a photo run saved and a dataset moved to another date meanwhile', async () => {
    const root = await project();
    await writeFile(join(dir, 'p.jpg'), photo('2026-02-01'));
    const r = await importRawFiles(
      root,
      [join(dir, 'p.jpg')],
      deps({
        images: busyWith(async () => {
          await ensureCapture(root, '2026-02-01');
          await updateCapture(root, 'capture-2026-02-01', { label: 'Photo run' });
          await ensureCapture(root, '2026-04-01');
          await updateLayers(root, ['mesh-m'], { capture: 'c2' });
        }),
      }),
    );
    const m = await readManifest(root);
    // the day the import also found has the one date, under the name it was given
    expect(m.captures.map((c) => [c.id, c.label])).toEqual([
      ['c1', 'First survey'],
      ['capture-2026-02-01', 'Photo run'],
      ['c2', 'Second survey'],
      ['capture-2026-04-01', 'Survey'],
    ]);
    expect(m.layers.find((l) => l.id === 'mesh-m')).toMatchObject({ capture: 'c2' });
    expect(photoIds(m)).toEqual(['p']);
    expect(r.manifest).toEqual(m);
  });

  it('keeps the layer one of its own conversions filed before the import ended', async () => {
    const root = await project();
    await writeFile(join(dir, 'site.laz'), new Uint8Array([1, 2, 3]));
    await writeFile(join(dir, 'p.jpg'), photo());
    await writeFile(join(dir, 'n.glb'), glb());
    const started: string[] = [];
    const r = await importRawFiles(
      root,
      [join(dir, 'site.laz'), join(dir, 'p.jpg'), join(dir, 'n.glb')],
      deps({
        jobs: pack((method) => {
          started.push(method);
          return Promise.resolve({ jobId: 'job-1' });
        }),
        // the conversion ends while the photos are still being copied
        images: busyWith(() => jobFilesItsCloud(root)),
      }),
    );
    expect(started).toEqual(['pointcloud.toCopc']);
    expect(r.items.map((i) => i.status)).toEqual(['queued', 'imported', 'imported']);
    const m = await readManifest(root);
    expect(m.layers.map((l) => l.id)).toEqual(['mesh-m', 'cloud-site', 'photos', 'mesh-n']);
    expect(m.layers.find((l) => l.id === 'cloud-site')).toMatchObject({
      src: { path: 'clouds/site.copc.laz' },
      pointCount: 3,
    });
    expect(r.manifest).toEqual(m);
    // the backup is the file the import saved over: the one with the cloud
    const bak = JSON.parse(await readFile(r.backup, 'utf8')) as { layers: { id: string }[] };
    expect(bak.layers.map((l) => l.id)).toEqual(['mesh-m', 'cloud-site']);
  });

  it('has every photo when the photos layer was changed during the import, and that change too', async () => {
    const root = await project();
    for (const n of ['p1', 'p2', 'p3']) await writeFile(join(dir, `${n}.jpg`), photo());
    await importRawFiles(root, [join(dir, 'p1.jpg')], deps());
    const r = await importRawFiles(
      root,
      [join(dir, 'p2.jpg'), join(dir, 'p3.jpg')],
      deps({
        images: busyWith(async () => {
          // the layer is moved to another survey date, and a second writer lists a photo in it
          await updateLayers(root, ['photos'], { capture: 'c2' });
          await updateManifestFile(root, (m) => ({
            manifest: {
              ...m,
              layers: m.layers.map((l) =>
                l.kind === 'photos'
                  ? { ...l, items: [...l.items, { id: 'x', src: { path: 'photos/x.jpg' } }] }
                  : l,
              ),
            },
          }));
        }),
      }),
    );
    expect(r.items.map((i) => [i.status, i.layerId])).toEqual([
      ['imported', 'photos'],
      ['imported', 'photos'],
    ]);
    const m = await readManifest(root);
    expect(photoIds(m)).toEqual(['p1', 'x', 'p2', 'p3']);
    expect(m.layers.find((l) => l.id === 'photos')).toMatchObject({ capture: 'c2' });
    expect(m.layers.map((l) => l.id)).toEqual(['mesh-m', 'photos']);
    expect(r.manifest).toEqual(m);
  });

  it('reports the id its layer was saved under when the id it chose was taken meanwhile', async () => {
    const root = await project();
    await writeFile(join(dir, 'n.glb'), glb());
    const other = {
      kind: 'pointcloud' as const,
      id: 'mesh-n',
      name: 'Filed meanwhile',
      visible: true,
      src: { path: 'clouds/n.copc.laz' },
      format: 'copc' as const,
    };
    const r = await importRawFiles(
      root,
      [join(dir, 'n.glb')],
      deps({
        jobs: {
          ...NO_PIPELINE,
          // the import has read the manifest; another file is filed under the id it will choose
          available: async () => {
            await updateManifestFile(root, (m) => ({
              manifest: { ...m, layers: [...m.layers, other] },
            }));
            return false;
          },
        },
      }),
    );
    expect(r.items).toMatchObject([{ status: 'imported', layerId: 'mesh-n-2' }]);
    const m = await readManifest(root);
    expect(m.layers.map((l) => [l.id, l.kind])).toEqual([
      ['mesh-m', 'mesh'],
      ['mesh-n', 'pointcloud'],
      ['mesh-n-2', 'mesh'],
    ]);
    expect(m.layers.at(-1)).toMatchObject({ src: { path: 'models/n.glb' } });
    expect(r.manifest).toEqual(m);
  });

  it('saves nothing when it only handed files to the processing tools', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    await writeFile(join(dir, 'site.laz'), new Uint8Array([1, 2, 3]));
    await rm(`${file}.bak`);
    const before = await stat(file);
    const jobs = pack(() => Promise.resolve({ jobId: 'job-1' }));
    const r = await importRawFiles(root, [join(dir, 'site.laz')], deps({ jobs }));
    expect(r.items).toMatchObject([{ status: 'queued', jobId: 'job-1' }]);
    expect(r.backup).toBe('');
    expect(await readdir(root)).not.toContain('manifest.json.bak');
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(r.manifest).toEqual(await readManifest(root));

    // and what it hands back is the project as it is by then, not as it was at its start
    const renamed = await importRawFiles(
      root,
      [join(dir, 'site.laz')],
      deps({
        jobs: pack(async () => {
          await updateCapture(root, 'c1', { label: 'Baseline' });
          return { jobId: 'job-2' };
        }),
      }),
    );
    expect(renamed.backup).toBe('');
    expect(renamed.manifest.captures[0]?.label).toBe('Baseline');
    expect(renamed.manifest).toEqual(await readManifest(root));
  });

  it('still reports its files when it saved nothing and the project cannot be read at its end', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    const atStart = await readManifest(root);
    await writeFile(join(dir, 'site.laz'), new Uint8Array([1, 2, 3]));
    await writeFile(join(dir, 'notes.txt'), 'not a file the builder imports');
    const r = await importRawFiles(
      root,
      [join(dir, 'site.laz'), join(dir, 'notes.txt')],
      deps({
        jobs: pack(async () => {
          // the job is started; then the manifest is, for this moment, not a manifest
          await writeFile(file, '{ "schema": ');
          return { jobId: 'job-1' };
        }),
      }),
    );
    // the job runs and the person must learn of it: the import does not fail on a file it only
    // meant to read, and hands back the project as it read it at its start
    expect(r.items).toMatchObject([
      { file: 'site.laz', status: 'queued', jobId: 'job-1' },
      { file: 'notes.txt', status: 'skipped' },
    ]);
    expect(r.backup).toBe('');
    expect(r.manifest).toEqual(atStart);
    expect(await readFile(file, 'utf8')).toBe('{ "schema": ');
  });

  it('saves what it always saved when nothing else changed the project meanwhile', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    // a project as the import meets it: a photos layer, a datum, dates not in date order
    await writeFile(join(dir, 'p1.jpg'), photo());
    await importRawFiles(root, [join(dir, 'p1.jpg')], deps());
    const start = await readManifest(root);
    await writeManifestFile(root, {
      ...start,
      captures: [...start.captures].reverse(),
      verticalDatum: { absAltOffsetM: 5 },
    });
    await writeFile(
      join(dir, 'flight-0002.jpg'),
      withExif({
        make: 'DJI',
        dateTimeOriginal: '2026:02:01 09:00:00',
        lat: 29.0276,
        lon: 48.1352,
        alt: 155.6,
        dji: {
          GimbalYawDegree: '+10',
          GimbalPitchDegree: '-40',
          GimbalRollDegree: '0',
          AbsoluteAltitude: '+155.60',
          RelativeAltitude: '+113.70',
        },
      }),
    );
    await writeFile(join(dir, 'n.glb'), glb());
    const r = await importRawFiles(
      root,
      [join(dir, 'flight-0002.jpg'), join(dir, 'n.glb')],
      deps({ altitude: { source: 'absolute', absAltOffsetM: -18.5 } }),
    );
    // What the import wrote when it still saved its own copy of the manifest (recorded from that
    // code, byte for byte): the new date in date order, the photo after the one that was there,
    // the model last, the datum set at the import.
    const [model, photos] = start.layers;
    if (photos?.kind !== 'photos') throw new Error('no photos layer');
    const savedBefore = {
      ...start,
      captures: [
        { id: 'c1', label: 'First survey', date: '2026-01-10' },
        { id: 'capture-2026-02-01', label: 'Survey', date: '2026-02-01' },
        { id: 'c2', label: 'Second survey', date: '2026-03-10' },
      ],
      layers: [
        model,
        {
          ...photos,
          items: [
            ...photos.items,
            {
              id: 'flight-0002',
              src: { path: 'photos/flight-0002.jpg' },
              takenAt: '2026-02-01T09:00:00+00:00',
              pos: [-279019.1239, 107.1, -14430.0004],
              q: [-0.3403317, -0.0932565, -0.0339426, 0.9350537],
            },
          ],
        },
        {
          kind: 'mesh',
          id: 'mesh-n',
          name: 'n',
          visible: true,
          src: { path: 'models/n.glb' },
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      ],
      verticalDatum: {
        absAltOffsetM: -18.5,
        note: 'Set at import: project height = absolute altitude + offset.',
      },
    };
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(savedBefore, null, 2)}\n`);
    expect(r.manifest).toEqual(await readManifest(root));
    expect(r.backup).toBe(`${file}.bak`);
  });
});

describe('removeCapture', () => {
  it('removes a survey date no layer names, and backs up', async () => {
    const root = await project();
    const r = await removeCapture(root, 'c2');
    expect(r.manifest.captures.map((c) => c.id)).toEqual(['c1']);
    expect((await readManifest(root)).captures.map((c) => c.id)).toEqual(['c1']);
    expect(r.backup).toBe(join(root, 'manifest.json.bak'));
    expect((await readFile(r.backup, 'utf8')).includes('c2')).toBe(true);
  });

  it('refuses a date a layer names and leaves the manifest as it was', async () => {
    const root = await project();
    await updateLayers(root, ['mesh-m'], { capture: 'c1' });
    const before = await readFile(join(root, 'manifest.json'), 'utf8');
    await expect(removeCapture(root, 'c1')).rejects.toThrow(
      '1 dataset is filed under this date. Move it first.',
    );
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('says how many datasets name the date when there are several', async () => {
    const root = await project();
    const m = await readManifest(root);
    const layer = m.layers.find((l) => l.id === 'mesh-m');
    if (!layer) throw new Error('no layer');
    await writeManifestFile(root, {
      ...m,
      layers: [
        { ...layer, capture: 'c1' },
        { ...layer, id: 'mesh-m2', capture: 'c1' },
      ],
    });
    await expect(removeCapture(root, 'c1')).rejects.toThrow(
      '2 datasets are filed under this date. Move them first.',
    );
  });

  it('refuses an unknown id', async () => {
    const root = await project();
    await expect(removeCapture(root, 'c9')).rejects.toThrow(
      'There is no survey date "c9" in this project.',
    );
  });
});
