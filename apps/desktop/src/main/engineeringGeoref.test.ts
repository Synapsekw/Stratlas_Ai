/**
 * Acceptance F on the file path (engineering model spec section 2): a georeferenced model exported
 * from project A as a bundle on disk, its GLB imported into project B (another origin) and into
 * project C (the next UTM zone), lands every vertex read back from the file at the same ground
 * position, heading and scale. The truth is written out here by hand from project A's transform.
 */
import {
  fromWgs84,
  layerTransformToGeoref,
  toWgs84,
  worldOfModelPoint,
  type ProjectGeo,
} from '@aio/geo';
import { DEFAULT_MATERIALS, exportBundle, newProcModel, readGlb, writeGlbV2 } from '@aio/modelling';
import { placeImportedGlb, readGlbJsonFromFile, writeExportFolder } from '@aio/project/builder';
import type { Assembly, Mat4, ProcModel, Vec3 } from '@aio/schema';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-f-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rad = Math.PI / 180;
const A: ProjectGeo = { crs: { epsg: 32633 }, origin: [400000, 5600000, 10] };
const B: ProjectGeo = { crs: { epsg: 32633 }, origin: [399500, 5600700, 0] };
// the next zone east, origin near the same ground
const C: ProjectGeo = {
  crs: { epsg: 32634 },
  origin: (() => {
    const p = fromWgs84(toWgs84([400000, 5600000, 0], 32633), 32634);
    return [Math.round(p[0]), Math.round(p[1]), 0] as Vec3;
  })(),
};

/** The layer transform in A: turned 30 degrees clockwise seen from above, then moved. */
const c30 = Math.cos(30 * rad);
const s30 = Math.sin(30 * rad);
const TA: Mat4 = [c30, 0, s30, 0, 0, 1, 0, 0, -s30, 0, c30, 0, 5, 2, -7, 1];
/** Ground truth (E, N, H in zone 33N) of a model point, by hand: local = TA p, then A's frame. */
function truth(p: Vec3): Vec3 {
  const lx = c30 * p[0] - s30 * p[2] + 5;
  const ly = p[1] + 2;
  const lz = s30 * p[0] + c30 * p[2] - 7;
  return [A.origin[0] + lx, A.origin[1] - lz, A.origin[2] + ly];
}

function flue(id: string, centre: Vec3): Assembly {
  return {
    id,
    kind: 'flue',
    name: id,
    description: `Synthetic flue ${id}`,
    category: 'Flues',
    status: 'accepted',
    origin: { by: 'manual' },
    quality: {},
    sources: [],
    params: { centre, rOuter: 0.9, rInner: 0.8, height: 6 },
  };
}
function model(): ProcModel {
  return {
    ...newProcModel({ id: 'stack', name: 'Stack', now: '2026-10-15T00:00:00.000Z' }),
    materials: [...DEFAULT_MATERIALS],
    assemblies: [flue('flue-1', [3, 20, -4]), flue('flue-2', [-6, 40, 5])],
  };
}

/** Every vertex of the file in model space: node translation plus the float32 position. */
function verticesOf(glb: Uint8Array): Vec3[] {
  const { json, bin } = readGlb(glb);
  interface N {
    translation?: number[];
    mesh?: number;
  }
  interface Acc {
    bufferView: number;
    count: number;
  }
  interface View {
    byteOffset?: number;
    byteLength: number;
  }
  const nodes = (json.nodes ?? []) as N[];
  const meshes = (json.meshes ?? []) as { primitives: { attributes: { POSITION: number } }[] }[];
  const accessors = (json.accessors ?? []) as Acc[];
  const views = (json.bufferViews ?? []) as View[];
  const out: Vec3[] = [];
  for (const n of nodes) {
    if (n.mesh === undefined) continue;
    const t = n.translation ?? [0, 0, 0];
    for (const p of meshes[n.mesh]?.primitives ?? []) {
      const acc = accessors[p.attributes.POSITION];
      const view = acc ? views[acc.bufferView] : undefined;
      if (!acc || !view) throw new Error('no positions');
      const start = view.byteOffset ?? 0;
      const f = new Float32Array(bin.slice(start, start + acc.count * 12));
      for (let i = 0; i < acc.count; i++)
        out.push([
          (t[0] ?? 0) + (f[3 * i] ?? NaN),
          (t[1] ?? 0) + (f[3 * i + 1] ?? NaN),
          (t[2] ?? 0) + (f[3 * i + 2] ?? NaN),
        ]);
    }
  }
  return out;
}

function expectClose(a: Vec3, b: Vec3, tol: number): void {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] ?? NaN) - (b[i] ?? NaN))).toBeLessThan(tol);
}
const bearing = (p: Vec3, q: Vec3) => (Math.atan2(q[0] - p[0], q[1] - p[1]) / rad + 360) % 360;

