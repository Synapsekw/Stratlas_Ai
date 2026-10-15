import { Georef, type Assembly, type ProcModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { readGlb } from '../glb';
import { componentRegister, exportBundle } from './exportBundle';
import { stackModel } from './fixtures';
import { buildEngineeringGlb } from './meshAssemblies';
import { khronos } from './testKhronos';
import { validateGlb } from './validate';

/** Synthetic georeference (not a real place): model origin at the anchor, no turn. */
const GEOREF: Georef = {
  schema: 'aio.georef/1',
  crs: { epsg: 32633 },
  anchor: [400123.456789, 5600987.654321, 12.345],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 400123.456789, 5600987.654321, 12.345, 1],
  heading: { deg: 0, status: 'measured' },
  scale: { factor: 1, status: 'measured' },
  horizontal: { status: 'surveyed', accuracyM: 0.02 },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer', runId: 'run-1' },
};

/** The stack fixture with most components accepted, one rejected and one left as a draft. */
function model(): ProcModel {
  const m = stackModel();
  const assemblies = m.assemblies.map((a, i): Assembly => {
    if (a.id === 'flue-4') return { ...a, status: 'rejected' };
    if (i === 1) return { ...a, status: 'draft' };
    return {
      ...a,
      status: 'accepted',
      ...(a.id === 'flue-1'
        ? {
            tag: 'FL-001',
            type: 'steel liner',
            material: 'stainless',
            unobserved: ['interior' as const],
            sources: [{ kind: 'cloud' as const, ref: 'cloud-1' }],
          }
        : {}),
    };
  });
  return { ...m, assemblies };
}

interface Node {
  name?: string;
  extras?: Record<string, unknown>;
}

describe('componentRegister', () => {
  it('has one row per accepted component, with its identity, dimensions and basis', () => {
    const m = model();
    const rows = componentRegister(m);
    const accepted = m.assemblies.filter((a) => a.status === 'accepted');
    expect(rows.map((r) => r.id)).toEqual(accepted.map((a) => a.id));
    expect(rows.map((r) => r.id)).not.toContain('flue-4');
    const flue = rows.find((r) => r.id === 'flue-1');
    expect(flue).toMatchObject({
      name: 'flue 1',
      category: 'Flues',
      type: 'steel liner',
      tag: 'FL-001',
      parent: 'shaft-1',
      kind: 'flue',
      units: 'm',
      material: 'stainless',
      status: 'accepted',
      dimensions: { rOuter: 0.9, rInner: 0.8, height: 6 },
      basis: { centre: 'observed', rOuter: 'inferred', rInner: 'inferred', height: 'inferred' },
      sources: [{ kind: 'cloud', ref: 'cloud-1' }],
      unobserved: ['interior'],
    });
    expect(flue?.description.length).toBeGreaterThan(0);
    // positions are not dimensions
    expect(flue?.dimensions).not.toHaveProperty('centre');
  });
});

describe('exportBundle', () => {
  it('writes the GLB with the georeference, the register, the model and the sidecar', async () => {
    const m = model();
    const b = exportBundle(m, { detail: 'fast', generator: 'test', georef: GEOREF });
    const { json } = readGlb(b.glb);
    const asset = json.asset as { extras?: { aioGeoref?: unknown } };
    // the full-precision values travel in the JSON, unchanged
    expect(asset.extras?.aioGeoref).toEqual(GEOREF);
    expect(Georef.parse(JSON.parse(b.georeference ?? 'null'))).toEqual(GEOREF);
    expect(JSON.parse(b.components)).toEqual(componentRegister(m));
    const pm = JSON.parse(b.procmodel) as ProcModel;
    expect(pm.schema).toBe('aio.procmodel/2');
    expect(pm.georef).toEqual(GEOREF);
    expect(pm.assemblies.map((a) => a.id)).toEqual(m.assemblies.map((a) => a.id));

    // ids, descriptions and categories of the accepted components survive in the node extras
    const nodes = (json.nodes ?? []) as Node[];
    for (const a of m.assemblies.filter((x) => x.status === 'accepted')) {
      const n = nodes.find((x) => x.name === a.id);
      expect(n?.extras, a.id).toMatchObject({
        component: a.id,
        description: a.description,
        category: a.category,
      });
    }
    expect(nodes.some((x) => x.name === 'flue-4')).toBe(false);

    const report = await validateGlb(b.glb, { budget: 150_000, khronos });
    expect(report.messages).toEqual([]);
    expect(report.validatorErrors + report.validatorWarnings).toBe(0);
    expect(report.finite && report.indicesValid).toBe(true);
  });

  it('keeps the mesh bytes exactly as the GLB writer made them', () => {
    const m = model();
    const plain = buildEngineeringGlb(m, { detail: 'fast', drafts: false, generator: 'test' }).glb;
    const b = exportBundle(m, { detail: 'fast', generator: 'test', georef: GEOREF });
    expect(Buffer.from(readGlb(b.glb).bin).equals(Buffer.from(readGlb(plain).bin))).toBe(true);
    // vertex positions stay near their node, never at map coordinates
    const { json, bin } = readGlb(b.glb);
    const acc = (json.accessors ?? []) as { max?: number[]; min?: number[] }[];
    for (const a of acc)
      for (const v of [...(a.max ?? []), ...(a.min ?? [])]) expect(Math.abs(v)).toBeLessThan(1000);
    expect(bin.byteLength).toBeGreaterThan(0);
  });

  it('reports how the GLB was built', () => {
    const b = exportBundle(model(), { detail: 'fast', generator: 'test', georef: null });
    expect(b.build.triangles).toBeGreaterThan(1000);
    expect(b.build.overBudget).toBe(false);
    expect(b.build.failed).toEqual([]);
    expect(b.build.detail).toBe('fast');
  });

  it('writes no georeference when there is none, not even an old one in the model', () => {
    const b = exportBundle(
      { ...model(), georef: GEOREF },
      { detail: 'fast', generator: 'test', georef: null },
    );
    expect(JSON.parse(b.procmodel)).not.toHaveProperty('georef');
    expect(b.georeference).toBeNull();
    const asset = readGlb(b.glb).json.asset as { extras?: unknown };
    // only the engineering marker, no georeference
    expect(asset.extras).toEqual({ aioEngineering: 1 });
  });

  it('refuses an invalid georeference', () => {
    const bad = { ...GEOREF, modelToCrs: [1, 2, 3] };
    expect(() =>
      exportBundle(model(), { detail: 'fast', generator: 'test', georef: bad }),
    ).toThrow();
  });
});
