import { fromWgs84, toWgs84, transformPoint, worldOfModelPoint, type ProjectGeo } from '@aio/geo';
import type { Georef, Mat4, Vec3 } from '@aio/schema';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeGlb, parseGlb, type GltfJson } from '../import/glb';
import { placeImportedGlb, readGlbJsonChunk, readGlbJsonFromFile } from './glbGeoref';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-glbgeoref-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PLAIN_MESSAGE = 'Place it with Align, Georeference model.';
const rad = Math.PI / 180;

/** Model (x east, y up, z south) to E, N, H: scaled, turned clockwise by `h` deg, at `a`. */
function enhMatrix(a: Vec3, h: number, s: number): Mat4 {
  const c = Math.cos(h * rad);
  const n = Math.sin(h * rad);
  return [s * c, -s * n, 0, 0, 0, 0, s, 0, -s * n, -s * c, 0, 0, a[0], a[1], a[2], 1];
}
/** The georef truth for a model point, written out by hand (not the code under test). */
function truth(m: Mat4, p: Vec3): Vec3 {
  const at = (r: number, c: number) => m[c * 4 + r] ?? NaN;
  return [0, 1, 2].map(
    (r) => at(r, 0) * p[0] + at(r, 1) * p[1] + at(r, 2) * p[2] + at(r, 3),
  ) as Vec3;
}

const ANCHOR: Vec3 = [400010.125, 5600020.75, 15.5];
const georef = (o: Partial<Georef> = {}): Georef => ({
  schema: 'aio.georef/1',
  crs: { epsg: 32633 },
  anchor: ANCHOR,
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: enhMatrix(ANCHOR, 30, 1),
  heading: { deg: 30, status: 'measured' },
  scale: { factor: 1, status: 'measured' },
  horizontal: { status: 'from-source' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer' },
  ...o,
});
/** The older embedded structure (synthetic values). */
const compat = {
  schema: 'chimney.georeference/1',
  crs: { epsg: 32633, name: 'WGS 84 / UTM zone 33N' },
  origin_easting_northing_height_m: ANCHOR,
  model_anchor: 'base centre',
  model_axes: { x: 'grid east', y: 'up', z: 'grid south' },
  units: 'metres',
  model_to_source_enh_column_major: enhMatrix(ANCHOR, 30, 1),
  heading_about_up_deg: 30,
  basis: 'synthetic test values',
};

const B: ProjectGeo = { crs: { epsg: 32633 }, origin: [399500, 5600700, 0] };
const C: ProjectGeo = {
  crs: { epsg: 32634 },
  origin: transformPoint([400000, 5600000, 0], 32633, 32634),
};

/** Three triangles' worth of vertices, read back from the file. */
const POSITIONS = new Float32Array([0, 0, 0, 3.5, 50, -2, -4, 120, 6]);

/** A GLB with one mesh node and `extras` as `asset.extras` (none when undefined). */
function glbWith(extras?: Record<string, unknown>): Uint8Array {
  const g = encodeGlb({
    generator: 'test',
    nodes: [{ name: 'shaft-1', mesh: 0 }],
    scene: [0],
    meshes: [
      {
        name: 'shaft-1',
        primitives: [{ material: 0, positions: POSITIONS, indices: new Uint32Array([0, 1, 2]) }],
      },
    ],
    materials: [{ name: 'grey' }],
    images: [],
  });
  if (extras === undefined) return g;
  const { json, bin } = parseGlb(g);
  const next = { ...json, asset: { ...json.asset, extras } } as GltfJson;
  const text = new TextEncoder().encode(JSON.stringify(next));
  const jsonLen = text.length + ((4 - (text.length % 4)) % 4);
  const total = 20 + jsonLen + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  dv.setUint32(20 + jsonLen, bin.byteLength, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(bin, 28 + jsonLen);
  return out;
}

/** The vertices of the file, as float32 (what the renderer will draw). */
function verticesOf(glb: Uint8Array): Vec3[] {
  const { json, bin } = parseGlb(glb);
  const view = json.bufferViews?.[json.accessors?.[0]?.bufferView ?? -1];
  if (!view) throw new Error('no positions');
  const f = new Float32Array(
    bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength).buffer,
  );
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < f.length; i += 3)
    out.push([f[i] ?? NaN, f[i + 1] ?? NaN, f[i + 2] ?? NaN]);
  return out;
}

