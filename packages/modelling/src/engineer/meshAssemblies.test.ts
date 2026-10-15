import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssemblyKind, DETAIL_BUDGETS, ProcModel, type Assembly } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { readGlb } from '../glb';
import { FIXTURE_MODELS, component, flareModel, stackModel } from './fixtures';
import { DEFAULT_MATERIALS, resolveMaterials } from './materials';
import { BUILDERS, buildEngineeringGlb, componentExtras, meshAssemblies } from './meshAssemblies';
import { must } from './testGeom';

interface JsonNode {
  name: string;
  extras?: Record<string, unknown>;
  mesh?: number;
  translation?: number[];
  children?: number[];
}
interface JsonMaterial {
  name: string;
  emissiveFactor?: number[];
  doubleSided?: boolean;
}

const json = (glb: Uint8Array) => {
  const j = readGlb(glb).json;
  return {
    nodes: j.nodes as JsonNode[],
    meshes: (j.meshes ?? []) as { primitives: { material: number }[] }[],
    materials: (j.materials ?? []) as JsonMaterial[],
    accessors: (j.accessors ?? []) as { min?: number[]; max?: number[] }[],
  };
};
const node = (glb: Uint8Array, name: string) =>
  must(
    json(glb).nodes.find((n) => n.name === name),
    `node ${name}`,
  );
const all = () => true;

