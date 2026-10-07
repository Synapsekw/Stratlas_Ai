import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noise, pmtilesArchive, rangeServer, tilesOver, type RangeServer } from '../testing';
import {
  fileSource,
  httpSource,
  planExtract,
  runExtract,
  StartOverError,
  wantedTiles,
} from './extract';
import { decompress, parseDirectory, readFullHeader, zxyToTileId, type Entry } from './format';
import { checkPack } from './header';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-extract-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every tile of an archive: tile id to plain bytes (an independent reader for checks). */
function readAll(buf: Buffer): Map<number, Buffer> {
  const h = readFullHeader(buf);
  const out = new Map<number, Buffer>();
  const visit = (entries: Entry[]) => {
    for (const e of entries) {
      if (e.runLength === 0) {
        const at = h.leafOffset + e.offset;
        visit(parseDirectory(decompress(buf.subarray(at, at + e.length), h.internalCompression)));
        continue;
      }
      const at = h.dataOffset + e.offset;
      const data = gunzipSync(buf.subarray(at, at + e.length));
      for (let i = 0; i < e.runLength; i++) out.set(e.tileId + i, data);
    }
  };
  visit(
    parseDirectory(
      decompress(buf.subarray(h.rootOffset, h.rootOffset + h.rootLength), h.internalCompression),
    ),
  );
  return out;
}

const KUWAIT: [number, number, number, number] = [46.5, 28.5, 48.5, 30.1];
const SITE: [number, number, number, number] = [47.5, 28.8, 48.3, 29.6];

/** A source over Kuwait to zoom 12 with leaf directories; some sea tiles share one content. */
function planet(): Buffer {
  const sea = noise('sea', 200);
  return pmtilesArchive({
    tiles: tilesOver(KUWAIT, 0, 12, (z, x, y) =>
      z >= 9 && (x + y) % 3 === 0 ? sea : noise(`land ${String(z)}/${String(x)}/${String(y)}`, 300),
    ),
    bbox: KUWAIT,
    leafSize: 40,
  });
}

describe('planExtract and runExtract', () => {
  it('clips to the area and zoom, keeps shared contents and passes the pack check', async () => {
    const src = join(dir, 'planet.pmtiles');
    const full = planet();
    await writeFile(src, full);
    const { plan, head } = await planExtract(fileSource(src), { bbox: SITE, maxZoom: 11 });
    const out = join(dir, 'site.pmtiles');
    const seen: number[] = [];
    await runExtract({
      source: fileSource(src),
      plan,
      head,
      out,
      onProgress: (d) => seen.push(d),
    });

    expect((await stat(out)).size).toBe(plan.totalBytes);
    expect(seen.at(-1)).toBe(plan.dataBytes);
    const header = await checkPack(out, { maxZoom: 11, bbox: SITE });
    expect(header.bbox[0]).toBeCloseTo(SITE[0], 6);

    const source = readAll(full);
    const tiles = readAll(await readFile(out));
    const wanted = [...wantedTiles(SITE, 0, 11)];
    expect([...tiles.keys()].sort((a, b) => a - b)).toEqual(wanted);
    for (const id of wanted) expect(tiles.get(id)).toEqual(source.get(id));
    // Shared sea tiles stay shared: fewer contents than tiles.
    expect(plan.contents).toBeLessThan(plan.tiles);
    expect(plan.tiles).toBe(wanted.length);
  });

  it('writes leaf directories when the root would not fit in 16 KB', async () => {
    const src = join(dir, 'planet.pmtiles');
    const tiles = tilesOver(KUWAIT, 0, 11);
    await writeFile(src, pmtilesArchive({ tiles, bbox: KUWAIT }));
    const { plan, head } = await planExtract(fileSource(src), {
      bbox: KUWAIT,
      maxZoom: 11,
      rootLimit: 60,
    });
    const h = readFullHeader(head);
    expect(h.leafLength).toBeGreaterThan(0);
    expect(h.rootLength).toBeLessThanOrEqual(60);
    const out = join(dir, 'out.pmtiles');
    await runExtract({ source: fileSource(src), plan, head, out });
    expect(readAll(await readFile(out)).size).toBe(tiles.length);
  });

  it('refuses an area the source does not cover', async () => {
    const src = join(dir, 'planet.pmtiles');
    await writeFile(src, planet());
    await expect(
      planExtract(fileSource(src), { bbox: [10, 10, 11, 11], maxZoom: 11 }),
    ).rejects.toThrow(/does not cover/);
  });
});

