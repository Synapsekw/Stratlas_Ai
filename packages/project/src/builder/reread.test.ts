import { fromWgs84 } from '@aio/geo';
import {
  emptyOrientation,
  type Layer,
  type LensModel,
  type OrientationFile,
  type PhotoRef,
  type Vec3,
} from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, writeManifestFile } from './create';
import { rereadPhotoLayer, type RereadOrientation } from './reread';
import { xt2Thermal, xt2Visual } from './xt2Fixture';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-reread-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LON = 48.1352;
const LAT = 29.0276;
const ORIGIN = (() => {
  const p = fromWgs84([LON, LAT, 0], 32639);
  return [Math.round(p[0]), Math.round(p[1]), 30] as Vec3;
})();

/** A photo as an old build imported it: placed on the ground, no view direction. */
const stale = (id: string, extra: Partial<PhotoRef> = {}): PhotoRef => ({
  id,
  src: { path: `photos/${id}.jpg` },
  takenAt: '2024-11-06T10:00:00+03:00',
  pos: [1, -46, -1],
  ...extra,
});

async function project(items: PhotoRef[], files: Record<string, Uint8Array>): Promise<string> {
  const { root } = await createProject(dir, {
    name: 'Reread',
    type: 'inspection',
    epsg: 32639,
    origin: ORIGIN,
    severityTemplate: null,
  });
  const m = await readManifestFile(root);
  m.layers.push({ kind: 'photos', id: 'photos', name: 'Photos', visible: true, items });
  await writeManifestFile(root, m);
  await mkdir(join(root, 'photos'), { recursive: true });
  for (const [id, bytes] of Object.entries(files))
    await writeFile(join(root, 'photos', `${id}.jpg`), bytes);
  return root;
}

/** An in-memory orientation file and the writes it got. */
function orientation(file: OrientationFile | null = null) {
  const o = { file, writes: 0, removes: 0 };
  const io: RereadOrientation = {
    read: () => Promise.resolve(o.file),
    write: (f) => {
      o.file = f;
      o.writes += 1;
      return Promise.resolve();
    },
    remove: () => {
      o.file = null;
      o.removes += 1;
      return Promise.resolve();
    },
  };
  return { o, io };
}

const visual = (relAlt: number, at = '2024:11:06 10:00:00', yaw = 63.1) =>
  xt2Visual({
    dateTimeOriginal: at,
    lat: LAT,
    lon: LON,
    absAlt: relAlt - 46.2,
    relAlt,
    gimbal: { yaw, pitch: -90, roll: 0 },
  });

const layerOf = async (root: string): Promise<PhotosLayer> => {
  const l = (await readManifestFile(root)).layers.find((x) => x.id === 'photos');
  if (l?.kind !== 'photos') throw new Error('no photos layer');
  return l;
};
const item = async (root: string, id: string): Promise<PhotoRef> => {
  const p = (await layerOf(root)).items.find((x) => x.id === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
};
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const near = (a: Vec3 | undefined, b: Vec3) => {
  expect(a).toBeDefined();
  a?.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] ?? Number.NaN, 3);
  });
};

