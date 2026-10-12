import type { ZipArchive } from '@aio/project/package';
import { ProjectManifest, RasterPackId, RasterPackMeta, type RasterPackInfo } from '@aio/schema';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageryPack, terrainPack, type RasterPackFixture } from '../../../e2e/m10Fixtures';
import { sampleManifest } from '../testing';
import { projectBbox } from './embed';
import {
  chooseRasterEmbeds,
  embeddedRasterId,
  embeddedRasterPacks,
  findEmbeddedRaster,
  packageRasterPacks,
  planRasterEmbeds,
  writeRasterEmbeds,
} from './rasterEmbed';

const SITE_BOX: [number, number, number, number] = [14, 44, 16, 46];
const manifest = () =>
  ProjectManifest.parse(
    sampleManifest({ id: 'p1', crs: { epsg: 32633 }, origin: [500000, 5000000, 0], layers: [] }),
  );

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-raster-embed-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function install(p: RasterPackFixture): Promise<RasterPackInfo> {
  const dir = join(base, 'packs', p.meta.kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${p.meta.id}.pmtiles`), p.pmtiles);
  await writeFile(join(dir, `${p.meta.id}.json`), JSON.stringify(p.meta));
  return { ...p.meta, sizeBytes: p.pmtiles.length, source: 'build-tool' };
}

const near = imageryPack({ id: 'site', label: 'Site', bbox: SITE_BOX, minZoom: 0, maxZoom: 5 });
const far = imageryPack({
  id: 'faraway',
  label: 'Far',
  bbox: [100, 10, 101, 11],
  minZoom: 0,
  maxZoom: 4,
});

async function planned() {
  const imagery = [await install(near), await install(far)];
  const terrain = [
    await install(
      terrainPack({
        id: 'dem',
        label: 'Dem',
        bbox: SITE_BOX,
        minZoom: 0,
        maxZoom: 5,
        near: [15, 45],
      }),
    ),
  ];
  return planRasterEmbeds({
    manifest: manifest(),
    packs: { imagery, terrain },
    dataRoot: base,
    marginKm: 1,
  });
}

function archiveOf(files: Record<string, Buffer>): ZipArchive {
  const entries = new Map(Object.keys(files).map((k) => [k, {}]));
  return {
    entries,
    read: (n: string) => Promise.resolve(files[n] ?? Buffer.alloc(0)),
  } as unknown as ZipArchive;
}

describe('planRasterEmbeds', () => {
  it('lists only the packs that cover the site', async () => {
    const r = await planned();
    expect(r.summary.map((s) => `${s.kind}/${s.id}`).sort()).toEqual([
      'imagery/site',
      'terrain/dem',
    ]);
    const s = r.summary.find((x) => x.id === 'site');
    expect(s?.ok).toBe(true);
    if (s?.ok) expect(s.bytes).toBeGreaterThan(0);
    expect(s?.customerLicence).toBe(false);
    expect(r.plans.has('imagery/site')).toBe(true);
  });

  it('says there is no map position for an unknown CRS', async () => {
    const m = ProjectManifest.parse(
      sampleManifest({ id: 'p2', crs: { epsg: 1 }, origin: [0, 0, 0], layers: [] }),
    );
    const r = await planRasterEmbeds({
      manifest: m,
      packs: { imagery: [await install(near)], terrain: [] },
      dataRoot: base,
      marginKm: 1,
    });
    expect(r.summary).toHaveLength(1);
    const s = r.summary[0];
    expect(s?.ok).toBe(false);
    if (s && !s.ok) expect(s.reason).toContain('no map position');
  });
});

describe('chooseRasterEmbeds', () => {
  it('names a pack that is not in the plan', async () => {
    const r = chooseRasterEmbeds([{ kind: 'imagery', id: 'x' }], await planned());
    expect(r).toEqual({
      ok: false,
      reason: 'The imagery pack "x" is not installed or does not cover this site.',
    });
  });
  it('returns the plans of requested packs', async () => {
    const r = chooseRasterEmbeds([{ kind: 'terrain', id: 'dem' }], await planned());
    expect(r.ok && r.value.map((v) => v.pack.id)).toEqual(['dem']);
  });
});

describe('writeRasterEmbeds', () => {
  it('writes the clipped archive and its description, and disposes', async () => {
    const p = await planned();
    const c = chooseRasterEmbeds([{ kind: 'imagery', id: 'site' }], p);
    if (!c.ok) throw new Error(c.reason);
    const w = await writeRasterEmbeds(c.value, { tempDir: base });
    expect(w.bytes).toBeGreaterThan(0);
    expect(w.members.map((m) => m.name).sort()).toEqual([
      'packs/imagery/site.json',
      'packs/imagery/site.pmtiles',
    ]);
    const json = w.members.find((m) => m.name.endsWith('.json'));
    const data = json && 'data' in json ? json.data : undefined;
    const meta = RasterPackMeta.parse(JSON.parse(String(data)));
    expect((meta as Record<string, unknown>).source).toBe('package');
    const box = projectBbox(manifest(), 1);
    if (!box) throw new Error('no box');
    expect(meta.bbox).toEqual(box);
    expect(meta.attribution).toBe(near.meta.attribution);
    expect(meta.customerLicence).toBe(near.meta.customerLicence);
    const file = w.members.find((m) => m.name.endsWith('.pmtiles'));
    const path = file && 'file' in file ? file.file : '';
    expect((await stat(path)).size).toBeGreaterThan(0);
    await w.dispose();
    await expect(stat(path)).rejects.toThrow();
  });

  it('clips a half-overlapping pack to the intersection', async () => {
    const box = projectBbox(manifest(), 1);
    if (!box) throw new Error('no box');
    const midLon = (box[0] + box[2]) / 2;
    const half: [number, number, number, number] = [midLon, 44, 17, 46];
    const pack = imageryPack({ id: 'half', label: 'Half', bbox: half, minZoom: 0, maxZoom: 5 });
    const p = await planRasterEmbeds({
      manifest: manifest(),
      packs: { imagery: [await install(pack)], terrain: [] },
      dataRoot: base,
      marginKm: 1,
    });
    const c = chooseRasterEmbeds([{ kind: 'imagery', id: 'half' }], p);
    if (!c.ok) throw new Error(c.reason);
    const w = await writeRasterEmbeds(c.value, { tempDir: base });
    const json = w.members.find((m) => m.name.endsWith('.json'));
    const data = json && 'data' in json ? json.data : undefined;
    const written = RasterPackMeta.parse(JSON.parse(String(data)));
    expect(written.bbox).toEqual([midLon, box[1], box[2], box[3]]);
    await w.dispose();
  });

  it('rejects with AbortError when aborted between two packs', async () => {
    const p = await planned();
    const c = chooseRasterEmbeds(
      [
        { kind: 'imagery', id: 'site' },
        { kind: 'terrain', id: 'dem' },
      ],
      p,
    );
    if (!c.ok) throw new Error(c.reason);
    const temp = join(base, 'tmp2');
    await mkdir(temp);
    const ac = new AbortController();
    // Fires once the first clip has left a file in the temp folder.
    Object.defineProperty(ac.signal, 'aborted', {
      get: () => readdirSync(temp).some((d) => existsSync(join(temp, d, 'imagery-site.pmtiles'))),
    });
    await expect(
      writeRasterEmbeds(c.value, { tempDir: temp, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(temp)).toEqual([]);
  });

  it('rejects with AbortError and leaves no temp folder', async () => {
    const p = await planned();
    const c = chooseRasterEmbeds([{ kind: 'imagery', id: 'site' }], p);
    if (!c.ok) throw new Error(c.reason);
    const temp = join(base, 'tmp');
    await mkdir(temp);
    const ac = new AbortController();
    ac.abort();
    await expect(
      writeRasterEmbeds(c.value, { tempDir: temp, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(temp)).toEqual([]);
  });
});

const meta = (id: string) => ({ ...near.meta, id });

describe('packageRasterPacks', () => {
  it('ignores invalid descriptions and a json without its archive', async () => {
    const a = archiveOf({
      'packs/imagery/good.json': Buffer.from(JSON.stringify(meta('good'))),
      'packs/imagery/good.pmtiles': Buffer.from('x'),
      'packs/imagery/bad.json': Buffer.from('{"nope":1}'),
      'packs/imagery/bad.pmtiles': Buffer.from('x'),
      'packs/imagery/lonely.json': Buffer.from(JSON.stringify(meta('lonely'))),
    });
    const r = await packageRasterPacks(a, 'imagery');
    expect(r.map((x) => x.id)).toEqual(['good']);
    expect(r[0]?.member).toBe('packs/imagery/good.pmtiles');
  });
});

describe('embeddedRasterPacks and findEmbeddedRaster', () => {
  const a = archiveOf({
    'packs/imagery/site.json': Buffer.from(JSON.stringify(meta('site'))),
    'packs/imagery/site.pmtiles': Buffer.from('x'),
    'packs/imagery/other.json': Buffer.from(
      JSON.stringify({ ...meta('other'), bbox: [0, 0, 1, 1] }),
    ),
    'packs/imagery/other.pmtiles': Buffer.from('x'),
  });
  const pkgs: [string, { archive: ZipArchive }][] = [['p1', { archive: a }]];

  it('hides a pack whose id is installed', async () => {
    const installed: RasterPackInfo[] = [{ ...near.meta, sizeBytes: 1 }];
    const r = await embeddedRasterPacks(installed, pkgs, 'imagery');
    expect(r.map((x) => x.id)).toEqual([embeddedRasterId('p1', 'other')]);
    expect(r[0]?.source).toBe('package');
  });
  it('hides a pack covered by an installed pack at its zoom or deeper, not a shallower one', async () => {
    const deep: RasterPackInfo = {
      ...near.meta,
      id: 'big',
      bbox: [0, 0, 30, 60],
      maxZoom: 6,
      sizeBytes: 1,
    };
    const shallow: RasterPackInfo = { ...deep, maxZoom: 3 };
    expect((await embeddedRasterPacks([deep], pkgs, 'imagery')).map((x) => x.id)).toEqual([]);
    expect((await embeddedRasterPacks([shallow], pkgs, 'imagery')).map((x) => x.id).sort()).toEqual(
      [embeddedRasterId('p1', 'other'), embeddedRasterId('p1', 'site')].sort(),
    );
  });
  it('lists the others under pkg ids', async () => {
    const r = await embeddedRasterPacks([], pkgs, 'imagery');
    expect(r.map((x) => x.id).sort()).toEqual(
      [embeddedRasterId('p1', 'other'), embeddedRasterId('p1', 'site')].sort(),
    );
  });
  it('finds the member', () => {
    expect(findEmbeddedRaster('imagery', embeddedRasterId('p1', 'site'), pkgs)?.member).toBe(
      'packs/imagery/site.pmtiles',
    );
    expect(findEmbeddedRaster('imagery', embeddedRasterId('p1', 'nope'), pkgs)).toBeUndefined();
    expect(findEmbeddedRaster('terrain', embeddedRasterId('p1', 'site'), pkgs)).toBeUndefined();
  });
  it('gives a long project name and pack id a valid id that finds its member', async () => {
    const project = 'north-pit-survey-2026-10.aio';
    const id = 'esri-world-imagery-z19';
    const long = archiveOf({
      [`packs/imagery/${id}.json`]: Buffer.from(JSON.stringify(meta(id))),
      [`packs/imagery/${id}.pmtiles`]: Buffer.from('x'),
    });
    const list: [string, { archive: ZipArchive }][] = [[project, { archive: long }]];
    const r = await embeddedRasterPacks([], list, 'imagery');
    expect(r).toHaveLength(1);
    const listed = r[0]?.id ?? '';
    expect(RasterPackId.safeParse(listed).success).toBe(true);
    expect(listed).toBe(embeddedRasterId(project, id));
    expect(findEmbeddedRaster('imagery', listed, list)?.member).toBe(`packs/imagery/${id}.pmtiles`);
  });
  it('keeps packs site and site-2 of one package apart', () => {
    const two = archiveOf({
      'packs/imagery/site.json': Buffer.from(JSON.stringify(meta('site'))),
      'packs/imagery/site.pmtiles': Buffer.from('x'),
      'packs/imagery/site-2.json': Buffer.from(JSON.stringify(meta('site-2'))),
      'packs/imagery/site-2.pmtiles': Buffer.from('x'),
    });
    const list: [string, { archive: ZipArchive }][] = [['p1', { archive: two }]];
    expect(findEmbeddedRaster('imagery', embeddedRasterId('p1', 'site'), list)?.member).toBe(
      'packs/imagery/site.pmtiles',
    );
    expect(findEmbeddedRaster('imagery', embeddedRasterId('p1', 'site-2'), list)?.member).toBe(
      'packs/imagery/site-2.pmtiles',
    );
    expect(findEmbeddedRaster('imagery', 'pkg-p1-site-2', list)).toBeUndefined();
  });
});