describe('buildEngineeringGlb', () => {
  it('one node per assembly named by id, child primitives per material, extras carry the record', () => {
    const { glb } = buildEngineeringGlb(stackModel(), {
      detail: 'fast',
      drafts: true,
      generator: 't',
    });
    const j = json(glb);
    const flue = node(glb, 'flue-2');
    expect(flue.extras).toMatchObject({
      component: 'flue-2',
      name: 'flue 2',
      category: 'Flues',
      part: 'flue-2',
      parent: 'shaft-1',
    });
    expect(typeof flue.extras?.basis).toBe('string');
    expect(must(j.meshes[must(flue.mesh)]).primitives.length).toBeGreaterThanOrEqual(1);
    // a warning light is one node with bracket, housing and lens primitives
    const light = node(glb, 'light-l1-1');
    const mats = must(j.meshes[must(light.mesh)]).primitives.map(
      (p) => must(j.materials[p.material]).name,
    );
    expect(mats.sort()).toEqual(['lamp-housing', 'lamp-lens-red', 'steel-galv']);
    // every assembly has exactly one node, all under the model's root node
    const ids = stackModel().assemblies.map((a) => a.id);
    expect(
      j.nodes
        .filter((n) => ids.includes(n.name))
        .map((n) => n.name)
        .sort(),
    ).toEqual([...ids].sort());
    const root = must(j.nodes.find((n) => n.name === 'stack-test'));
    expect(root.children?.length).toBe(ids.length);
  });

  it('the shaft node carries tag, type, basis and the quality summary', () => {
    const { glb, nodes } = buildEngineeringGlb(stackModel(), {
      detail: 'fast',
      drafts: true,
      generator: 't',
    });
    expect(node(glb, 'shaft-1').extras).toEqual({
      component: 'shaft-1',
      name: 'shaft 1',
      description: 'Shaft component shaft-1',
      category: 'Shaft',
      kind: 'shaft',
      status: 'accepted',
      tag: 'STK-1',
      type: 'chimney',
      part: 'shaft-1',
      basis: 'measured',
      unobserved: ['interior'],
      quality: {
        params: { base: 'measured', profile: 'measured', wall: 'inferred', openTop: 'observed' },
        residualM: 0.035,
        coverage: 0.75,
      },
      openings: [{ centre: [0, 120, 0], normal: [0, 1, 0], r: 6 }],
    });
    expect(nodes).toContainEqual({ node: 'shaft-1', tag: 'STK-1' });
    expect(nodes).toContainEqual({ node: 'flue-1' });
  });

  it('lens material is emissive and doubleSided materials are flagged', () => {
    const { glb } = buildEngineeringGlb(flareModel(), {
      detail: 'fast',
      drafts: true,
      generator: 't',
    });
    const mats = json(glb).materials;
    expect(must(mats.find((m) => m.name === 'lamp-lens-red')).emissiveFactor).toEqual([
      1, 0.05, 0.02,
    ]);
    expect(must(mats.find((m) => m.name === 'steel-sheet')).doubleSided).toBe(true);
    expect(must(mats.find((m) => m.name === 'stainless')).doubleSided).toBeUndefined();
    // only the materials in use are written
    expect(mats.map((m) => m.name)).not.toContain('copper');
  });

  it('rejected assemblies are not written; drafts only when drafts: true', () => {
    const m = stackModel();
    const withRejected: ProcModel = {
      ...m,
      assemblies: m.assemblies.map((a) => (a.id === 'flue-3' ? { ...a, status: 'rejected' } : a)),
    };
    const names = (drafts: boolean) =>
      json(buildEngineeringGlb(withRejected, { detail: 'fast', drafts, generator: 't' }).glb)
        .nodes.map((n) => n.name)
        .filter((n) => n !== 'stack-test');
    expect(names(true)).toContain('flue-2');
    expect(names(true)).not.toContain('flue-3');
    // only the shaft is accepted in the fixture
    expect(names(false)).toEqual(['shaft-1']);
  });

  it('vertex positions are relative to the node translation (precision far from origin)', () => {
    const base: [number, number, number] = [100000, 0, -200000];
    const { glb } = buildEngineeringGlb(stackModel({ base }), {
      detail: 'fast',
      drafts: true,
      generator: 't',
    });
    const j = json(glb);
    const extent = Math.max(
      ...j.accessors.flatMap((a) => [...(a.min ?? []), ...(a.max ?? [])].map(Math.abs)),
    );
    expect(extent).toBeLessThan(200);
    expect(node(glb, 'shaft-1').translation).toEqual(base);
    // a guardrail has no base param: its node sits where its mesh is, far from the origin too
    const rail = must(node(glb, 'guardrail-1').translation);
    expect(Math.hypot(must(rail[0]) - base[0], must(rail[2]) - base[2])).toBeLessThan(10);
  });

  it('three.js GLTFLoader loads it and exposes userData.component', async () => {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const { glb } = buildEngineeringGlb(stackModel(), {
      detail: 'fast',
      drafts: true,
      generator: 't',
    });
    const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, '');
    const flue = must(gltf.scene.getObjectByName('flue-2'));
    expect(flue.userData).toMatchObject({ component: 'flue-2', category: 'Flues' });
    const light = must(gltf.scene.getObjectByName('light-l2-3'));
    // a multi-material node loads as a group with one mesh per primitive
    expect(light.children.length).toBe(3);
  });

  it('merges /1 parts of a mixed model as extra nodes with a class material', () => {
    const m = stackModel();
    const mixed: ProcModel = {
      ...m,
      parts: [
        {
          kind: 'cylinder',
          id: 'c1',
          tag: 'T-101',
          class: 'tank',
          status: 'accepted',
          origin: { by: 'manual' },
          base: [30, 0, 0],
          radius: 3,
          height: 5,
        },
        {
          kind: 'box',
          id: 'shaft-1',
          status: 'draft',
          origin: { by: 'manual' },
          base: [40, 0, 0],
          size: [2, 2, 2],
        },
      ],
    };
    const built = buildEngineeringGlb(mixed, { detail: 'fast', drafts: true, generator: 't' });
    const tank = node(built.glb, 'T-101');
    expect(tank.extras).toEqual({ tag: 'T-101', part: 'c1', type: 'tank' });
    expect(tank.translation).toEqual([30, 0, 0]);
    const j = json(built.glb);
    expect(must(j.materials[must(j.meshes[must(tank.mesh)]?.primitives[0]).material]).name).toBe(
      'part-tank',
    );
    // a part whose name is taken by an assembly id gets its id added
    expect(j.nodes.map((n) => n.name)).toContain('shaft-1_shaft-1');
    expect(built.nodes).toContainEqual({ node: 'T-101', tag: 'T-101' });
  });
});

