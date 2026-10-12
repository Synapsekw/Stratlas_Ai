import { WALK_PATH_SCHEMA, type WalkCalibration, type WalkRawPath } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, updateLayers, updateManifestFile } from './create';
import { refreshWalkPaths } from './walkLayers';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-walk-refresh-'));
  root = (
    await createProject(dir, {
      name: 'Refresh',
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

const DURATION = 20;
const cal = (): WalkCalibration => ({
  pins: [
    { t: 0, surface: '@model', at: [0, 0], y: 0 },
    { t: 20, surface: '@model', at: [20, 0], y: 0 },
  ],
  yawOffsetDeg: 0,
  heightM: 1.7,
  quality: 'unplaced',
});

/** A path that bulges between its ends, so the fit of it differs from a straight line. */
const bulged = (): WalkRawPath => ({
  schema: WALK_PATH_SCHEMA,
  walk: 'w',
  source: 'sfm',
  up: [0, 1, 0],
  stills: Array.from({ length: DURATION + 1 }, (_, t) => ({
    n: t * 30,
    t,
    pos: [t * 0.5, 0, 4 * Math.sin((t / DURATION) * Math.PI)] as [number, number, number],
    q: [0, 0, 0, 1] as [number, number, number, number],
    segment: 0,
    steps: t * 2,
  })),
});

interface PoseDoc {
  samples: { t: number; pos: [number, number, number] }[];
}
const readPose = async (): Promise<PoseDoc> =>
  JSON.parse(await readFile(join(root, 'walks', 'w', 'pose.json'), 'utf8')) as PoseDoc;

async function placedPinsOnlyWalk(): Promise<void> {
  const folder = join(root, 'walks', 'w');
  await mkdir(folder, { recursive: true });
  const walk = {
    schema: 'aio.walk/1',
    id: 'w',
    name: 'Walk w',
    createdAt: '2026-10-10T08:00:00.000Z',
    source: {
      file: 'w.insv',
      layout: 'insv-dual-stream',
      streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }],
    },
    video: {
      src: 'walks/w/playback.mp4',
      width: 256,
      height: 128,
      durationS: DURATION,
      fps: 30,
      audio: false,
    },
  };
  await writeFile(join(folder, 'walk.json'), JSON.stringify(walk));
  await updateManifestFile(root, (m) => ({
    manifest: {
      ...m,
      layers: [
        ...m.layers,
        {
          kind: 'walk' as const,
          id: 'walk-w',
          name: 'Walk w',
          visible: true,
          record: { path: 'walks/w/walk.json' },
          src: { path: 'walks/w/playback.mp4' },
          durationS: DURATION,
        },
      ],
    },
  }));
  await updateLayers(root, ['walk-w'], { walk: cal() });
}

describe('refreshWalkPaths, pose', () => {
  it('rewrites the pose of a placed walk when its raw path appears', async () => {
    await placedPinsOnlyWalk();
    const before = await readPose();
    const mid = Math.floor(before.samples.length / 2);
    expect(before.samples[mid]?.pos[2]).toBeCloseTo(0, 6);

    await writeFile(join(root, 'walks', 'w', 'raw-path.json'), JSON.stringify(bulged()));
    expect(await refreshWalkPaths(root)).toEqual(['walk-w']);

    const after = await readPose();
    // the SfM path bulges 4 units between the pins; the pins-only line did not
    expect(Math.abs(after.samples[mid]?.pos[2] ?? 0)).toBeGreaterThan(1);
    const layer = (await readManifestFile(root)).layers.find((l) => l.id === 'walk-w');
    expect(layer).toMatchObject({
      path: { raw: { path: 'walks/w/raw-path.json' } },
      flight: { src: { path: 'walks/w/pose.json' } },
    });
    expect(layer?.kind === 'walk' ? layer.place?.quality : '').not.toBe('unplaced');
    // nothing is stale now
    expect(await refreshWalkPaths(root)).toEqual([]);
  });

  it('rewrites the pose when the raw path was written again after the pose', async () => {
    await placedPinsOnlyWalk();
    const raw = join(root, 'walks', 'w', 'raw-path.json');
    await writeFile(raw, JSON.stringify(bulged()));
    await refreshWalkPaths(root);
    const flat = bulged();
    for (const s of flat.stills) if (s.pos) s.pos = [s.pos[0], 0, 0];
    await writeFile(raw, JSON.stringify(flat));
    const later = new Date(Date.now() + 5000);
    await utimes(raw, later, later);
    expect(await refreshWalkPaths(root)).toEqual(['walk-w']);
    const pose = await readPose();
    const mid = Math.floor(pose.samples.length / 2);
    expect(Math.abs(pose.samples[mid]?.pos[2] ?? 9)).toBeLessThan(0.01);
  });

  it('leaves the old pose.json when the manifest save is refused', async () => {
    await placedPinsOnlyWalk();
    const pose = join(root, 'walks', 'w', 'pose.json');
    const before = await readFile(pose, 'utf8');
    await writeFile(join(root, 'walks', 'w', 'raw-path.json'), JSON.stringify(bulged()));
    // a folder where the backup goes: the save refuses before it writes the manifest
    await rm(join(root, 'manifest.json.bak'), { force: true });
    await mkdir(join(root, 'manifest.json.bak'));
    await expect(refreshWalkPaths(root)).rejects.toThrow();
    expect(await readFile(pose, 'utf8')).toBe(before);
  });

  it('names a raw path it cannot read and keeps the walk placed by its pins', async () => {
    await placedPinsOnlyWalk();
    await writeFile(join(root, 'walks', 'w', 'raw-path.json'), '{ not json');
    const lines: string[] = [];
    await refreshWalkPaths(root, (l) => lines.push(l));
    expect(lines.join('\n')).toContain('walks/w/raw-path.json');
    expect((await readPose()).samples.length).toBeGreaterThan(0);
  });
});
