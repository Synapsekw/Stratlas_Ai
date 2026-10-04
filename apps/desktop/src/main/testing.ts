// Test helpers for main-process unit tests. Not imported by production code.
import type { Issue, ProjectManifestInput } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { serializeDirectory, writeFullHeader, zxyToTileId } from './packs/format';

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

export interface ArchiveTile {
  z: number;
  x: number;
  y: number;
  /** Plain tile bytes (gzipped into the archive). */
  data: Buffer;
}

/**
 * A complete PMTiles v3 archive with real directories (gzip), gzip tiles, deduplicated contents
 * and run lengths; `leafSize` splits the directory into leaves the way large archives do.
 */
export function pmtilesArchive(o: {
  tiles: ArchiveTile[];
  bbox?: [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
  leafSize?: number;
}): Buffer {
  const byId = o.tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: gzipSync(t.data, { level: 1 }) }))
    .sort((a, b) => a.id - b.id);
  const contents = new Map<string, number>();
  const blobs: Buffer[] = [];
  let at = 0;
  const entries: { tileId: number; offset: number; length: number; runLength: number }[] = [];
  for (const t of byId) {
    const key = t.data.toString('base64');
    let offset = contents.get(key);
    if (offset === undefined) {
      offset = at;
      contents.set(key, offset);
      blobs.push(t.data);
      at += t.data.length;
    }
    const prev = entries.at(-1);
    if (prev?.offset === offset && prev.tileId + prev.runLength === t.id) prev.runLength++;
    else entries.push({ tileId: t.id, offset, length: t.data.length, runLength: 1 });
  }
  let root: Buffer;
  let leaves = Buffer.alloc(0);
  if (o.leafSize && entries.length > o.leafSize) {
    const rootEntries = [];
    const parts: Buffer[] = [];
    let la = 0;
    for (let i = 0; i < entries.length; i += o.leafSize) {
      const chunk = entries.slice(i, i + o.leafSize);
      const leaf = gzipSync(serializeDirectory(chunk));
      rootEntries.push({
        tileId: chunk[0]?.tileId ?? 0,
        offset: la,
        length: leaf.length,
        runLength: 0,
      });
      parts.push(leaf);
      la += leaf.length;
    }
    root = gzipSync(serializeDirectory(rootEntries));
    leaves = Buffer.concat(parts);
  } else root = gzipSync(serializeDirectory(entries));
  const meta = gzipSync(Buffer.from(JSON.stringify({ name: 'archive fixture' })));
  const data = Buffer.concat(blobs);
  const zooms = o.tiles.map((t) => t.z);
  const bbox = o.bbox ?? [-180, -85, 180, 85];
  const header = writeFullHeader({
    rootOffset: 127,
    rootLength: root.length,
    metadataOffset: 127 + root.length,
    metadataLength: meta.length,
    leafOffset: 127 + root.length + meta.length,
    leafLength: leaves.length,
    dataOffset: 127 + root.length + meta.length + leaves.length,
    dataLength: data.length,
    addressedTiles: byId.length,
    tileEntries: entries.length,
    tileContents: blobs.length,
    clustered: true,
    internalCompression: 2,
    tileCompression: 2,
    tileType: 1,
    minZoom: o.minZoom ?? Math.min(...zooms),
    maxZoom: o.maxZoom ?? Math.max(...zooms),
    bounds: bbox,
    centerZoom: 0,
    center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
  });
  return Buffer.concat([header, root, meta, leaves, data]);
}

/** Every z/x/y tile from `minZoom` to `maxZoom` that touches `bbox`, with distinct content. */
export function tilesOver(
  bbox: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
  content: (z: number, x: number, y: number) => Buffer = (z, x, y) =>
    Buffer.from(`tile ${String(z)}/${String(x)}/${String(y)}`),
): ArchiveTile[] {
  const out: ArchiveTile[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    const tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
    const ty = (lat: number) => {
      const r = (lat * Math.PI) / 180;
      const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
      return Math.min(n - 1, Math.max(0, Math.floor(y)));
    };
    for (let x = tx(bbox[0]); x <= tx(bbox[2] - 1e-9); x++)
      for (let y = ty(bbox[3]); y <= ty(bbox[1] + 1e-9); y++)
        out.push({ z, x, y, data: content(z, x, y) });
  }
  return out;
}

/** Bytes that do not compress (a SHA-256 chain), so tiles keep their size in an archive. */
export function noise(label: string, bytes: number): Buffer {
  const parts: Buffer[] = [Buffer.from(label)];
  let h = createHash('sha256').update(label).digest();
  for (let n = 0; n < bytes; n += h.length) {
    parts.push(h);
    h = createHash('sha256').update(h).digest();
  }
  return Buffer.concat(parts);
}

/** A local HTTP server for one file with Range support (no internet in tests). */
export interface RangeServer {
  url: string;
  /** Range headers received, in order. */
  ranges: string[];
  /**
   * Drop the connection after `bytes` of the next `times` responses longer than `minLength`
   * (a dropped link); null stops it.
   */
  cutAfter(bytes: number | null, times?: number, minLength?: number): void;
  /** Send `bytes` of responses longer than `minLength`, then hold the connection open. */
  stallAfter(bytes: number | null, minLength?: number): void;
  setEtag(etag: string | null): void;
  close(): Promise<void>;
}

export async function rangeServer(
  file: () => Buffer,
  path = '/planet.pmtiles',
  /** Small files served whole by path, e.g. a `builds.json` index. */
  extra: Record<string, string> = {},
): Promise<RangeServer> {
  const { createServer } = await import('node:http');
  const ranges: string[] = [];
  let cut: { bytes: number; times: number; minLength: number } | null = null;
  let stall: { bytes: number; minLength: number } | null = null;
  let etag: string | null = '"v1"';
  const server = createServer((req, res) => {
    const other = req.url === undefined ? undefined : extra[req.url];
    if (other !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(other);
      return;
    }
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': String(file().length) }).end();
      return;
    }
    const body = file();
    const range = req.headers.range ?? '';
    ranges.push(range);
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    const ifRange = req.headers['if-range'];
    const headers: Record<string, string> = { 'Accept-Ranges': 'bytes' };
    if (etag) headers.ETag = etag;
    if (!m || (ifRange !== undefined && ifRange !== etag)) {
      res.writeHead(200, { ...headers, 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(body.length - 1, m[2] === undefined ? body.length - 1 : Number(m[2]));
    const part = body.subarray(start, end + 1);
    res.writeHead(206, {
      ...headers,
      'Content-Length': String(part.length),
      'Content-Range': `bytes ${String(start)}-${String(end)}/${String(body.length)}`,
    });
    if (stall && part.length > stall.minLength) {
      res.write(part.subarray(0, Math.min(stall.bytes, part.length)));
      return;
    }
    if (cut && part.length > cut.minLength) {
      const n = cut.bytes;
      if (--cut.times <= 0) cut = null;
      res.write(part.subarray(0, Math.min(n, part.length)), () => {
        res.destroy();
      });
      return;
    }
    res.end(part);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}${path}`,
    ranges,
    cutAfter: (bytes, times = 1, minLength = 0) => {
      cut = bytes === null ? null : { bytes, times, minLength };
    },
    stallAfter: (bytes, minLength = 0) => {
      stall = bytes === null ? null : { bytes, minLength };
    },
    setEtag: (e) => {
      etag = e;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
