import { parseManifest, type ProjectManifest } from '@aio/schema';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  ensureCapture,
  updateCapture,
  updateLayers,
  updateManifestFile,
  withManifest,
  writeManifestFile,
} from './create';
import { NO_PIPELINE, importRawFiles, type ImportDeps } from './raw';

// `rename` passes through unless a test refuses it: a rename Windows refuses for good cannot be
// made on purpose with real files without waiting out the whole retry
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const { rename: realRename } = await vi.importActual<typeof FsPromises>('node:fs/promises');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-manifest-'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation(realRename);
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const refusal = Object.assign(new Error('EPERM: operation not permitted, rename'), {
      code: 'EPERM',
    });
    vi.mocked(rename).mockImplementation(() => Promise.reject(refusal));
    // the waits between the tries on Windows (about 2.5 s) pass at once
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const state = { settled: false };
    const outcome = ensureCapture(root, '2026-02-01')
      .then(
        () => 'saved' as const,
        (e: unknown) => e,
      )
      .finally(() => {
        state.settled = true;
      });
    while (!state.settled) {
      await vi.advanceTimersByTimeAsync(5000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    vi.useRealTimers();
    expect(await outcome).toBe(refusal);
    expect(await partials(root)).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);

    // the refused save does not stand in the way of the next one
    vi.mocked(rename).mockImplementation(realRename);
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
    expect((await readManifest(root)).layers.map((l) => l.id)).toEqual(['mesh-m', 'mesh-n']);
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
