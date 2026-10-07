/**
 * M10 fixtures (stream G8): the globe library and the photo project are synthetic, valid against
 * the contracts, decodable as written, and listed by the app with no network. The first tests
 * need no app; the last launches it (off-screen, zero-network guard).
 */
import {
  GcpFile,
  parseManifest,
  PhotoRun,
  RasterPackMeta,
  TilesetsFile,
  AccuracyReport,
} from '@aio/schema';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decompress, parseDirectory, readFullHeader, zxyToTileId } from '../src/main/packs/format';
import { expect, test } from './fixtures';
import { decodeTerrarium, PHOTO_DEMO } from './m10Fixtures';

/** A tile's bytes from a PMTiles archive (root directory only, as the fixtures write). */
function tileOf(archive: Buffer, z: number, x: number, y: number): Buffer | null {
  const h = readFullHeader(archive);
  const dir = parseDirectory(
    decompress(archive.subarray(h.rootOffset, h.rootOffset + h.rootLength), h.internalCompression),
  );
  const id = zxyToTileId(z, x, y);
  const e = dir.find((d) => d.tileId <= id && id < d.tileId + d.runLength);
  if (!e) return null;
  const at = h.dataOffset + e.offset;
  return archive.subarray(at, at + e.length);
}

/** RGB of pixel (px, py) of a PNG the fixtures wrote (8-bit RGB, filter none). */
function pngPixel(png: Buffer, px: number, py: number): [number, number, number] {
  const width = png.readUInt32BE(16);
  const parts: Buffer[] = [];
  for (let p = 8; p < png.length;) {
    const len = png.readUInt32BE(p);
    if (png.toString('latin1', p + 4, p + 8) === 'IDAT')
      parts.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const i = py * (width * 3 + 1) + 1 + px * 3;
  return [raw[i] ?? 0, raw[i + 1] ?? 0, raw[i + 2] ?? 0];
}

test('the globe library: valid projects, placed sites, packs that decode', async ({
  dataRoot,
  globeLibrary,
}) => {
  const lib = globeLibrary;
  expect(lib.sites).toHaveLength(6);
  for (const s of lib.sites) {
    const m = parseManifest(
      JSON.parse(await readFile(join(dataRoot.root, 'projects', s.id, 'manifest.json'), 'utf8')),
    );
    expect(m.ok, s.id).toBe(true);
    const ts = join(dataRoot.root, 'projects', s.id, 'tilesets.json');
    if (s.tilesets.length) {
      const file = TilesetsFile.parse(JSON.parse(await readFile(ts, 'utf8')));
      expect(file.entries.map((e) => e.kind)).toEqual(s.tilesets.map((t) => t.kind));
    } else expect(existsSync(ts)).toBe(false);
  }
  const byId = Object.fromEntries(lib.sites.map((s) => [s.id, s]));
  // placed where their origins are: both hemispheres, both sides of the antimeridian's zone
  expect(byId['globe-site-a']?.lonLat?.[0]).toBeCloseTo(51.4813, 3);
  expect(byId['globe-site-a']?.lonLat?.[1]).toBeCloseTo(21.0703, 3);
  expect(byId['globe-site-c']?.lonLat?.[1]).toBeLessThan(-20);
  expect(byId['globe-site-e']?.lonLat?.[0]).toBeGreaterThan(179.5);
  expect(byId['globe-site-f']?.lonLat).toBeNull();
  expect(byId['globe-site-a']).toMatchObject({
    openIssues: 3,
    bySeverity: { 3: 1, 4: 1, uncertain: 1 },
  });

  for (const meta of [...lib.imagery, ...lib.terrain]) {
    const dir = join(dataRoot.root, 'packs', meta.kind);
    expect(
      RasterPackMeta.parse(JSON.parse(await readFile(join(dir, `${meta.id}.json`), 'utf8'))),
    ).toEqual(meta);
    const h = readFullHeader(await readFile(join(dir, `${meta.id}.pmtiles`)));
    expect(h).toMatchObject({ tileType: 2, tileCompression: 1, minZoom: meta.minZoom });
    expect(meta).toMatchObject({ licence: 'CC0-1.0', customerLicence: false });
  }
  // the terrain benchmark reads back from its tile to the Terrarium step (1/256 m)
  const b = lib.benchmark;
  const archive = await readFile(
    join(dataRoot.root, 'packs', 'terrain', 'synthetic-terrain-a.pmtiles'),
  );
  const tile = tileOf(archive, b.tile.z, b.tile.x, b.tile.y);
  expect(tile).not.toBeNull();
  const h = decodeTerrarium(pngPixel(tile ?? Buffer.alloc(0), b.tile.px, b.tile.py));
  expect(Math.abs(h - b.heightM)).toBeLessThan(1 / 256 + 1e-9);
});

test('the photo project: the demo as a writable project with a valid precomputed run', async ({
  photoProject,
}) => {
  const p = photoProject;
  const m = parseManifest(JSON.parse(await readFile(join(p.dir, 'manifest.json'), 'utf8')));
  expect(m.ok).toBe(true);
  if (!m.ok) return;
  expect(m.value).toMatchObject({ id: PHOTO_DEMO.id, name: PHOTO_DEMO.name, crs: { epsg: 32639 } });
  const layer = m.value.layers.find((l) => l.id === 'photos');
  expect(layer?.kind).toBe('photos');
  const run = PhotoRun.parse(JSON.parse(await readFile(join(p.runDir, 'run.json'), 'utf8')));
  const gcp = GcpFile.parse(JSON.parse(await readFile(join(p.runDir, 'gcp.json'), 'utf8')));
  AccuracyReport.parse(
    JSON.parse(await readFile(join(p.runDir, 'report', 'accuracy.json'), 'utf8')),
  );
  expect(run.status).toBe('aligned');
  expect(gcp.points.filter((x) => x.role === 'control')).toHaveLength(5);
  expect(gcp.points.filter((x) => x.role === 'check')).toHaveLength(4);
  // every predicted mark names a photo of the layer and lies near the target's true mark
  const ids = new Set(layer?.kind === 'photos' ? layer.items.map((i) => i.id) : []);
  for (const pt of gcp.points) {
    const truth = p.truth.targets.find((t) => t.id === pt.id);
    for (const pr of pt.predicted ?? []) {
      expect(ids.has(pr.photo)).toBe(true);
      const o = truth?.observations.find((x) => p.photoId(x.photo) === pr.photo);
      expect(o, `${pt.id} in ${pr.photo}`).toBeDefined();
      const d = Math.hypot(pr.px[0] - (o?.px[0] ?? 0), pr.px[1] - (o?.px[1] ?? 0));
      expect(d).toBeLessThan(pr.radiusPx);
    }
  }
  expect(existsSync(join(p.dir, 'survey', 'gcp.csv'))).toBe(true);
});

test('the library lists the photo demo and the globe sites, with no network', async ({
  photoProject,
  globeLibrary,
  win,
}) => {
  const entries = await win.evaluate(() => window.aio.invoke('library:list', {}));
  const names = entries.map((e) => e.name);
  expect(entries.find((e) => e.id === photoProject.id)?.name).toBe(PHOTO_DEMO.name);
  for (const s of globeLibrary.sites) expect(names).toContain(s.name);
  // nothing in the library names a client, a real site or a real camera
  for (const name of names) expect(name).not.toMatch(/DJI|HCl|EBSM|Masafi|Zour|Kuwait/i);
});