describe('rereadPhotoLayer', () => {
  it('rewrites pos (height by the project rule) and q from a review copy, keeping the lens', async () => {
    const lens: LensModel = { model: 'pinhole', hfovDeg: 40, aspect: 1.25 };
    const root = await project([stale('x-0006', { lens })], {
      'x-0006': visual(14.7),
    });
    const { io } = orientation();
    const r = await rereadPhotoLayer(root, 'photos', { orientation: io });
    expect(r).toMatchObject({ ok: true, reread: 1, kept: 0, twins: 0, notFound: 0 });
    const p = await item(root, 'x-0006');
    // relative rule, take-off at the origin height: y (up) is the relative altitude
    expect(p.pos?.[1]).toBeCloseTo(14.7, 3);
    expect(p.q).toBeDefined();
    expect(p.lens).toEqual(lens);
    expect(p.takenAt).toBe('2024-11-06T10:00:00+03:00');
  });

  it('leaves pinned photos alone', async () => {
    const pin = { ground: [0, 0, 0] as Vec3, eyeM: 1.6 };
    const root = await project([stale('x-0006', { pin })], { 'x-0006': visual(14.7) });
    const r = await rereadPhotoLayer(root, 'photos', { orientation: orientation().io });
    expect(r).toMatchObject({ ok: true, reread: 0 });
    expect((await item(root, 'x-0006')).pos).toEqual([1, -46, -1]);
  });

  it('keeps a hand-moved photo at its corrected place, re-anchoring its offset', async () => {
    const root = await project([stale('x-0006')], { 'x-0006': visual(14.7) });
    const before: Vec3 = [1, -46, -1];
    const offset: Vec3 = [2, 50, 3];
    const file = emptyOrientation();
    file.photos.photos = { 'x-0006': { yawDeg: 5, pitchDeg: 0, rollDeg: 0, offsetM: offset } };
    const { o, io } = orientation(file);
    const r = await rereadPhotoLayer(root, 'photos', { orientation: io });
    expect(r).toMatchObject({ ok: true, reread: 1, kept: 1 });
    expect(o.writes).toBe(1);
    const p = await item(root, 'x-0006');
    const c = o.file?.photos.photos?.['x-0006'];
    expect(c?.yawDeg).toBe(5);
    near(add(p.pos ?? [0, 0, 0], c?.offsetM ?? [0, 0, 0]), add(before, offset));
  });

  it('asks for the originals when a review copy carries no metadata, writing nothing', async () => {
    const root = await project([stale('x-0007')], {
      'x-0007': xt2Thermal({ dateTimeOriginal: '2024:11:06 10:00:00' }),
    });
    const text = await readFile(join(root, 'manifest.json'), 'utf8');
    const { o, io } = orientation();
    const r = await rereadPhotoLayer(root, 'photos', { orientation: io });
    expect(r).toEqual({ ok: false, needsFolder: true, missing: 1 });
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(text);
    expect(o.writes).toBe(0);
  });

  it('reads the originals from a folder by name (also without a uniqueness suffix) and time', async () => {
    const noMeta = xt2Thermal({ dateTimeOriginal: '2024:11:06 10:00:00' });
    const root = await project([stale('x-0007'), stale('x-0008-2'), stale('x-0009')], {
      'x-0007': noMeta,
      'x-0008-2': noMeta,
      'x-0009': noMeta,
    });
    const folder = join(dir, 'originals');
    await mkdir(join(folder, 'sub'), { recursive: true });
    await writeFile(join(folder, 'X_0007.JPG'), visual(10));
    await writeFile(join(folder, 'sub', 'X_0008.jpg'), visual(12));
    // a file of the same name taken at another time is not this photo
    await writeFile(join(folder, 'X_0009.JPG'), visual(20, '2024:11:06 11:00:00'));
    const r = await rereadPhotoLayer(root, 'photos', { orientation: orientation().io, folder });
    expect(r).toMatchObject({ ok: true, reread: 2, notFound: 1 });
    expect((await item(root, 'x-0007')).pos?.[1]).toBeCloseTo(10, 3);
    expect((await item(root, 'x-0008-2')).pos?.[1]).toBeCloseTo(12, 3);
    expect((await item(root, 'x-0009')).pos).toEqual([1, -46, -1]);
  });

  it('places a thermal without DJI metadata at its visual twin again', async () => {
    const root = await project([stale('x-0005-r'), stale('x-0006')], {
      'x-0005-r': xt2Thermal({
        dateTimeOriginal: '2024:11:06 10:00:01',
        lat: LAT + 0.0001,
        lon: LON,
        alt: -4.502,
      }),
      'x-0006': visual(14.7),
    });
    const file = emptyOrientation();
    file.photos.photos = {
      'x-0005-r': { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [9, 9, 9] },
    };
    const { o, io } = orientation(file);
    const r = await rereadPhotoLayer(root, 'photos', { orientation: io });
    expect(r).toMatchObject({ ok: true, reread: 2, twins: 1, kept: 0 });
    const thermal = await item(root, 'x-0005-r');
    const twin = await item(root, 'x-0006');
    expect(thermal.q).toEqual(twin.q);
    const c = o.file?.photos.photos?.['x-0005-r'];
    near(add(thermal.pos ?? [0, 0, 0], c?.offsetM ?? [0, 0, 0]), twin.pos ?? [0, 0, 0]);
  });

  it('answers the counts of a dry run and writes nothing', async () => {
    const root = await project([stale('x-0006')], { 'x-0006': visual(14.7) });
    const text = await readFile(join(root, 'manifest.json'), 'utf8');
    const file = emptyOrientation();
    file.photos.photos = { 'x-0006': { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, 1, 0] } };
    const { o, io } = orientation(file);
    const r = await rereadPhotoLayer(root, 'photos', { orientation: io, dryRun: true });
    expect(r).toMatchObject({ ok: true, reread: 1, kept: 1 });
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(text);
    expect(o.writes).toBe(0);
  });

  it('removes the orientation file it made when the manifest save fails', async () => {
    const root = await project([stale('x-0005-r'), stale('x-0006')], {
      'x-0005-r': xt2Thermal({
        dateTimeOriginal: '2024:11:06 10:00:01',
        lat: LAT + 0.0001,
        lon: LON,
        alt: -4.502,
      }),
      'x-0006': visual(14.7),
    });
    const { o, io } = orientation(null);
    const write = (f: OrientationFile) => io.write(f);
    const sabotaged: RereadOrientation = { ...io };
    // the manifest cannot be replaced once the corrections are written: a folder stands in its way
    sabotaged.write = async (f) => {
      await write(f);
      await rm(join(root, 'manifest.json'));
      await mkdir(join(root, 'manifest.json'));
    };
    await expect(rereadPhotoLayer(root, 'photos', { orientation: sabotaged })).rejects.toThrow();
    expect(o.writes).toBe(1);
    expect(o.removes).toBe(1);
    expect(o.file).toBeNull();
  });

  it('refuses a layer that is not a photos layer', async () => {
    const root = await project([], {});
    await expect(rereadPhotoLayer(root, 'nope', { orientation: orientation().io })).rejects.toThrow(
      /photos/,
    );
  });
});