describe('meshAssemblies', () => {
  it('has a builder for every assembly kind', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual([...AssemblyKind.options].sort());
  });

  it('keeps every component within the detail budget and reports the detail used', () => {
    const r = meshAssemblies(stackModel(), { detail: 'standard', include: all });
    expect(r.detail).toBe('standard');
    expect(r.overBudget).toBe(false);
    expect(r.simplified).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.triangles).toBeLessThanOrEqual(DETAIL_BUDGETS.standard.triangles);
    expect(r.triangles).toBe(r.components.reduce((s, c) => s + c.triangles, 0));
    expect(r.components).toHaveLength(stackModel().assemblies.length);
  });

  it('coarsens the smallest components first when over budget and reports them', () => {
    const m = stackModel();
    const detailed = meshAssemblies(m, { detail: 'detailed', include: all }).triangles;
    const standard = meshAssemblies(m, { detail: 'standard', include: all }).triangles;
    expect(standard).toBeLessThan(detailed);
    const budget = Math.floor((detailed + standard) / 2);
    const r = meshAssemblies(m, { detail: 'detailed', include: all, budget });
    expect(r.overBudget).toBe(false);
    expect(r.triangles).toBeLessThanOrEqual(budget);
    expect(r.detail).toBe('standard');
    expect(r.simplified.length).toBeGreaterThan(0);
    expect(r.simplified.every((s) => s.detail === 'standard')).toBe(true);
    // nothing is dropped
    expect(r.components).toHaveLength(m.assemblies.length);
    // the shaft (the largest thing) is coarsened last, the lights (the smallest) first
    const order = r.simplified.map((s) => s.id);
    const firstLight = order.findIndex((id) => id.startsWith('light-'));
    expect(firstLight).toBeGreaterThanOrEqual(0);
    if (order.includes('shaft-1')) expect(order.indexOf('shaft-1')).toBeGreaterThan(firstLight);
  });

  it('reports over budget at fast without dropping a component', () => {
    const m = stackModel();
    const r = meshAssemblies(m, { detail: 'detailed', include: all, budget: 1000 });
    expect(r.overBudget).toBe(true);
    expect(r.detail).toBe('fast');
    expect(r.components).toHaveLength(m.assemblies.length);
    expect(r.simplified).toHaveLength(m.assemblies.length);
  });

  it('records a component whose geometry fails instead of dropping it silently', () => {
    const m = stackModel();
    const broken: ProcModel = {
      ...m,
      assemblies: [
        ...m.assemblies,
        component('band', 'band-9', 'Bands', {
          shaft: 'no-such-shaft',
          y0: 1,
          y1: 2,
          material: 'paint-red',
        }),
      ],
    };
    const r = meshAssemblies(broken, { detail: 'fast', include: all });
    expect(r.failed.map((f) => f.id)).toEqual(['band-9']);
    expect(r.failed[0]?.reason).toMatch(/no-such-shaft/);
    expect(r.components.map((c) => c.id)).not.toContain('band-9');
  });

  it('anchors a component at its base param and makes positions relative to it', () => {
    const r = meshAssemblies(stackModel({ base: [500, 10, -800] }), {
      detail: 'fast',
      include: (a) => a.id === 'shaft-1',
    });
    const shaft = must(r.components[0]);
    expect(shaft.anchor).toEqual([500, 10, -800]);
    const ys = shaft.prims.flatMap((p) => p.positions.filter((_, i) => i % 3 === 1));
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(120, 9);
    expect(shaft.openings).toEqual([{ centre: [500, 130, -800], normal: [0, 1, 0], r: 6 }]);
  });
});

