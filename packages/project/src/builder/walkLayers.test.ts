import { WALK_SCHEMA, type Capture, type ProjectManifest, type WalkFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, ensureCapture, readManifestFile, updateManifestFile } from './create';
import {
  NO_WALK_FILES,
  WALK_LAYER_MARK,
  migrateWalks,
  missingWalkLayers,
  refreshWalkPaths,
  walkCaptureFor,
  walkLayerFor,
  walkLayerId,
} from './walkLayers';
import { removeWalk } from './walkRemove';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-walk-layers-'));
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
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const walk = (id: string, capturedAt?: string): WalkFile => ({
  schema: WALK_SCHEMA,
  id,
  name: `Walk ${id}`,
  createdAt: '2026-10-10T08:00:00.000Z',
  source: {
    file: `${id}.insv`,
    layout: 'insv-dual-stream',
    streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }],
    ...(capturedAt ? { capturedAt } : {}),
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

async function putWalk(id: string, capturedAt?: string, extra: string[] = []): Promise<void> {
  const folder = join(root, 'walks', id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'walk.json'), JSON.stringify(walk(id, capturedAt)));
  for (const f of extra) await writeFile(join(folder, f), '{}');
}

const cap = (id: string, date: string): Capture => ({ id, label: 'Survey', date });
const none = { layers: [], captures: [] };

