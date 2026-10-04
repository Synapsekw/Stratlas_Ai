import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pmtilesFile } from '../testing';
import { checkPack, parseHeader, readHeader } from './header';

describe('parseHeader', () => {
  it('reads zooms, bounds and the tile type of a PMTiles v3 archive', () => {
    const h = parseHeader(pmtilesFile({ maxZoom: 12, bbox: [50.7, 24.4, 51.7, 26.2] }));
    expect(h.version).toBe(3);
    expect(h.minZoom).toBe(0);
    expect(h.maxZoom).toBe(12);
    expect(h.tileType).toBe('mvt');
    expect(h.bbox[0]).toBeCloseTo(50.7, 6);
    expect(h.bbox[3]).toBeCloseTo(26.2, 6);
    expect(h.end).toBe(pmtilesFile().length);
  });

  it('rejects files that are not PMTiles', () => {
    expect(() => parseHeader(Buffer.alloc(127, 0x41))).toThrow(/not a PMTiles/);
    expect(() => parseHeader(Buffer.from('short'))).toThrow(/not a PMTiles/);
  });

  it('rejects PMTiles versions it cannot read', () => {
    expect(() => parseHeader(pmtilesFile({ version: 2 }))).toThrow(/version 2/);
  });
});

describe('checkPack', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-header-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a complete vector archive', async () => {
    const f = join(dir, 'a.pmtiles');
    await writeFile(f, pmtilesFile());
    expect((await readHeader(f)).maxZoom).toBe(15);
    await expect(checkPack(f)).resolves.toMatchObject({ tileType: 'mvt' });
  });

  it('refuses a cut-off download', async () => {
    const f = join(dir, 'a.pmtiles');
    await writeFile(f, pmtilesFile({ truncate: 4 }));
    await expect(checkPack(f)).rejects.toThrow(/incomplete/);
  });

  it('refuses raster archives, which the vector basemap cannot draw', async () => {
    const f = join(dir, 'a.pmtiles');
    await writeFile(f, pmtilesFile({ tileType: 2 }));
    await expect(checkPack(f)).rejects.toThrow(/vector/);
  });

  it('checks the zoom and area a download asked for', async () => {
    const f = join(dir, 'a.pmtiles');
    await writeFile(f, pmtilesFile({ maxZoom: 10, bbox: [46.5, 28.5, 48.5, 30.1] }));
    await expect(checkPack(f, { maxZoom: 12, bbox: [46.5, 28.5, 48.5, 30.1] })).rejects.toThrow(
      /zoom 10/,
    );
    await expect(checkPack(f, { maxZoom: 10, bbox: [0, 0, 1, 1] })).rejects.toThrow(/area/);
    await expect(
      checkPack(f, { maxZoom: 10, bbox: [46.4, 28.4, 48.6, 30.2] }),
    ).resolves.toBeTruthy();
  });
});