describe('downloads over HTTP ranges', () => {
  let server: RangeServer;
  let body: Buffer;
  beforeEach(async () => {
    body = planet();
    server = await rangeServer(() => body);
  });
  afterEach(async () => {
    await server.close();
  });

  it('continues an interrupted download from the partial file with a Range request', async () => {
    const source = httpSource(server.url, (url, init) => fetch(url, init));
    const { plan, head } = await planExtract(source, { bbox: SITE, maxZoom: 12 });
    expect(plan.identity).toBe('etag:"v1"');
    const out = join(dir, 'site.pmtiles.part');

    // The link drops 3000 bytes into the tile data; no retries in this run.
    server.cutAfter(3000);
    await expect(runExtract({ source, plan, head, out, retries: 0 })).rejects.toThrow();
    const partial = (await stat(out)).size;
    expect(partial).toBeGreaterThan(plan.headBytes);
    expect(partial).toBeLessThan(plan.totalBytes);

    // A later session: a new source object with the identity from the plan, no head.
    server.ranges.length = 0;
    const again = httpSource(server.url, (url, init) => fetch(url, init), plan.identity);
    await runExtract({ source: again, plan, out });
    const first = Number(/^bytes=(\d+)-/.exec(server.ranges[0] ?? '')?.[1]);
    // The source byte of the first missing tile data byte.
    let rest = partial - plan.headBytes;
    let expected = 0;
    for (const [off, len] of plan.runs) {
      if (rest < len) {
        expected = off + rest;
        break;
      }
      rest -= len;
    }
    expect(first).toBe(expected);
    expect(first).toBeGreaterThan(plan.runs[0]?.[0] ?? 0);

    const fresh = join(dir, 'fresh.pmtiles');
    await runExtract({ source: fileSource(await writeTemp(body)), plan, head, out: fresh });
    expect(await readFile(out)).toEqual(await readFile(fresh));
  });

  it('retries a dropped link inside one run', async () => {
    const source = httpSource(server.url, (url, init) => fetch(url, init));
    const { plan, head } = await planExtract(source, { bbox: SITE, maxZoom: 12 });
    server.cutAfter(1000);
    const out = join(dir, 'site.pmtiles');
    await runExtract({ source, plan, head, out, retries: 2, retryDelayMs: 1 });
    expect((await stat(out)).size).toBe(plan.totalBytes);
  });

  it('starts over when the file changed on the server', async () => {
    const source = httpSource(server.url, (url, init) => fetch(url, init));
    const { plan, head } = await planExtract(source, { bbox: SITE, maxZoom: 12 });
    server.setEtag('"v2"');
    const out = join(dir, 'site.pmtiles');
    await expect(runExtract({ source, plan, head, out })).rejects.toBeInstanceOf(StartOverError);
  });

  it('fetches a damaged tile again after the copy', async () => {
    const source = httpSource(server.url, (url, init) => fetch(url, init));
    const { plan, head } = await planExtract(source, { bbox: SITE, maxZoom: 12 });
    const out = join(dir, 'site.pmtiles');
    await runExtract({ source, plan, head, out });
    const good = await readFile(out);
    // Damage the last tile's gzip trailer, as a disk error would.
    const at = plan.totalBytes - 2;
    const fh = await open(out, 'r+');
    await fh.write(Buffer.from([(good[at] ?? 0) ^ 0xff]), 0, 1, at);
    await fh.close();
    await runExtract({ source, plan, out });
    expect(await readFile(out)).toEqual(good);
  });

  async function writeTemp(buf: Buffer): Promise<string> {
    const p = join(dir, 'copy.pmtiles');
    await writeFile(p, buf);
    return p;
  }
});

const KUWAIT_PACK = join(
  process.env.QUADRION_DATA ?? 'E:\\Stratlas Data',
  'packs',
  'kuwait.pmtiles',
);

describe.skipIf(!existsSync(KUWAIT_PACK))('the real Kuwait pack (read only)', () => {
  it('clips the HCl site region to zoom 14 with every tile intact', async () => {
    const hcl: [number, number, number, number] = [48.05, 29.0, 48.15, 29.1];
    const { plan, head } = await planExtract(fileSource(KUWAIT_PACK), { bbox: hcl, maxZoom: 14 });
    const out = join(dir, 'hcl.pmtiles');
    await runExtract({ source: fileSource(KUWAIT_PACK), plan, head, out });
    await checkPack(out, { maxZoom: 14, bbox: hcl });
    const tiles = readAll(await readFile(out));
    expect(tiles.size).toBe(plan.tiles);
    // Spot-check against the source through its own directories.
    const src = await readFile(KUWAIT_PACK);
    const all = readAll(src);
    for (const id of [zxyToTileId(14, 10378, 6766), zxyToTileId(10, 648, 422), 0]) {
      if (tiles.has(id)) expect(tiles.get(id)).toEqual(all.get(id));
    }
    for (const [id, data] of tiles) expect(all.get(id)).toEqual(data);
  }, 60_000);
});