describe('walk layers', () => {
  it('adds one layer per side-folder walk', async () => {
    await putWalk('x');
    await putWalk('y');
    const r = await migrateWalks(root);
    expect(r.saved).toBe(true);
    expect(r.added.map((l) => l.id).sort()).toEqual(['walk-x', 'walk-y']);
    const m = await readManifestFile(root);
    expect(m.layers.filter((l) => l.kind === 'walk')).toHaveLength(2);
    expect(m.layers.find((l) => l.id === 'walk-x')).toMatchObject({
      kind: 'walk',
      name: 'Walk x',
      visible: true,
      record: { path: 'walks/x/walk.json' },
      src: { path: 'walks/x/playback.mp4' },
      poster: { path: 'walks/x/poster.jpg' },
      durationS: 12,
    });
  });

  it('sets the capture on a single exact date match', () => {
    const w = walk('x', '2026-01-01T12:00:00');
    expect(walkCaptureFor(w, [cap('c1', '2026-01-01'), cap('c2', '2026-01-02')])).toBe('c1');
    const layer = walkLayerFor(
      w,
      { layers: [], captures: [cap('c1', '2026-01-01')] },
      NO_WALK_FILES,
    );
    expect(layer.capture).toBe('c1');
  });

  it('sets no capture when two dates match or none does', () => {
    const w = walk('x', '2026-01-01T12:00:00');
    expect(walkCaptureFor(w, [cap('a', '2026-01-01'), cap('b', '2026-01-01')])).toBeUndefined();
    expect(walkCaptureFor(w, [cap('a', '2026-01-02')])).toBeUndefined();
    expect(walkCaptureFor(walk('y'), [cap('a', '2026-01-01')])).toBeUndefined();
    expect('capture' in walkLayerFor(w, none, NO_WALK_FILES)).toBe(false);
  });

  it('puts the walk on its survey date when the project has it', async () => {
    const c = await ensureCapture(root, '2026-01-01');
    await putWalk('x', '2026-01-01T12:00:00');
    const r = await migrateWalks(root);
    expect(r.added[0]?.capture).toBe(c.captureId);
  });

  it('is idempotent', async () => {
    await putWalk('x');
    await putWalk('y');
    await migrateWalks(root);
    const again = await migrateWalks(root);
    expect(again).toEqual({ added: [], saved: false });
    expect((await readManifestFile(root)).layers.filter((l) => l.kind === 'walk')).toHaveLength(2);
  });

  it('matches by record path, not id', async () => {
    await putWalk('x');
    await updateManifestFile(root, (m) => ({
      manifest: {
        ...m,
        layers: [
          ...m.layers,
          {
            kind: 'walk',
            id: 'walk-x-2',
            name: 'Renamed',
            visible: true,
            record: { path: 'walks/x/walk.json' },
            src: { path: 'walks/x/playback.mp4' },
            durationS: 12,
          },
        ],
      },
    }));
    const r = await migrateWalks(root);
    expect(r).toEqual({ added: [], saved: false });
  });

  it('takes the next id when walk-x is used by another layer', () => {
    expect(walkLayerId('x', new Set(['walk-x']))).toBe('walk-x-2');
    expect(walkLayerId('x', new Set(['walk-x', 'walk-x-2']))).toBe('walk-x-3');
    const m = {
      layers: [{ kind: 'markers', id: 'walk-x', name: 'M', visible: true }],
      captures: [],
    } as unknown as ProjectManifest;
    expect(missingWalkLayers([walk('x')], m, () => NO_WALK_FILES)[0]?.id).toBe('walk-x-2');
  });

  it('fills path when raw-path.json exists, and later when it appears', async () => {
    await putWalk('x', undefined, ['raw-path.json', 'orientation.json', 'orientation.bin']);
    await putWalk('y');
    const r = await migrateWalks(root);
    expect(r.added.find((l) => l.id === 'walk-x')?.path).toEqual({
      raw: { path: 'walks/x/raw-path.json' },
      orientation: { path: 'walks/x/orientation.json' },
      orientationData: { path: 'walks/x/orientation.bin' },
    });
    expect(r.added.find((l) => l.id === 'walk-y')?.path).toBeUndefined();
    expect(await refreshWalkPaths(root)).toEqual([]);
    await writeFile(join(root, 'walks', 'y', 'raw-path.json'), '{}');
    expect(await refreshWalkPaths(root)).toEqual(['walk-y']);
    const y = (await readManifestFile(root)).layers.find((l) => l.id === 'walk-y');
    expect(y).toMatchObject({ path: { raw: { path: 'walks/y/raw-path.json' } } });
    expect(await refreshWalkPaths(root)).toEqual([]);
  });

  it('keeps unknown layers on save', async () => {
    const file = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as { layers: unknown[] };
    raw.layers.push({ kind: 'hologram', id: 'future-1', name: 'From a newer build', extra: 7 });
    await writeFile(file, JSON.stringify(raw));
    await putWalk('x');
    const r = await migrateWalks(root);
    expect(r.saved).toBe(true);
    const after = JSON.parse(await readFile(file, 'utf8')) as { layers: { id: string }[] };
    expect(after.layers.map((l) => l.id).sort()).toEqual(['future-1', 'walk-x']);
    expect(after.layers.find((l) => l.id === 'future-1')).toMatchObject({
      kind: 'hologram',
      extra: 7,
    });
  });

  it('reports a failed save and keeps the layers in memory', async () => {
    await putWalk('x');
    const r = await migrateWalks(root, {
      update: () => Promise.reject(new Error('disk full')),
    });
    expect(r.saved).toBe(false);
    expect(r.error).toBe('disk full');
    expect(r.added.map((l) => l.id)).toEqual(['walk-x']);
    expect((await readManifestFile(root)).layers.some((l) => l.kind === 'walk')).toBe(false);
    // not marked: the next open tries again
    expect(await exists(join(root, 'walks', 'x', WALK_LAYER_MARK))).toBe(false);
    expect((await migrateWalks(root)).added.map((l) => l.id)).toEqual(['walk-x']);
  });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const walkLayersOnDisk = async () =>
  (await readManifestFile(root)).layers.filter((l) => l.kind === 'walk');

describe('walk layers: each walk is migrated once', () => {
  it('migrates a walk from before once and marks its folder', async () => {
    await putWalk('x');
    expect(await exists(join(root, 'walks', 'x', WALK_LAYER_MARK))).toBe(false);
    expect((await migrateWalks(root)).added.map((l) => l.id)).toEqual(['walk-x']);
    expect(await exists(join(root, 'walks', 'x', WALK_LAYER_MARK))).toBe(true);
  });

  it('does not add a walk again when its layer was taken out elsewhere and the folder stayed', async () => {
    await putWalk('x');
    await migrateWalks(root);
    // another copy removed the walk: the merged manifest has no layer, this folder is still here
    await updateManifestFile(root, (m) => ({
      manifest: { ...m, layers: m.layers.filter((l) => l.kind !== 'walk') },
    }));
    expect(await migrateWalks(root)).toEqual({ added: [], saved: false });
    expect(await walkLayersOnDisk()).toHaveLength(0);
  });

  it('does not bring back a removed walk whose folder is put back', async () => {
    await putWalk('x');
    await migrateWalks(root);
    await removeWalk(root, 'walk-x');
    const [trashed] = await readdir(join(root, '.trash'));
    if (trashed === undefined) throw new Error('nothing in .trash');
    await rename(join(root, '.trash', trashed), join(root, 'walks', 'x'));
    expect((await migrateWalks(root)).added).toEqual([]);
    expect(await walkLayersOnDisk()).toHaveLength(0);
  });

  it('marks a walk whose layer is already there (made by another copy)', async () => {
    await putWalk('x');
    await updateManifestFile(root, (m) => ({
      manifest: {
        ...m,
        layers: [...m.layers, ...missingWalkLayers([walk('x')], m, () => NO_WALK_FILES)],
      },
    }));
    expect((await migrateWalks(root)).added).toEqual([]);
    expect(await exists(join(root, 'walks', 'x', WALK_LAYER_MARK))).toBe(true);
    await updateManifestFile(root, (m) => ({
      manifest: { ...m, layers: m.layers.filter((l) => l.kind !== 'walk') },
    }));
    expect((await migrateWalks(root)).added).toEqual([]);
  });
});