function expectClose(a: Vec3, b: Vec3, tol: number): void {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] ?? NaN) - (b[i] ?? NaN))).toBeLessThan(tol);
}
const jsonOf = (glb: Uint8Array) => readGlbJsonChunk(glb);

describe('readGlbJsonChunk', () => {
  it('reads the JSON chunk of a GLB', () => {
    expect(jsonOf(glbWith({ a: 1 }))?.asset).toMatchObject({ version: '2.0', extras: { a: 1 } });
  });
  it('refuses what is not a well-formed GLB 2 JSON chunk', () => {
    const good = glbWith();
    const bad = (edit: (dv: DataView) => void) => {
      const b = good.slice();
      edit(new DataView(b.buffer));
      return readGlbJsonChunk(b);
    };
    expect(
      bad((dv) => {
        dv.setUint32(0, 0x12345678, true);
      }),
    ).toBeNull(); // magic
    expect(
      bad((dv) => {
        dv.setUint32(4, 1, true);
      }),
    ).toBeNull(); // version
    expect(
      bad((dv) => {
        dv.setUint32(16, 0x004e4942, true);
      }),
    ).toBeNull(); // not JSON first
    expect(
      bad((dv) => {
        dv.setUint32(12, 0xfffffff0, true);
      }),
    ).toBeNull(); // longer than the file
    expect(
      bad((dv) => {
        dv.setUint32(8, 24, true);
      }),
    ).toBeNull(); // chunk past the stated length
    expect(readGlbJsonChunk(good.subarray(0, 19))).toBeNull();
    expect(readGlbJsonChunk(good.subarray(0, 30))).toBeNull(); // truncated chunk
  });
});

describe('readGlbJsonFromFile', () => {
  it('reads the JSON chunk only, and refuses a chunk that runs past the file', async () => {
    const f = join(dir, 'a.glb');
    await writeFile(f, glbWith({ aioGeoref: georef() }));
    expect((await readGlbJsonFromFile(f))?.asset).toMatchObject({
      extras: { aioGeoref: georef() },
    });
    const cut = glbWith({ aioGeoref: georef() }).subarray(0, 64);
    await writeFile(f, cut);
    expect(await readGlbJsonFromFile(f)).toBeNull();
    await writeFile(f, new TextEncoder().encode('not a glb at all, just text'));
    expect(await readGlbJsonFromFile(f)).toBeNull();
  });
});

