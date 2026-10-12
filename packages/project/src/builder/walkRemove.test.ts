import { WALK_SCHEMA, type WalkFile } from '@aio/schema';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, writeManifestFile } from './create';
import { migrateWalks } from './walkLayers';
import { removeWalk, sweepTrash } from './walkRemove';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-walk-remove-'));
  root = (
    await createProject(dir, {
      name: 'Walks',
      type: 'inspection',
      epsg: 32639,
      origin: [500000, 3200000, 0],
      severityTemplate: null,
    })
  ).root;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const walk = (id: string): WalkFile => ({
  schema: WALK_SCHEMA,
  id,
  name: `Walk ${id}`,
  createdAt: '2026-10-10T08:00:00.000Z',
  source: {
    file: `${id}.insv`,
    layout: 'insv-dual-stream',
    streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }],
  },
  video: {
    src: `walks/${id}/playback.mp4`,
    width: 256,
    height: 128,
    durationS: 12,
    fps: 30,
    audio: false,
  },
  poster: `walks/${id}/poster.jpg`,
});

async function addWalk(id: string): Promise<void> {
  await mkdir(join(root, 'walks', id), { recursive: true });
  await writeFile(join(root, 'walks', id, 'walk.json'), JSON.stringify(walk(id)));
  await writeFile(join(root, 'walks', id, 'playback.mp4'), 'x');
  await migrateWalks(root);
}

const NOW = new Date('2026-10-12T08:15:30.000Z');
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('removeWalk', () => {
  it('removes the layer and moves the folder to .trash', async () => {
    await addWalk('w1');
    const before = await readManifestFile(root);
    expect(before.layers.map((l) => l.id)).toContain('walk-w1');
    const m = await removeWalk(root, 'walk-w1', () => NOW);
    expect(m.layers.some((l) => l.id === 'walk-w1')).toBe(false);
    expect((await readManifestFile(root)).layers.some((l) => l.id === 'walk-w1')).toBe(false);
    expect(await exists(join(root, 'walks', 'w1'))).toBe(false);
    expect(await readdir(join(root, '.trash'))).toEqual(['20261012T081530Z-w1']);
    expect(await exists(join(root, '.trash', '20261012T081530Z-w1', 'playback.mp4'))).toBe(true);
  });

  it('refuses a layer that is not a walk, and an unknown one', async () => {
    await addWalk('w1');
    const other = (await readManifestFile(root)).layers.find((l) => l.kind !== 'walk');
    if (other) await expect(removeWalk(root, other.id)).rejects.toThrow(/not a walk/);
    await expect(removeWalk(root, 'nope')).rejects.toThrow(/no layer/);
  });

  it('removes the layer when the folder is already gone', async () => {
    await addWalk('w1');
    await rm(join(root, 'walks', 'w1'), { recursive: true });
    const m = await removeWalk(root, 'walk-w1', () => NOW);
    expect(m.layers.some((l) => l.id === 'walk-w1')).toBe(false);
  });

  it('takes a free trash name when the same second is taken', async () => {
    await addWalk('w1');
    await mkdir(join(root, '.trash', '20261012T081530Z-w1'), { recursive: true });
    await removeWalk(root, 'walk-w1', () => NOW);
    expect((await readdir(join(root, '.trash'))).sort()).toEqual([
      '20261012T081530Z-w1',
      '20261012T081530Z-w1-2',
    ]);
  });
});

describe('sweepTrash', () => {
  it('keeps a 6-day-old entry and removes an 8-day-old one', async () => {
    const t = join(root, '.trash');
    await mkdir(join(t, '20261006T081530Z-a'), { recursive: true });
    await mkdir(join(t, '20261004T081530Z-b'), { recursive: true });
    const removed = await sweepTrash(root, () => NOW);
    expect(removed).toEqual(['20261004T081530Z-b']);
    expect(await readdir(t)).toEqual(['20261006T081530Z-a']);
  });

  it('answers nothing when there is no .trash', async () => {
    expect(await sweepTrash(root, () => NOW)).toEqual([]);
  });
});

describe('removeWalk: record paths stay inside the project', () => {
  for (const record of ['walks/../walk.json', 'walks/../evil/walk.json']) {
    it(`moves nothing for ${record}`, async () => {
      await addWalk('w1');
      await mkdir(join(root, 'evil'), { recursive: true });
      await writeFile(join(root, 'evil', 'walk.json'), 'keep');
      const m0 = await readManifestFile(root);
      await writeManifestFile(root, {
        ...m0,
        layers: m0.layers.map((l) =>
          l.id === 'walk-w1' && l.kind === 'walk' ? { ...l, record: { path: record } } : l,
        ),
      });
      const m = await removeWalk(root, 'walk-w1', () => NOW);
      expect(m.layers.some((l) => l.id === 'walk-w1')).toBe(false);
      expect(await exists(join(root, '.trash'))).toBe(false);
      expect(await exists(join(root, 'evil', 'walk.json'))).toBe(true);
      expect(await exists(join(root, 'walks', 'w1', 'walk.json'))).toBe(true);
      expect(await exists(join(root, 'manifest.json'))).toBe(true);
    });
  }
});
