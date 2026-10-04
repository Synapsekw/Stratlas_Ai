// Test helpers for main-process unit tests. Not imported by production code.
import type { Issue, ProjectManifestInput } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function sampleManifest(
  overrides: Partial<ProjectManifestInput> = {},
): ProjectManifestInput {
  return {
    schema: 'aio.project/1',
    id: 'alzour',
    name: 'Al-Zour LNG Terminal',
    customer: 'KIPIC',
    site: 'Al-Zour',
    crs: { epsg: 32639 },
    origin: [245884.9, 3179597.1, 0],
    captures: [
      { id: 'c1', label: 'Survey', date: '2023-02-21' },
      { id: 'c2', label: 'Resurvey', date: '2024-01-10' },
    ],
    layers: [
      {
        kind: 'mesh',
        id: 'plant',
        name: 'Plant model',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'video',
        id: 'dji0789',
        name: 'DJI_0789',
        visible: true,
        src: { path: 'video/DJI_0789.mp4' },
        flight: { src: { path: 'flights/DJI_0789.json' }, startUtcMs: 1676970000000 },
        lens: { model: 'pinhole', hfovDeg: 82, aspect: 16 / 9 },
        offsetMs: 0,
      },
      {
        kind: 'video',
        id: 'dji0790',
        name: 'DJI_0790',
        visible: true,
        src: { path: 'video/DJI_0790.mp4' },
        flight: { src: { path: 'flights/DJI_0790.json' }, startUtcMs: 1676970000000 },
        lens: { model: 'pinhole', hfovDeg: 82, aspect: 16 / 9 },
        offsetMs: 0,
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity 1 to 5',
        levels: [
          { value: 1, label: 'Observation', color: '#8a94a6', criteria: 'No action' },
          { value: 3, label: 'Moderate', color: '#e8c547', criteria: 'Monitor' },
          { value: 5, label: 'Critical', color: '#e5484d', criteria: 'Repair now' },
        ],
      },
    ],
    classCatalogues: [],
    ...overrides,
  };
}

export function sampleIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'F01',
    classId: 'coating',
    severityModelId: 'sev',
    severity: 3,
    status: 'draft',
    title: 'Coating breakdown',
    note: '',
    author: 'reviewer',
    createdAt: '2026-10-03T10:00:00+03:00',
    updatedAt: '2026-10-03T10:00:00+03:00',
    sightings: [
      { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    ],
    source: 'human',
    ...overrides,
  };
}

/** Write a native project folder with a manifest and optional extra files. */
export async function writeProject(
  dir: string,
  manifest: unknown = sampleManifest(),
  files: Record<string, string> = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body);
  }
  return dir;
}

export interface PmtilesFixture {
  minZoom?: number;
  maxZoom?: number;
  /** West, south, east, north. */
  bbox?: [number, number, number, number];
  /** 1 = MVT (vector), 2 = PNG. */
  tileType?: number;
  version?: number;
  /** Drop bytes from the end, as a cut-off download would. */
  truncate?: number;
}

/**
 * A minimal PMTiles v3 archive: header, an uncompressed root directory with one tile (z0) and
 * a small JSON metadata block. Enough for header parsing and verification.
 */
export function pmtilesFile(o: PmtilesFixture = {}): Buffer {
  const [w, s, e, n] = o.bbox ?? [46.5, 28.5, 48.5, 30.1];
  const tile = Buffer.from('fake-mvt-tile');
  // Directory: 1 entry; tile id delta 0, run length 1, length, offset + 1.
  const dir = Buffer.from([1, 0, 1, tile.length, 1]);
  const meta = Buffer.from(JSON.stringify({ name: 'fixture', attribution: 'OpenStreetMap' }));
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(o.version ?? 3, 7);
  const u64 = (v: number, at: number) => {
    header.writeBigUInt64LE(BigInt(v), at);
  };
  const rootOff = 127;
  const metaOff = rootOff + dir.length;
  const dataOff = metaOff + meta.length;
  u64(rootOff, 8);
  u64(dir.length, 16);
  u64(metaOff, 24);
  u64(meta.length, 32);
  u64(dataOff + tile.length, 40);
  u64(0, 48);
  u64(dataOff, 56);
  u64(tile.length, 64);
  u64(1, 72);
  u64(1, 80);
  u64(1, 88);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(1, 97); // internal compression: none
  header.writeUInt8(1, 98); // tile compression: none
  header.writeUInt8(o.tileType ?? 1, 99);
  header.writeUInt8(o.minZoom ?? 0, 100);
  header.writeUInt8(o.maxZoom ?? 15, 101);
  const e7 = (v: number) => Math.round(v * 1e7);
  header.writeInt32LE(e7(w), 102);
  header.writeInt32LE(e7(s), 106);
  header.writeInt32LE(e7(e), 110);
  header.writeInt32LE(e7(n), 114);
  header.writeUInt8(o.minZoom ?? 0, 118);
  header.writeInt32LE(e7((w + e) / 2), 119);
  header.writeInt32LE(e7((s + n) / 2), 123);
  const all = Buffer.concat([header, dir, meta, tile]);
  return o.truncate ? all.subarray(0, all.length - o.truncate) : all;
}