describe('placeImportedGlb', () => {
  it('aio georef places the model', () => {
    const g = georef();
    const glb = glbWith({ aioGeoref: g });
    const r = placeImportedGlb(jsonOf(glb), B);
    expect(r.placement).toBe('placed');
    expect(r.georef).toEqual(g);
    expect(r.message).toContain('Placed from the georeference in the file.');
    expect(r.message).toContain('vertical datum is unknown');
    for (const v of verticesOf(glb))
      expectClose(worldOfModelPoint(r.transform, B, v), truth(g.modelToCrs, v), 0.001);
    // the heading lands: model +X points 30 degrees clockwise of grid east
    const o = worldOfModelPoint(r.transform, B, [0, 0, 0]);
    const x = worldOfModelPoint(r.transform, B, [100, 0, 0]);
    const bearing = Math.atan2(x[0] - o[0], x[1] - o[1]) / rad;
    expect(Math.abs(bearing - 120)).toBeLessThan(0.01);
    expect(Math.abs(Math.hypot(x[0] - o[0], x[1] - o[1], x[2] - o[2]) - 100)).toBeLessThan(1e-4);
  });

  it('places across UTM zones at the same ground position', () => {
    const g = georef();
    const glb = glbWith({ aioGeoref: g });
    const r = placeImportedGlb(jsonOf(glb), C);
    expect(r.placement).toBe('placed');
    for (const v of verticesOf(glb)) {
      const w = worldOfModelPoint(r.transform, C, v);
      // back to zone 33N through WGS84 directly (not through the placement code)
      expectClose(fromWgs84(toWgs84(w, 32634), 32633), truth(g.modelToCrs, v), 0.001);
    }
    // the anchor sits on the same lon, lat
    const ll = toWgs84(ANCHOR, 32633);
    const w0 = worldOfModelPoint(r.transform, C, [0, 0, 0]);
    expectClose(toWgs84(w0, 32634), ll, 1e-8);
  });

  it('compat structure places it', () => {
    const glb = glbWith({ georeference: compat });
    const r = placeImportedGlb(jsonOf(glb), B);
    expect(r.placement).toBe('placed');
    expect(r.georef?.provenance.by).toBe('compat');
    for (const v of verticesOf(glb))
      expectClose(
        worldOfModelPoint(r.transform, B, v),
        truth(compat.model_to_source_enh_column_major, v),
        0.001,
      );
  });

  it('invalid aioGeoref gives placement needed with the reason', () => {
    const r = placeImportedGlb(jsonOf(glbWith({ aioGeoref: { schema: 'aio.georef/1' } })), B);
    expect(r.placement).toBe('needed');
    expect(r.transform).toEqual(IDENTITY);
    expect(r.georef).toBeUndefined();
    expect(r.message).toMatch(/cannot be used/);
    expect(r.message).toContain('Place model');
    expect(r.message).not.toContain('Placed from');
  });

  it('an unsupported CRS gives placement needed and keeps the record', () => {
    const g = georef({ crs: { wkt: 'LOCAL_CS["synthetic test frame"]' } });
    const r = placeImportedGlb(jsonOf(glbWith({ aioGeoref: g })), B);
    expect(r.placement).toBe('needed');
    expect(r.transform).toEqual(IDENTITY);
    expect(r.georef).toEqual(g);
    expect(r.message).not.toContain('Placed from');
  });

  it('different known vertical datums: placed on the ground, height needed', () => {
    const g = georef({ vertical: { datum: 'EGM2008', status: 'from-source' } });
    const r = placeImportedGlb(jsonOf(glbWith({ aioGeoref: g })), {
      ...B,
      verticalDatum: 'NAVD88',
    });
    expect(r.placement).toBe('needed');
    expectClose(worldOfModelPoint(r.transform, B, [0, 0, 0]), ANCHOR, 0.001);
    expect(r.message).toMatch(/not in height/);
  });

  it('foreign extras are ignored', () => {
    const foreign = {
      author: 'another tool',
      georeference: { system: 'their own', origin: [1, 2, 3] },
      title: 'x',
    };
    const r = placeImportedGlb(jsonOf(glbWith(foreign)), B);
    expect(r).toEqual({ transform: IDENTITY, message: PLAIN_MESSAGE });
    expect(r.placement).toBeUndefined();
  });

  it('no extras keeps identity', () => {
    expect(placeImportedGlb(jsonOf(glbWith()), B)).toEqual({
      transform: IDENTITY,
      message: PLAIN_MESSAGE,
    });
    expect(placeImportedGlb(null, B)).toEqual({ transform: IDENTITY, message: PLAIN_MESSAGE });
  });

  it('missing metadata in our record gives placement needed', () => {
    const partial: Record<string, unknown> = { ...georef() };
    delete partial.modelToCrs;
    const r = placeImportedGlb(jsonOf(glbWith({ aioGeoref: partial })), B);
    expect(r.placement).toBe('needed');
    expect(r.transform).toEqual(IDENTITY);
  });

  it('re-import of an already placed file is idempotent', async () => {
    const g = georef();
    const f = join(dir, 'm.glb');
    const bytes = glbWith({ aioGeoref: g });
    await writeFile(f, bytes);
    const a = placeImportedGlb(await readGlbJsonFromFile(f), B);
    const b = placeImportedGlb(await readGlbJsonFromFile(f), B);
    expect(b.transform).toEqual(a.transform);
    for (const v of verticesOf(bytes))
      expectClose(worldOfModelPoint(b.transform, B, v), truth(g.modelToCrs, v), 0.001);
  });
});
