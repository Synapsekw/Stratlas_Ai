import type { Layer, ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  crsSidecar,
  exportLayers,
  exportPlan,
  insideRef,
  isLocalFrame,
  layerFolderName,
  mainFile,
  readLayerInfo,
} from './layerFiles';

let base: string;
let root: string;
let out: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-layerfiles-'));
  root = join(base, 'project');
  out = join(base, 'out');
  await mkdir(join(root, 'models'), { recursive: true });
  await mkdir(join(root, 'photos', 'ph'), { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(root, 'models', 'm.glb'), Buffer.alloc(2048, 1));
  await writeFile(join(root, 'photos', 'ph', 'a.jpg'), Buffer.alloc(10, 2));
  await writeFile(join(root, 'photos', 'ph', 'b.jpg'), Buffer.alloc(20, 3));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const mesh = {
  kind: 'mesh',
  id: 'm',
  name: 'Site: model?',
  visible: true,
  src: { path: 'models/m.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
} as unknown as Layer;
const photos = {
  kind: 'photos',
  id: 'ph',
  name: 'Flight A',
  visible: true,
  items: [
    { id: 'a', src: { path: 'photos/ph/a.jpg' }, pos: [0, 10, 0] },
    { id: 'b', src: { path: 'photos/ph/b.jpg' }, pos: [2, 12, -4] },
  ],
} as unknown as Layer;
const vector = {
  kind: 'vector',
  id: 'v',
  name: 'Flight A',
  visible: true,
  src: { path: 'vectors/v.geojson' },
  format: 'geojson',
} as unknown as Layer;
const m = {
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 20],
  layers: [mesh, photos, vector],
} as unknown as ProjectManifest;

describe('layer files', () => {
  it('names a folder safely on Windows', () => {
    expect(layerFolderName('Site: model?')).toBe('Site_ model_');
    expect(layerFolderName('CON')).toBe('CON_');
    expect(layerFolderName('trail. ')).toBe('trail');
    expect(layerFolderName('')).toBe('dataset');
  });

  it('plans the copy below the files common folder and finds the main file', () => {
    expect(exportPlan(photos)).toEqual([
      { from: 'photos/ph/a.jpg', to: 'a.jpg' },
      { from: 'photos/ph/b.jpg', to: 'b.jpg' },
    ]);
    expect(exportPlan(mesh)).toEqual([{ from: 'models/m.glb', to: 'm.glb' }]);
    expect(mainFile(photos)).toBe('photos/ph/a.jpg');
  });

  it('writes a CRS sidecar for local-frame layers only', () => {
    expect(isLocalFrame(mesh)).toBe(true);
    expect(isLocalFrame(vector)).toBe(false);
    expect(crsSidecar(m, mesh)).toMatchObject({
      schema: 'aio.layer-crs/1',
      crs: { epsg: 32639 },
      origin: [500000, 3200000, 20],
      transform: mesh.kind === 'mesh' ? mesh.transform : [],
    });
    expect(crsSidecar(m, vector)).toBeNull();
  });

  it('writes the date shift into the sidecar', () => {
    expect(crsSidecar(m, mesh, { eastM: 2.5, northM: -1 })).toMatchObject({
      dateShiftM: { eastM: 2.5, northM: -1 },
    });
    expect(crsSidecar(m, mesh)).not.toHaveProperty('dateShiftM');
    expect(crsSidecar(m, mesh, null)).not.toHaveProperty('dateShiftM');
  });

  it('writes the cloud height offset into the sidecar', () => {
    const cloud = (extra: object) =>
      ({
        kind: 'pointcloud',
        id: 'c',
        name: 'Cloud',
        visible: true,
        src: { path: 'clouds/c/index.json' },
        format: 'png-packed',
        ...extra,
      }) as unknown as Layer;
    expect(crsSidecar(m, cloud({ heightOffsetM: -30.81 }))?.heightOffsetM).toBe(-30.81);
    expect(crsSidecar(m, cloud({}))).not.toHaveProperty('heightOffsetM');
  });

  it('reads files, sizes, count and extent', async () => {
    const info = await readLayerInfo(root, m, photos, null);
    expect(info.files).toEqual([
      { path: 'photos/ph/a.jpg', bytes: 10 },
      { path: 'photos/ph/b.jpg', bytes: 20 },
    ]);
    expect(info.bytes).toBe(30);
    expect(info.count).toBe(2);
    expect(info.countKind).toBe('items');
    expect(info.extent).toEqual({ min: [0, 10, -4], max: [2, 12, 0] });
    expect(info.mainFile).toBe('photos/ph/a.jpg');
    expect(info.importedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('gives a walk the extent of its placed path, never of its pins', async () => {
    await mkdir(join(root, 'walks', 'w'), { recursive: true });
    await writeFile(join(root, 'walks', 'w', 'walk.json'), '{}');
    await writeFile(join(root, 'walks', 'w', 'walk.mp4'), 'v');
    const walk = {
      kind: 'walk',
      id: 'walk-w',
      name: 'Walk',
      visible: true,
      record: { path: 'walks/w/walk.json' },
      src: { path: 'walks/w/walk.mp4' },
      durationS: 3,
      // plan pixels, far from the path: must not be read as metres
      place: { pins: [{ surface: 'plan', at: [4000, 3000] }] },
    } as unknown as Layer;
    const none = await readLayerInfo(root, m, walk, null);
    expect(none.extent).toBeNull();
    await writeFile(
      join(root, 'walks', 'w', 'pose.json'),
      JSON.stringify({
        schema: 'aio.flight/1',
        samples: [
          { t: 0, pos: [1, 2, 3] },
          { t: 100, pos: [-4, 2.5, 9] },
        ],
      }),
    );
    const placed = { ...walk, flight: { src: { path: 'walks/w/pose.json' }, startUtcMs: 0 } };
    const info = await readLayerInfo(root, m, placed, null);
    expect(info.extent).toEqual({ min: [-4, 2, 3], max: [1, 2.5, 9] });
  });

  it('copies files unchanged with a sidecar, and reports progress', async () => {
    const seen: number[] = [];
    const r = await exportLayers(root, m, ['m', 'ph'], out, {
      progress: (done) => seen.push(done),
    });
    expect(r).toEqual({ written: 2, skipped: [], cancelled: false });
    expect(await readFile(join(out, 'Site_ model_', 'm.glb'))).toEqual(Buffer.alloc(2048, 1));
    expect(
      JSON.parse(await readFile(join(out, 'Site_ model_', 'Site_ model_.crs.json'), 'utf8')),
    ).toMatchObject({ origin: [500000, 3200000, 20] });
    expect((await readdir(join(out, 'Flight A'))).sort()).toEqual([
      'Flight A.crs.json',
      'a.jpg',
      'b.jpg',
    ]);
    expect(seen.at(-1)).toBe(5); // 1 + 2 files and two sidecars
  });

  it('refuses to overwrite and keeps same-named layers apart', async () => {
    await mkdir(join(out, 'Flight A'));
    const r = await exportLayers(root, m, ['ph'], out);
    expect(r).toEqual({ written: 0, skipped: ['Flight A'], cancelled: false });
    await rm(join(out, 'Flight A'), { recursive: true });
    await mkdir(join(root, 'vectors'));
    await writeFile(join(root, 'vectors', 'v.geojson'), '{}');
    const both = await exportLayers(root, m, ['ph', 'v'], out);
    expect(both.written).toBe(2);
    expect(await readdir(out)).toEqual(expect.arrayContaining(['Flight A', 'Flight A (v)']));
  });

  it('skips a layer whose refs leave the project, writing nothing outside', async () => {
    await writeFile(join(base, 'y.jpg'), 'outside');
    const bad = {
      kind: 'photos',
      id: 'bad',
      name: 'Bad',
      visible: true,
      items: [{ id: 'y', src: { path: '../y.jpg' }, pos: [0, 0, 0] }],
    } as unknown as Layer;
    const mm = { ...m, layers: [bad, mesh] };
    const r = await exportLayers(root, mm, ['bad', 'gone', 'm'], out);
    expect(r).toEqual({ written: 1, skipped: ['Bad', 'gone'], cancelled: false });
    expect((await readdir(base)).sort()).toEqual(['out', 'project', 'y.jpg']);
    expect(await readdir(out)).toEqual(['Site_ model_']);
    const info = await readLayerInfo(root, mm, bad, null);
    expect(info.files).toEqual([{ path: '../y.jpg', bytes: null }]);
    expect(info.extent).toBeNull();
    expect(info.importedAt).toBeNull();
  });

  it('rejects backslash escapes and reads a walk playback copy only inside the project', async () => {
    expect(insideRef('a\\..\\..\\b')).toBe(false);
    expect(insideRef('a/..\\..\\b')).toBe(false);
    expect(insideRef('a/..foo.jpg')).toBe(true);
    await writeFile(join(base, 'x.mp4'), 'outside');
    const walk = {
      kind: 'walk',
      id: 'walk-w',
      name: 'Walk',
      visible: true,
      record: { path: 'walks/w/walk.json' },
      src: { path: '..\\..\\x.mp4' },
      durationS: 3,
    } as unknown as Layer;
    const info = await readLayerInfo(root, m, walk, null);
    expect(info.importedAt).toBeNull();
    expect(info.mainFile).toBe('../../x.mp4');
  });

  it('truncates a long name without a trailing dot and keeps long twins apart', async () => {
    const long = `${'a'.repeat(99)}.b`;
    expect(layerFolderName(long)).toBe('a'.repeat(99));
    const one = { ...mesh, id: 'one', name: long };
    const two = { ...mesh, id: 'two', name: long };
    const mm = { ...m, layers: [one, two] };
    const r = await exportLayers(root, mm, ['one', 'two'], out);
    expect(r.written).toBe(2);
    expect(await readdir(out)).toHaveLength(2);
  });

  it('stops when cancelled and removes the half-written folder', async () => {
    const ac = new AbortController();
    const r = await exportLayers(root, m, ['ph'], out, {
      signal: ac.signal,
      progress: () => {
        ac.abort();
      },
    });
    expect(r.cancelled).toBe(true);
    expect(await readdir(out)).toEqual([]);
  });
});
