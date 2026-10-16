import { cameraQuatFromGimbal } from '@aio/geo';
import { Issue, ProjectManifest, type ImageGeom } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rotateProjectPhoto } from './rotatePhoto';

// Only Electron's codec is replaced. Real bitmap rotation, file replacement, manifest updates
// and issue persistence run against a temporary project. The fixture uses filter-zero RGBA PNGs.
function chunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([head, tag, data, tail]);
}
function png(data: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++)
    rows.push(Buffer.from([0]), data.subarray(y * width * 4, (y + 1) * width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decode(bytes: Buffer): { width: number; height: number; data: Buffer } {
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(compressed));
  const data = Buffer.concat(
    Array.from({ length: height }, (_, y) =>
      rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)),
    ),
  );
  return { width, height, data };
}
function image(data: Buffer, width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => data,
    toPNG: () => png(data, width, height),
    toJPEG: () => png(data, width, height),
  };
}
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (path: string) => {
      const p = decode(readFileSync(path));
      return image(p.data, p.width, p.height);
    },
    createFromBitmap: (data: Buffer, size: { width: number; height: number }) =>
      image(data, size.width, size.height),
  },
}));

const roots: string[] = [];
const pixel = (value: number) => [value, value, value, 255];
const originalPixels = Buffer.from([1, 2, 3, 4, 5, 6].flatMap(pixel));
async function fixture(geom: ImageGeom = { type: 'point', x: 0.5, y: 0.5 }) {
  const root = await mkdtemp(join(tmpdir(), 'aio-rotation-'));
  roots.push(root);
  const manifest = ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'rotation-fixture',
    name: 'Rotation fixture',
    crs: { epsg: 32633 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [
          {
            id: 'p1',
            src: { path: 'photo.png' },
            pos: [1, 2, 3],
            q: cameraQuatFromGimbal(38, -24, 17),
            lens: { model: 'pinhole', hfovDeg: 60, aspect: 2 / 3 },
          },
        ],
      },
    ],
    severityModels: [
      {
        id: 'review',
        name: 'Review',
        levels: [{ value: 1, label: 'Review', color: '#123456', criteria: '' }],
      },
    ],
    classCatalogues: [],
  });
  const issue = Issue.parse({
    id: 'mark',
    code: 'F01',
    classId: 'mark',
    severityModelId: 'review',
    severity: 1,
    status: 'draft',
    title: 'Synthetic mark',
    note: '',
    author: 'test',
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
    sightings: [{ on: 'image', layer: 'photos', photo: 'p1', geom }],
    source: 'human',
  });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue] }),
  );
  await writeFile(join(root, 'photo.png'), png(originalPixels, 2, 3));
  await writeFile(
    join(root, 'orientation.json'),
    JSON.stringify({ photos: { photos: { p1: { yawDeg: 12, pitchDeg: -3, rollDeg: 8 } } } }),
  );
  const rotate = () =>
    rotateProjectPhoto(
      { root: () => root },
      { projectId: 'rotation-fixture', layerId: 'photos', photoId: 'p1' },
    );
  return { root, manifest, rotate };
}
describe('photo rotation workflow', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('persists clockwise pixels and marks together with the turned camera, retaining user corrections', async () => {
    const { root, manifest, rotate } = await fixture();
    const corrections = await readFile(join(root, 'orientation.json'));
    const result = await rotate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decode(await readFile(join(root, 'photo.png')));
    expect(decoded).toEqual({
      width: 3,
      height: 2,
      data: Buffer.from([5, 3, 1, 6, 4, 2].flatMap(pixel)),
    });
    expect(result.issues[0]?.sightings[0]).toMatchObject({
      geom: { type: 'point', x: 2.5, y: 0.5 },
    });
    const saved = ProjectManifest.parse(
      JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
    );
    expect(saved).toEqual(result.manifest);
    expect(saved.layers[0]).not.toEqual(manifest.layers[0]);
    const layer = saved.layers[0];
    const q = layer?.kind === 'photos' ? layer.items[0]?.q : undefined;
    const expectedQ = cameraQuatFromGimbal(38, -24, 17 - 90);
    expect(q).toBeDefined();
    q?.forEach((value, axis) => {
      expect(value).toBeCloseTo(expectedQ[axis] ?? 0, 10);
    });
    expect(decode(await readFile(join(root, 'thumbs', 'photo.jpg')))).toEqual(decoded);
    const issues: unknown = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8'));
    expect(issues).toEqual({ schema: 'aio.issues/1', issues: result.issues });
    expect(await readFile(join(root, 'orientation.json'))).toEqual(corrections);
    for (let i = 0; i < 3; i++) expect((await rotate()).ok).toBe(true);
    expect(decode(await readFile(join(root, 'photo.png')))).toEqual({
      width: 2,
      height: 3,
      data: originalPixels,
    });
    const roundtrip: unknown = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8'));
    expect(roundtrip).toMatchObject({
      issues: [{ sightings: [{ geom: { type: 'point', x: 0.5, y: 0.5 } }] }],
    });
  });

  it('updates a posed photo without a lens rather than leaving its old camera axes', async () => {
    const { root, manifest, rotate } = await fixture();
    const layer = manifest.layers[0];
    if (layer?.kind !== 'photos' || !layer.items[0]) throw new Error('Fixture photo missing');
    delete layer.items[0].lens;
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    const result = await rotate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turned = result.manifest.layers[0];
    expect(turned?.kind === 'photos' && turned.items[0]?.q).not.toEqual(layer.items[0].q);
  });

  it('refuses an unrepresentable camera before any filesystem changes', async () => {
    const { root, manifest, rotate } = await fixture();
    const layer = manifest.layers[0];
    if (layer?.kind !== 'photos' || !layer.items[0]) throw new Error('Fixture photo missing');
    layer.items[0].lens = { model: 'ftheta', hfovDeg: 300, aspect: 2 / 3 };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    const names = await readdir(root);
    const before = await Promise.all(names.map((name) => readFile(join(root, name))));
    const result = await rotate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/field of view/i);
    expect(await readdir(root)).toEqual(names);
    expect(await Promise.all(names.map((name) => readFile(join(root, name))))).toEqual(before);
  });

  it('refuses panorama layers rather than applying optical roll to equirectangular pixels', async () => {
    const { root, manifest, rotate } = await fixture();
    manifest.layers = [
      {
        kind: 'panoramas',
        id: 'photos',
        name: 'Panoramas',
        visible: true,
        items: [{ id: 'p1', src: { path: 'photo.png' }, pos: [0, 0, 0], headingDeg: 0 }],
      },
    ];
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    const original = await readFile(join(root, 'photo.png'));
    const result = await rotate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a photos layer/i);
    expect(await readFile(join(root, 'photo.png'))).toEqual(original);
  });

  it('refuses masks before writing the photo, marks, manifest, thumbnails or mask partners', async () => {
    const { root, rotate } = await fixture({ type: 'mask', src: { path: 'mark_mask.png' } });
    await writeFile(join(root, 'mark_mask.png'), png(originalPixels, 2, 3));
    await writeFile(join(root, 'mark_overlay.png'), png(originalPixels, 2, 3));
    const names = await readdir(root);
    const before = await Promise.all(names.map((name) => readFile(join(root, name))));
    const result = await rotate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mask/i);
    expect(await readdir(root)).toEqual(names);
    expect(await Promise.all(names.map((name) => readFile(join(root, name))))).toEqual(before);
  });
});
