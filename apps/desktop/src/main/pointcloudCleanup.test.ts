import { emptyCleanup, noiseCopyPath, noiseRunPath, type PointcloudCleanup } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import {
  cleanPackRefusal,
  readNoiseRun,
  registerPointcloudCleanupIpc,
  writeCleanup,
} from './pointcloudCleanup';

const NOW = new Date('2026-10-15T09:00:00.000Z');
const run = (layerId: string, runId: string) => ({
  path: noiseCopyPath(layerId, runId),
  params: { outlier: { meanK: 8, multiplier: 2 } },
  marked: 60,
  total: 16060,
  runId,
});

describe('point cloud cleanup IPC', () => {
  let root = '';
  let ipc: ReturnType<typeof collectHandlers>;
  const archive = new Map<string, Buffer>();
  const active = new Set<string>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pccleanup-'));
    ipc = collectHandlers((handle) => {
      registerPointcloudCleanupIpc({
        handle,
        projects: {
          root: (id) => (id === 'p' ? root : undefined),
          package: (id) => (id === 'pkg' ? {} : undefined),
        },
        projectPackage: () => ({
          entries: archive,
          read: (n) => Promise.resolve(archive.get(n) ?? Buffer.alloc(0)),
        }),
        now: () => NOW,
        activeRuns: () => active,
      });
    });
  });
  afterEach(async () => {
    archive.clear();
    await rm(root, { recursive: true, force: true });
  });

  const put = async (rel: string, body: string) => {
    await mkdir(join(root, 'edits', 'pointcloud'), { recursive: true });
    await writeFile(join(root, rel), body);
  };

  it('registers the two channels', () => {
    expect(ipc.channels()).toEqual(['pointcloud:readCleanup', 'pointcloud:writeCleanup']);
  });

  it('reads no recipes, then every valid one, skipping damaged files and noise records', async () => {
    expect(await ipc.call('pointcloud:readCleanup', { projectId: 'p' })).toEqual({
      ok: true,
      recipes: [],
      readOnly: false,
    });
    await put(
      'edits/pointcloud/a.json',
      JSON.stringify({ ...emptyCleanup('a'), hiddenClasses: [7] }),
    );
    await put('edits/pointcloud/b.json', '{ not json');
    await put('edits/pointcloud/c.json', JSON.stringify(emptyCleanup('other'))); // wrong layer
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    const r = await ipc.call('pointcloud:readCleanup', { projectId: 'p' });
    expect(r.ok && r.recipes.map((x) => x.layerId)).toEqual(['a']);
  });

  it('reads the record of a noise run, or null', async () => {
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    const r = await ipc.call('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'j1' },
    });
    expect(r.ok && r.noise?.marked).toBe(60);
    const none = await ipc.call('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'j2' },
    });
    expect(none.ok && none.noise).toBeNull();
  });

  it('writes a recipe atomically with a .bak of the one before', async () => {
    const first = emptyCleanup('a');
    expect(
      await ipc.call('pointcloud:writeCleanup', { projectId: 'p', layerId: 'a', recipe: first }),
    ).toEqual({
      ok: true,
      trashed: [],
    });
    const second: PointcloudCleanup = { ...first, hiddenClasses: [7] };
    await ipc.call('pointcloud:writeCleanup', { projectId: 'p', layerId: 'a', recipe: second });
    const path = join(root, 'edits', 'pointcloud', 'a.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(second);
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8'))).toEqual(first);
  });

  it('refuses a recipe of another layer, an unsafe layer id and a package', async () => {
    const other = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: emptyCleanup('b'),
    });
    expect(other.ok).toBe(false);
    // the contract refuses it before any handler (or the journal) runs
    await expect(
      ipc.call('pointcloud:writeCleanup', { projectId: 'p', layerId: '../a', recipe: null }),
    ).rejects.toThrow(/Not a valid layer id/);
    // and the handler's own check stays as a second line
    expect(await writeCleanup(root, '../a', null, undefined, NOW)).toMatchObject({ ok: false });
    expect(await readNoiseRun(root, '../a', 'j1')).toBeNull();
    expect(await readdir(root)).toEqual([]);
    const pkg = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'pkg',
      layerId: 'a',
      recipe: emptyCleanup('a'),
    });
    expect(pkg).toMatchObject({ ok: false });
  });

  it('keeps copies the history still names and trashes the others', async () => {
    await put(noiseCopyPath('a', 'j1'), 'copc 1');
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    await put(noiseCopyPath('a', 'j2'), 'copc 2');
    await put(noiseRunPath('a', 'j2'), JSON.stringify(run('a', 'j2')));
    await put(noiseCopyPath('b', 'j3'), 'another layer');
    const recipe = { ...emptyCleanup('a'), noise: run('a', 'j2') };
    const r = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe,
      keep: [],
    });
    expect(r).toEqual({
      ok: true,
      trashed: [noiseCopyPath('a', 'j1'), noiseRunPath('a', 'j1')],
    });
    expect(existsSync(join(root, noiseCopyPath('a', 'j1')))).toBe(false);
    expect(existsSync(join(root, noiseCopyPath('a', 'j2')))).toBe(true);
    expect(existsSync(join(root, noiseCopyPath('b', 'j3')))).toBe(true);
    const trash = await readdir(join(root, '.trash'));
    expect(trash).toHaveLength(1);
    // undo of the noise run: j2 is no longer in the recipe, but redo still names it
    const undone = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: emptyCleanup('a'),
      keep: [noiseCopyPath('a', 'j2')],
    });
    expect(undone).toEqual({ ok: true, trashed: [] });
  });

  it("a null recipe removes the file, keeps a .bak and trashes the layer's noise copies", async () => {
    await put('edits/pointcloud/a.json', JSON.stringify(emptyCleanup('a')));
    await put(noiseCopyPath('a', 'j1'), 'copc 1');
    const r = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: null,
    });
    expect(r).toEqual({ ok: true, trashed: [noiseCopyPath('a', 'j1')] });
    expect(existsSync(join(root, 'edits', 'pointcloud', 'a.json'))).toBe(false);
    expect(existsSync(join(root, 'edits', 'pointcloud', 'a.json.bak'))).toBe(true);
  });

  it('writes again after a reset, and after undoing it', async () => {
    const w = (recipe: PointcloudCleanup | null) =>
      ipc.call('pointcloud:writeCleanup', { projectId: 'p', layerId: 'a', recipe });
    const first = { ...emptyCleanup('a'), hiddenClasses: [7] };
    expect(await w(first)).toMatchObject({ ok: true });
    expect(await w(null)).toMatchObject({ ok: true });
    expect(await w({ ...first, hiddenClasses: [6] })).toMatchObject({ ok: true });
    expect(await w(null)).toMatchObject({ ok: true });
    expect(await w(first)).toMatchObject({ ok: true }); // undo of the reset
    const path = join(root, 'edits', 'pointcloud', 'a.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(first);
  });

  it('refuses a noise path that is not the copy of its run', async () => {
    const bad = {
      ...emptyCleanup('a'),
      noise: { ...run('a', 'j1'), path: noiseCopyPath('b', 'j1') },
    };
    const r = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: bad,
      keep: [],
    });
    expect(r.ok).toBe(false);
  });

  it('sweeps only on a reset or when asked, and never the files of a running job', async () => {
    await put(noiseCopyPath('a', 'j1'), 'copc 1');
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    // an ordinary step (no keep) leaves every working copy alone
    expect(
      await ipc.call('pointcloud:writeCleanup', {
        projectId: 'p',
        layerId: 'a',
        recipe: emptyCleanup('a'),
      }),
    ).toEqual({ ok: true, trashed: [] });
    expect(existsSync(join(root, noiseCopyPath('a', 'j1')))).toBe(true);
    // a sweep while the job of j1 runs leaves its files
    active.add('j1');
    expect(
      await ipc.call('pointcloud:writeCleanup', {
        projectId: 'p',
        layerId: 'a',
        recipe: null,
      }),
    ).toEqual({ ok: true, trashed: [] });
    expect(existsSync(join(root, noiseCopyPath('a', 'j1')))).toBe(true);
    active.clear();
    const r = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: null,
    });
    expect(r).toEqual({ ok: true, trashed: [noiseCopyPath('a', 'j1'), noiseRunPath('a', 'j1')] });
  });

  it('reads no noise record that is not the one asked for', async () => {
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j2')));
    const r = await ipc.call('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'j1' },
    });
    expect(r.ok && r.noise).toBeNull();
  });

  it('reads the recipes of a package and calls it read-only', async () => {
    archive.set('edits/pointcloud/a.json', Buffer.from(JSON.stringify(emptyCleanup('a'))));
    const r = await ipc.call('pointcloud:readCleanup', { projectId: 'pkg' });
    expect(r).toEqual({ ok: true, recipes: [emptyCleanup('a')], readOnly: true });
  });
});

describe('the pack gate', () => {
  it('refuses pointcloud.clean on an older pack only', () => {
    expect(cleanPackRefusal('pointcloud.clean', '0.9.0')).toMatch(
      /needs processing tools 0.12.0 or later \(these are 0\.9\.0\)/,
    );
    expect(cleanPackRefusal('pointcloud.clean', '0.12.0')).toBeNull();
    expect(cleanPackRefusal('pointcloud.clean', 'dev')).toBeNull();
    expect(cleanPackRefusal('pointcloud.clean', null)).toBeNull();
    expect(cleanPackRefusal('pointcloud.to_copc', '0.9.0')).toBeNull();
  });
});
