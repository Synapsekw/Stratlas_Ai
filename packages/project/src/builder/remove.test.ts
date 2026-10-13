import { TrashRecord } from '@aio/schema';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename as fsRename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifestFile } from './manifestFile';
import { MANIFEST_BEFORE, removeItems } from './remove';
import { FIXTURE_JOBS, RUN_DONE, RUN_FAILED, makeRemoveProject } from './removeFixture';
import { planRemoval } from './removePlan';

let dir: string;
let root: string;
beforeEach(async () => {
  ({ dir, root } = await makeRemoveProject());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-13T08:15:30.000Z');
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const at = (...p: string[]) => join(root, ...p);
const trashEntries = () => readdir(at('.trash')).catch(() => [] as string[]);
const tilesetIds = async () =>
  (
    JSON.parse(await readFile(at('tilesets.json'), 'utf8')) as { entries: { id: string }[] }
  ).entries.map((e) => e.id);
const busy = (msg: string) => Object.assign(new Error(msg), { code: 'EBUSY' });

describe('removeItems', () => {
  it('moves the files in their project layout and writes removed.json and the manifest before', async () => {
    const r = await removeItems(root, [{ run: RUN_FAILED }], () => NOW, { jobs: FIXTURE_JOBS });
    const entry = `20261013T081530Z-run-${RUN_FAILED}`;
    expect(r.trash).toBe(entry);
    expect(await trashEntries()).toEqual([entry]);
    expect(await exists(at('.trash', entry, 'photogrammetry', RUN_FAILED, 'run.json'))).toBe(true);
    expect(await exists(at('.trash', entry, 'rasters', `${RUN_FAILED}-ortho`, 'tiles.json'))).toBe(
      true,
    );
    expect(await exists(at('.trash', entry, 'jobs', 'job-failed', 'job.log'))).toBe(true);
    expect(await exists(at('photogrammetry', RUN_FAILED))).toBe(false);
    expect(r.manifest.layers.some((l) => l.id === `${RUN_FAILED}-ortho`)).toBe(false);
    expect((await readManifestFile(root)).layers.some((l) => l.id === `${RUN_FAILED}-ortho`)).toBe(
      false,
    );
    const rec = TrashRecord.parse(
      JSON.parse(await readFile(at('.trash', entry, 'removed.json'), 'utf8')),
    );
    expect(rec).toMatchObject({
      at: NOW.toISOString(),
      targets: [{ run: RUN_FAILED }],
      manifestBefore: MANIFEST_BEFORE,
    });
    expect(rec.plan.jobs).toEqual(['job-failed']);
    expect(await readFile(at('.trash', entry, MANIFEST_BEFORE), 'utf8')).toContain(
      `${RUN_FAILED}-ortho`,
    );
  });

  it('rewrites tilesets.json and keeps a copy in the trash', async () => {
    const r = await removeItems(root, [{ layer: `${RUN_DONE}-dsm` }], () => NOW);
    expect((await tilesetIds()).sort()).toEqual([`${RUN_DONE}-mesh`, 'b-tiles'].sort());
    const copy = JSON.parse(
      await readFile(at('.trash', r.trash ?? '', 'tilesets.json'), 'utf8'),
    ) as {
      entries: unknown[];
    };
    expect(copy.entries).toHaveLength(3);
    expect(await exists(at('tiles', 'dsm-tiles'))).toBe(false);
  });

  it('rewrites tilesets.json into a fresh entry when no file is left to move', async () => {
    for (const p of [
      ['rasters', `${RUN_DONE}-dsm`],
      ['rasters', 'chg-1-heat'],
      ['tiles', 'dsm-tiles'],
      ['change'],
      ['survey', 'surfaces'],
    ])
      await rm(at(...p), { recursive: true, force: true });
    const r = await removeItems(root, [{ layer: `${RUN_DONE}-dsm` }], () => NOW);
    expect(r.plan.files).toEqual([]);
    expect(r.trash).not.toBeNull();
    expect(await tilesetIds()).not.toContain('dsm-tiles');
    expect(await exists(at('.trash', r.trash ?? '', 'tilesets.json'))).toBe(true);
    expect(await exists(at('.trash', r.trash ?? '', 'removed.json'))).toBe(true);
  });

  it('removes a date and everything filed under it in one save', async () => {
    const r = await removeItems(root, [{ capture: 'c1' }], () => NOW, { jobs: FIXTURE_JOBS });
    expect(r.manifest.captures.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(r.manifest.layers.some((l) => l.capture === 'c1')).toBe(false);
    expect(r.manifest.layers.some((l) => l.id === 'dsm-b')).toBe(true);
  });

  it('waits for a file held open for a moment (Windows)', async () => {
    let n = 0;
    const rename = async (a: string, b: string) => {
      n += 1;
      if (n <= 2) throw busy('held by a viewer');
      await fsRename(a, b);
    };
    const r = await removeItems(root, [{ layer: 'clip-1' }], () => NOW, {
      rename,
      platform: 'win32',
      sleep: () => Promise.resolve(),
    });
    expect(r.trash).not.toBeNull();
    expect(await exists(at('video', 'clip-1.mp4'))).toBe(false);
  });

  it('rolls back when the third move fails', async () => {
    const before = (await planRemoval(root, [{ layer: 'photos-a' }], { jobs: FIXTURE_JOBS })).files;
    let n = 0;
    const rename = async (a: string, b: string) => {
      n += 1;
      if (n === 3) throw busy('photos/p1.jpg is held open');
      await fsRename(a, b);
    };
    await expect(
      removeItems(root, [{ layer: 'photos-a' }], () => NOW, {
        jobs: FIXTURE_JOBS,
        rename,
        platform: 'linux',
      }),
    ).rejects.toThrow(/held open.*Nothing was removed\./);
    for (const f of before) expect(await exists(at(...f.split('/'))), f).toBe(true);
    expect((await readManifestFile(root)).layers.some((l) => l.id === 'photos-a')).toBe(true);
    expect(await trashEntries()).toEqual([]);
  });

  it('leaves the files in the trash with removed.json when the way back is refused too', async () => {
    let n = 0;
    const rename = async (a: string, b: string) => {
      n += 1;
      if (n >= 3) throw busy('held');
      await fsRename(a, b);
    };
    await expect(
      removeItems(root, [{ layer: 'photos-a' }], () => NOW, {
        jobs: FIXTURE_JOBS,
        rename,
        platform: 'linux',
      }),
    ).rejects.toThrow(/could not be moved back.*\.trash/);
    const [entry] = await trashEntries();
    expect(entry).toBeDefined();
    expect(await exists(at('.trash', entry ?? '', 'removed.json'))).toBe(true);
  });

  it('rolls back files and tilesets.json when the save fails', async () => {
    // a folder where the backup goes: the save refuses before it writes the manifest
    await rm(at('manifest.json.bak'), { force: true });
    await mkdir(at('manifest.json.bak'));
    await expect(removeItems(root, [{ layer: `${RUN_DONE}-dsm` }], () => NOW)).rejects.toThrow();
    expect(await tilesetIds()).toHaveLength(3);
    expect(await exists(at('rasters', `${RUN_DONE}-dsm`, 'tiles.json'))).toBe(true);
    expect(await exists(at('change', 'chg-1.json'))).toBe(true);
    expect((await readManifestFile(root)).layers.some((l) => l.id === `${RUN_DONE}-dsm`)).toBe(
      true,
    );
    expect(await trashEntries()).toEqual([]);
  });

  it('plans again from disk: a job started since refuses and nothing moves', async () => {
    const jobs = [
      { id: 'j1', pipeline: 'photo.products', status: 'starting', params: { run: RUN_DONE } },
    ];
    await expect(removeItems(root, [{ run: RUN_DONE }], () => NOW, { jobs })).rejects.toThrow(
      /still running/,
    );
    expect(await exists(at('photogrammetry', RUN_DONE, 'run.json'))).toBe(true);
    expect(await trashEntries()).toEqual([]);
  });

  it('moves nothing when a raster folder is a junction', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await writeFile(join(outside, 'precious.tif'), 'keep');
      await rm(at('rasters', 'dsm-c'), { recursive: true });
      await symlink(outside, at('rasters', 'dsm-c'), 'junction');
      await expect(removeItems(root, [{ layer: 'dsm-c' }], () => NOW)).rejects.toThrow(
        /outside the project/,
      );
      expect(await readFile(join(outside, 'precious.tif'), 'utf8')).toBe('keep');
      expect((await readManifestFile(root)).layers.some((l) => l.id === 'dsm-c')).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('moves nothing when .trash is a junction', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await symlink(outside, at('.trash'), 'junction');
      await expect(removeItems(root, [{ layer: 'clip-1' }], () => NOW)).rejects.toThrow(
        /\.trash.*Nothing was removed\./,
      );
      expect(await readdir(outside)).toEqual([]);
      expect(await exists(at('video', 'clip-1.mp4'))).toBe(true);
      expect((await readManifestFile(root)).layers.some((l) => l.id === 'clip-1')).toBe(true);
    } finally {
      await rm(at('.trash'), { force: true, recursive: false }).catch(() => undefined);
      await rm(outside, { recursive: true, force: true });
    }
  });
});