describe('componentExtras', () => {
  const base = must(stackModel().assemblies.find((a) => a.id === 'flue-1'));
  const withQuality = (quality: Assembly['quality']): Assembly => ({ ...base, quality });

  it('basis is the most common, ties go to the weaker basis so the label never overstates', () => {
    expect(componentExtras(withQuality({})).basis).toBe('inferred');
    expect(
      componentExtras(
        withQuality({
          centre: { basis: 'measured' },
          rOuter: { basis: 'measured' },
          height: { basis: 'observed' },
        }),
      ).basis,
    ).toBe('measured');
    expect(
      componentExtras(withQuality({ centre: { basis: 'measured' }, height: { basis: 'observed' } }))
        .basis,
    ).toBe('observed');
    expect(
      componentExtras(withQuality({ centre: { basis: 'observed' }, height: { basis: 'inferred' } }))
        .basis,
    ).toBe('inferred');
  });

  it('summarises quality to the basis per parameter, worst residual and least coverage', () => {
    const e = componentExtras(
      withQuality({
        centre: { basis: 'measured', residualM: 0.01, coverage: 0.9 },
        rOuter: { basis: 'measured', residualM: 0.04, coverage: 0.6 },
        height: { basis: 'user' },
      }),
    );
    expect(e.quality).toEqual({
      params: { centre: 'measured', rOuter: 'measured', height: 'user' },
      residualM: 0.04,
      coverage: 0.6,
    });
    expect(componentExtras(withQuality({})).quality).toEqual({ params: {} });
  });
});

describe('fixtures and materials', () => {
  const fixtures = Object.entries(FIXTURE_MODELS);

  it('the fixtures are valid procmodel/2 files and use every assembly kind', () => {
    const kinds = new Set<string>();
    for (const [name, make] of fixtures) {
      const parsed = ProcModel.safeParse(make());
      expect(parsed.success, `${name}: ${parsed.error?.message ?? ''}`).toBe(true);
      for (const a of make().assemblies) kinds.add(a.kind);
    }
    expect([...kinds].sort()).toEqual([...AssemblyKind.options].sort());
  });

  it('every material a builder emits resolves in DEFAULT_MATERIALS', () => {
    const known = new Set(DEFAULT_MATERIALS.map((m) => m.id));
    const used = new Set<string>();
    for (const [, make] of fixtures)
      for (const detail of ['fast', 'detailed'] as const) {
        const r = meshAssemblies(make(), { detail, include: all });
        expect(r.failed).toEqual([]);
        for (const c of r.components) for (const p of c.prims) used.add(p.material);
      }
    expect([...used].filter((id) => !known.has(id))).toEqual([]);
    // and every literal id in the builder sources (defaults and fixed ids such as the lens)
    const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'builders');
    const fixed = /(?:sink\.\w+\(\s*|const \w+ = )'([a-z][a-z0-9-]*)'/g;
    const fallback = /ctx\.material\(\s*[^,]+,\s*([^)]*)\)/g;
    const inSources = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.includes('test'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(fixed)) inSources.add(must(m[1]));
      // the fallback argument, `'a'` or `cond === 'x' ? 'a' : 'b'`: every literal not compared
      for (const m of src.matchAll(fallback))
        for (const lit of must(m[1]).matchAll(/(===\s*)?'([a-z][a-z0-9-]*)'/g))
          if (lit[1] === undefined) inSources.add(must(lit[2]));
    }
    expect(inSources).toContain('paint-white');
    expect(inSources).toContain('cabinet-grey');
    expect(inSources).toContain('lamp-lens-red');
    expect(inSources.size).toBeGreaterThan(8);
    expect([...inSources].filter((id) => !known.has(id))).toEqual([]);
  });

  it('a model material overrides the default of the same id', () => {
    const own = { ...must(DEFAULT_MATERIALS[0]), name: 'Own cream' };
    const extra = {
      ...own,
      id: 'own-green',
      baseColor: [0, 1, 0, 1] as [number, number, number, number],
    };
    const r = resolveMaterials({ materials: [own, extra] });
    expect(r).toHaveLength(DEFAULT_MATERIALS.length + 1);
    expect(r.find((m) => m.id === own.id)?.name).toBe('Own cream');
    expect(r.at(-1)?.id).toBe('own-green');
  });
});