async function exported(): Promise<string> {
  const georef = layerTransformToGeoref(TA, A, null, 'place-model');
  const b = exportBundle(model(), { detail: 'fast', generator: 'test', georef });
  const folder = join(dir, 'stack');
  await writeExportFolder(folder, {
    'stack.glb': b.glb,
    'stack.procmodel.json': b.procmodel,
    'stack.components.json': b.components,
    ...(b.georeference ? { 'stack.georeference.json': b.georeference } : {}),
  });
  expect((await readdir(folder)).sort()).toEqual([
    'stack.components.json',
    'stack.georeference.json',
    'stack.glb',
    'stack.procmodel.json',
  ]);
  return join(folder, 'stack.glb');
}

describe('acceptance F: export from A, import into B and C', () => {
  it('lands every probe vertex at the same E, N, H in a project with another origin', async () => {
    const file = await exported();
    const r = placeImportedGlb(await readGlbJsonFromFile(file), B);
    expect(r.placement).toBe('placed');
    const vs = verticesOf(new Uint8Array(await readFile(file)));
    expect(vs.length).toBeGreaterThan(100);
    const probe = [vs[0], vs[Math.floor(vs.length / 2)], vs[vs.length - 1]];
    for (const v of probe) {
      if (!v) throw new Error('no vertex');
      expectClose(worldOfModelPoint(r.transform, B, v), truth(v), 0.001);
    }
    // heading: model +X points 30 degrees clockwise of grid east; scale 1
    const o = worldOfModelPoint(r.transform, B, [0, 0, 0]);
    const x = worldOfModelPoint(r.transform, B, [10, 0, 0]);
    expect(Math.abs(bearing(o, x) - 120)).toBeLessThan(0.01);
    const len = Math.hypot(x[0] - o[0], x[1] - o[1], x[2] - o[2]);
    expect(Math.abs(len / 10 - 1)).toBeLessThan(1e-6);
  });

  it('lands every probe vertex on the same ground in the next UTM zone', async () => {
    const file = await exported();
    const r = placeImportedGlb(await readGlbJsonFromFile(file), C);
    expect(r.placement).toBe('placed');
    const vs = verticesOf(new Uint8Array(await readFile(file)));
    for (const v of [vs[0], vs[Math.floor(vs.length / 2)], vs[vs.length - 1]]) {
      if (!v) throw new Error('no vertex');
      const w = worldOfModelPoint(r.transform, C, v);
      // back to zone 33N through WGS84 directly
      expectClose(fromWgs84(toWgs84(w, 32634), 32633), truth(v), 0.001);
    }
    // the true direction of model +X is kept (checked back in zone 33N)
    const o = fromWgs84(toWgs84(worldOfModelPoint(r.transform, C, [0, 0, 0]), 32634), 32633);
    const x = fromWgs84(toWgs84(worldOfModelPoint(r.transform, C, [10, 0, 0]), 32634), 32633);
    expect(Math.abs(bearing(o, x) - 120)).toBeLessThan(0.01);
  });

  it('importing the same file twice does not apply the georeference twice', async () => {
    const file = await exported();
    const a = placeImportedGlb(await readGlbJsonFromFile(file), B);
    const b = placeImportedGlb(await readGlbJsonFromFile(file), B);
    expect(b.transform).toEqual(a.transform);
    const v = verticesOf(new Uint8Array(await readFile(file)))[0];
    if (!v) throw new Error('no vertex');
    expectClose(worldOfModelPoint(b.transform, B, v), truth(v), 0.001);
  });

  it('the older embedded structure imports placed', async () => {
    const g = layerTransformToGeoref(TA, A, null, 'place-model');
    const glb = writeGlbV2([], {
      root: 'old',
      generator: 'older tool',
      materials: [],
      assetExtras: {
        georeference: {
          schema: 'chimney.georeference/1',
          crs: { epsg: 32633 },
          origin_easting_northing_height_m: g.anchor,
          model_anchor: 'origin',
          model_axes: { x: 'grid east', y: 'up', z: 'grid south' },
          units: 'm',
          model_to_source_enh_column_major: g.modelToCrs,
          heading_about_up_deg: 30,
        },
      },
    });
    const file = join(dir, 'old.glb');
    await writeFile(file, glb);
    const r = placeImportedGlb(await readGlbJsonFromFile(file), B);
    expect(r.placement).toBe('placed');
    expectClose(worldOfModelPoint(r.transform, B, [1, 2, 3]), truth([1, 2, 3]), 0.001);
  });

  it('a file without its matrix needs placing', async () => {
    const g: Record<string, unknown> = { ...layerTransformToGeoref(TA, A, null, 'place-model') };
    delete g.modelToCrs;
    const file = join(dir, 'partial.glb');
    await writeFile(
      file,
      writeGlbV2([], {
        root: 'p',
        generator: 'test',
        materials: [],
        assetExtras: { aioGeoref: g },
      }),
    );
    const r = placeImportedGlb(await readGlbJsonFromFile(file), B);
    expect(r.placement).toBe('needed');
    expect(r.transform).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});
