import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest, VolumesFile } from '@aio/schema';
import { parseGlb } from './glb';
import { importMasafi } from './masafi';

// Synthetic kit build: a 4 x 4 m yard at E 1000..1004, N 2000..2004 with one pile P01 in the
// middle (a 1 m high box on a 52 m floor), surveyed twice; the pile is 0.5 m lower at e2.
const X0 = 1000;
const Y1 = 2004;

const encI16 = (a: ArrayLike<number>, w: number) => {
  const d = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = (a[i] ?? 0) - (i % w === 0 ? 0 : (a[i - 1] ?? 0));
  return deflateSync(Buffer.from(d.buffer)).toString('base64');
};
const encBits = (bits: ArrayLike<number>) => {
  const u = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++)
    if (bits[i]) u[i >> 3] = (u[i >> 3] ?? 0) | (1 << (7 - (i & 7)));
  return deflateSync(u).toString('base64');
};
function npy(h: number, w: number, values: Float32Array): Buffer {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${h}, ${w}), }`;
  while ((10 + header.length + 1) % 64) header += ' ';
  header += '\n';
  const pre = Buffer.alloc(10);
  pre.set([0x93, ...Buffer.from('NUMPY'), 1, 0]);
  pre.writeUInt16LE(header.length, 8);
  return Buffer.concat([pre, Buffer.from(header, 'latin1'), Buffer.from(values.buffer)]);
}

/** Pile box: E 1001.5..1002.5, N 2001.5..2002.5. */
const inPile = (e: number, n: number) => e > 1001.5 && e < 1002.5 && n > 2001.5 && n < 2002.5;
const surface = (ep: 'e1' | 'e2', e: number, n: number) =>
  52 + (inPile(e, n) ? (ep === 'e1' ? 1 : 0.5) : 0);

/** A small test image (JPEG or WebP by extension), made without ffmpeg so CI needs no binary. */
function testImage(path: string, width: number, height: number): Promise<unknown> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } } })
    .toFormat(path.endsWith('.webp') ? 'webp' : 'jpeg')
    .toFile(path);
}

describe('Masafi stockpile import (synthetic kit build)', () => {
  let root = '';
  const src = (...p: string[]) => join(root, 'src', ...p);
  const out = () => join(root, 'out');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aio-masafi-'));
    for (const d of ['data/piles', 'work', 'lib', 'overlays', 'tiles/e1/0', 'tiles/e1/1'])
      mkdirSync(src(d), { recursive: true });
    mkdirSync(src('tiles/e2/1'), { recursive: true });
    const grid = {
      x0: X0,
      y0: 2000,
      x1: 1004,
      y1: Y1,
      dsm_res: 0.1,
      ortho_res: 0.0625,
      tile: 64,
      zmax: 1,
    };
    writeFileSync(
      src('job.json'),
      JSON.stringify({ title: 'T', grid, epochs: [{ id: 'e1' }, { id: 'e2' }] }),
    );
    // DSM grids, 0.1 m
    for (const ep of ['e1', 'e2'] as const) {
      const z = new Float32Array(40 * 40);
      for (let j = 0; j < 40; j++)
        for (let i = 0; i < 40; i++)
          z[j * 40 + i] = surface(ep, X0 + (i + 0.5) * 0.1, Y1 - (j + 0.5) * 0.1);
      writeFileSync(src(`work/dsm_${ep}.npy`), npy(40, 40, z));
    }
    // pile grid, 0.1 m over E 1001..1003, N 2001..2003
    const w = 20;
    const n = w * w;
    const zone = new Uint8Array(n);
    const zg = { e1: new Int16Array(n), e2: new Int16Array(n) };
    const tin = new Int16Array(n).fill(200);
    for (let j = 0; j < w; j++)
      for (let i = 0; i < w; i++) {
        const e = 1001 + (i + 0.5) * 0.1;
        const nn = 2003 - (j + 0.5) * 0.1;
        zone[j * w + i] = inPile(e, nn) ? 1 : 0;
        zg.e1[j * w + i] = Math.round((surface('e1', e, nn) - 50) * 100);
        zg.e2[j * w + i] = Math.round((surface('e2', e, nn) - 50) * 100);
      }
    const ep = (k: 'e1' | 'e2') => ({
      z: encI16(zg[k], w),
      m: encBits(zone),
      tin: encI16(tin, w),
      low: 52,
      avg: 52,
      plane: [52, 0, 0],
    });
    const pile = {
      id: 'P01',
      res: 0.1,
      w,
      h: w,
      x0: 1001,
      y1: 2003,
      zoff: 50,
      zone: encBits(zone),
      ep: { e1: ep('e1'), e2: ep('e2') },
    };
    writeFileSync(
      src('data/piles/P01.js'),
      `window.VS_PILE=window.VS_PILE||{};window.VS_PILE["P01"]=${JSON.stringify(pile)};`,
    );
    const ring: [number, number][] = [
      [1001.5, 2001.5],
      [1002.5, 2001.5],
      [1002.5, 2002.5],
      [1001.5, 2002.5],
    ];
    const vol = (v: number) => ({ fill: v, cut: 0, net: v });
    const pe = (v: number, top: number) => ({
      k: 1,
      area_m2: 1,
      top_m: top,
      height_m: top - 52,
      bbox: [1001.5, 2001.5, 1002.5, 2002.5],
      ring,
      ground_toe_frac: 1,
      vol: { low: vol(v), avg: vol(v), plane: vol(v), tin: vol(v) },
      survey_err_m3: 0.1,
    });
    const site = {
      epochs: {
        e1: { id: 'e1', label: '31 Dec 2020', date: '2020-12-31' },
        e2: { id: 'e2', label: '10 Jan 2021', date: '2021-01-10' },
      },
      piles: [
        {
          id: 'P01',
          name: 'Pile 01',
          material: null,
          zone: 1,
          epochs: { e1: pe(1, 53), e2: pe(0.5, 52.5) },
          zone_ring: ring,
          change: { fill: 0, cut: 0.5, net: -0.5 },
          status: 'matched',
        },
      ],
      site_change: { fill: 0, cut: 0.5, area_m2: 16, net: -0.5 },
      pile_change: { fill: 0, cut: 0.5, net: -0.5 },
      totals: { e1: { tin: 1, area_m2: 1 }, e2: { tin: 0.5, area_m2: 1 } },
      grid: { ...grid, overlay_res: 0.2 },
      volume: { deadband_m: 0.1, default_base: 'tin', density_t_m3: 1.6, swell: 1 },
      zoff: 50,
      meta: {
        title: 'Masafi stockpile review',
        customer: 'Masafi',
        site: 'Masafi aggregate yard, Kuwait',
        crs: 'EPSG:32639',
        epoch_order: ['e1', 'e2'],
      },
    };
    writeFileSync(src('data/site.js'), `window.VS_SITE=${JSON.stringify(site)};`);
    const jpg = src('overlays/site_e2.jpg');
    await testImage(jpg, 64, 64);
    const b64 = readFileSync(jpg).toString('base64');
    for (const e of ['e1', 'e2'])
      writeFileSync(
        src(`data/tex_${e}.js`),
        `window.VS_TEX=window.VS_TEX||{};window.VS_TEX["${e}"]="data:image/jpeg;base64,${b64}";`,
      );
    for (const t of ['tiles/e1/1/0_0.webp', 'tiles/e1/0/0_0.webp', 'tiles/e2/1/0_0.webp'])
      await testImage(src(t), 64, 64);
    writeFileSync(src('data/config.js'), 'window.VS_CONFIG={};');
    writeFileSync(src('lib/three.min.js'), '// three');
    writeFileSync(
      src('Masafi Stockpile Review.html'),
      '<html><script src="data/site.js"></script></html>',
    );
    writeFileSync(src('Masafi Stockpile Volume Report.pdf'), '%PDF');
    writeFileSync(src('Masafi stockpile register.csv'), 'pile\nP01\n');
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a package whose manifest validates', async () => {
    const r = await importMasafi({ src: src(), out: out(), regionBufferM: 0.5 });
    expect(r.issues).toBe(0);
    const m = parseManifest(JSON.parse(readFileSync(join(out(), 'manifest.json'), 'utf8')));
    if (!m.ok) throw new Error(m.error);
    const man = m.value;
    expect(man.crs).toEqual({ epsg: 32639 });
    expect(man.captures.map((c) => c.date)).toEqual(['2020-12-31', '2021-01-10']);
    expect(man.layers.map((l) => `${l.kind}:${l.id}:${l.visible}`)).toEqual([
      'mesh:terrain-2021-01-10:true',
      'mesh:terrain-2020-12-31:false',
      'raster:ortho-2021-01-10:true',
      'raster:ortho-2020-12-31:false',
      'legacy:volumetric-review:true',
    ]);
    expect(man.severityModels[0]?.name).toBe('Stockpile');
    expect(man.classCatalogues[0]?.classes).toHaveLength(3);
    const issues = JSON.parse(readFileSync(join(out(), 'issues.json'), 'utf8')) as {
      issues: unknown[];
    };
    expect(issues.issues).toEqual([]);
  }, 60_000);

  it('builds a textured terrain GLB per date with a tagged node per pile', () => {
    const man = JSON.parse(readFileSync(join(out(), 'manifest.json'), 'utf8')) as {
      origin: number[];
      layers: { id: string; src?: { path: string }; tags?: { node: string; tag: string }[] }[];
    };
    const layer = man.layers.find((l) => l.id === 'terrain-2021-01-10');
    expect(layer?.tags).toEqual([{ node: 'P01_e2', tag: 'P01', area: '1 m³' }]);
    const { json } = parseGlb(new Uint8Array(readFileSync(join(out(), layer?.src?.path ?? ''))));
    const names = (json.nodes ?? []).map((n) => n.name);
    expect(names).toContain('P01_e2');
    expect(names).toContain('Terrain_e2');
    expect(json.images?.[0]?.mimeType).toBe('image/jpeg');
    const terrain = json.nodes?.find((n) => n.name === 'Terrain_e2');
    expect(terrain?.extras).toMatchObject({ type: 'terrain' });
    // the pile node's top is the e2 pile surface: 52.5 m
    const pileMesh = json.meshes?.[json.nodes?.find((n) => n.name === 'P01_e2')?.mesh ?? -1];
    const pos = json.accessors?.[pileMesh?.primitives[0]?.attributes.POSITION ?? -1];
    expect((pos?.max?.[1] ?? 0) + (man.origin[2] ?? 0)).toBeCloseTo(52.5, 3);
    expect(pileMesh?.primitives.some((p) => p.mode === 1)).toBe(true); // toe line
  });

  it('writes recomputed volumes per pile and date next to the kit figures', () => {
    const v = JSON.parse(readFileSync(join(out(), 'volumes.json'), 'utf8')) as {
      schema: string;
      piles: {
        id: string;
        epochs: Record<string, { volumes: Record<string, { net: number }> }>;
        change: { net: number };
      }[];
      check: { maxRelDiff: number };
    };
    expect(v.schema).toBe('aio.volumes/1');
    const p = v.piles[0];
    expect(p?.epochs.e1?.volumes.tin?.net).toBeCloseTo(1, 3);
    expect(p?.epochs.e2?.volumes.low?.net).toBeCloseTo(0.5, 3);
    expect(p?.change.net).toBeCloseTo(-0.5, 3);
    expect(v.check.maxRelDiff).toBeLessThan(0.005);
  });

  it('writes a volumes.json the volumetric workspace reads, with its grids and survey layers', () => {
    const v = VolumesFile.parse(JSON.parse(readFileSync(join(out(), 'volumes.json'), 'utf8')));
    expect(v.grids).toEqual({
      format: 'vs-kit-js',
      piles: 'legacy/data/piles/{id}.js',
      dsm: 'legacy/data/dsm_{epoch}.js',
      coarse: 'legacy/data/vol.js',
    });
    const c = v.captures.find((x) => x.epoch === 'e2');
    expect(c?.layers).toEqual([`terrain-${c?.date ?? ''}`, `ortho-${c?.date ?? ''}`]);
    const man = JSON.parse(readFileSync(join(out(), 'manifest.json'), 'utf8')) as {
      layers: { id: string }[];
    };
    for (const id of c?.layers ?? []) expect(man.layers.map((l) => l.id)).toContain(id);
  });

  it('keeps the offline viewer, the report and the register', () => {
    expect(existsSync(join(out(), 'legacy/Masafi Stockpile Review.html'))).toBe(true);
    expect(existsSync(join(out(), 'legacy/data/site.js'))).toBe(true);
    expect(existsSync(join(out(), 'legacy/data/piles/P01.js'))).toBe(true);
    expect(existsSync(join(out(), 'report/Masafi stockpile register.csv'))).toBe(true);
    expect(existsSync(join(out(), 'report/Masafi Stockpile Volume Report.pdf'))).toBe(true);
    expect(existsSync(join(out(), 'thumbnail.jpg'))).toBe(true);
    const tiles = JSON.parse(readFileSync(join(out(), 'rasters/ortho-e1/tiles.json'), 'utf8')) as {
      levels: { z: number; cols: number }[];
    };
    expect(tiles.levels.map((l) => [l.z, l.cols])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(existsSync(join(out(), 'rasters/ortho-e1/1/1_1.webp'))).toBe(true); // padding tile
    expect(readFileSync(join(out(), 'IMPORT-REPORT.md'), 'utf8')).toMatch(/volumes\.json/);
  });

  it('skips every file on an unchanged re-run', async () => {
    const r = await importMasafi({ src: src(), out: out(), regionBufferM: 0.5 });
    expect(r.written).toBe(0);
    expect(r.skipped).toBeGreaterThan(10);
  }, 60_000);
});
