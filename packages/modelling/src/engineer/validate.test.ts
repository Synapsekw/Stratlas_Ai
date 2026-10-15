import { describe, expect, it } from 'vitest';
import { writeGlbV2, type GlbMaterial, type GlbNodeV2 } from '../glb';
import { FIXTURE_MODELS, openingsOf, stackModel } from './fixtures';
import { MeshSink, SEGMENTS, type Opening, type Prim, type V3 } from './geom';
import { buildEngineeringGlb } from './meshAssemblies';
import { khronos } from './testKhronos';
import { validateGlb, type DeclaredOpening } from './validate';

const MATERIALS: GlbMaterial[] = [
  { name: 'grey', baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 0.8 },
  { name: 'sheet', baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 0.8, doubleSided: true },
];

/** A GLB of one node per entry, built from `MeshSink` primitives (positions as given). */
function glbOf(
  entries: { name: string; prims: Prim[]; material?: number; extras?: Record<string, unknown> }[],
): Uint8Array {
  const nodes: GlbNodeV2[] = entries.map((e) => ({
    name: e.name,
    extras: e.extras ?? {},
    translation: [0, 0, 0],
    primitives: e.prims.map((p) => ({
      material: e.material ?? 0,
      positions: Float32Array.from(p.positions),
      normals: Float32Array.from(p.normals),
      indices: Uint32Array.from(p.indices),
    })),
  }));
  return writeGlbV2(nodes, { root: 'test', generator: 'test', materials: MATERIALS });
}

const sink = () => new MeshSink(SEGMENTS.standard);
function box(): Prim[] {
  const s = sink();
  s.box('grey', { centre: [0, 1, 0], size: [2, 2, 2] });
  return s.out();
}
/**
 * A flue tube 6 m long, open at its mouth (y 10), with its declared opening; `capped` adds a disc
 * over the mouth, `extra` anything else in the same node.
 */
function flue(
  capped: boolean,
  extra: (s: MeshSink) => void = () => undefined,
): { prims: Prim[]; openings: Opening[] } {
  const s = sink();
  s.annulusTube('grey', {
    centre: [0, 10, 0],
    axis: [0, 1, 0],
    rOuter: 1,
    rInner: 0.9,
    y0: -6,
    y1: 0,
    openings: 'top',
  });
  if (capped) s.disc('grey', { centre: [0, 10, 0], normal: [0, 1, 0], r: 1 });
  extra(s);
  const prims = s.out();
  return { prims, openings: prims.flatMap((p) => p.openings ?? []) };
}

/** Validates one flue node with `openings` (default: its own). */
async function checkFlue(f: { prims: Prim[]; openings: Opening[] }, openings?: DeclaredOpening[]) {
  return validateGlb(glbOf([{ name: 'flue-1', prims: f.prims }]), {
    budget: 1e6,
    openings: { 'flue-1': openings ?? f.openings },
    khronos,
  });
}

describe('validateGlb', () => {
  it('a synthetic stack passes the Khronos validator with zero errors', async () => {
    const { glb } = buildEngineeringGlb(stackModel(), {
      detail: 'standard',
      drafts: true,
      generator: 'test',
    });
    const r = await validateGlb(glb, {
      budget: 400_000,
      openings: openingsOf(stackModel()),
      khronos,
    });
    expect(r.messages).toEqual([]);
    expect(r.validatorErrors).toBe(0);
    expect(r.finite && r.indicesValid && r.normalsUnit).toBe(true);
    expect(r.degenerate).toBe(0);
    expect(r.duplicateTris).toBe(0);
    expect(r.unintendedHoles).toEqual([]);
    expect(r.intendedOpenOk).toBe(true);
    expect(r.withinBudget).toBe(true);
    expect(r.triangles).toBeGreaterThan(1000);
  });

  it.each(Object.entries(FIXTURE_MODELS))(
    'the %s fixture passes at every detail, openings read from the file',
    async (_, make) => {
      for (const detail of ['fast', 'standard', 'detailed'] as const) {
        const built = buildEngineeringGlb(make(), { detail, drafts: true, generator: 'test' });
        const r = await validateGlb(built.glb, { budget: built.triangles, khronos });
        expect(r.messages, detail).toEqual([]);
        expect(r.validatorErrors + r.validatorWarnings).toBe(0);
        expect(r.finite && r.indicesValid && r.normalsUnit).toBe(true);
        expect(r.degenerate, detail).toBe(0);
        expect(r.duplicateTris, detail).toBe(0);
        expect(r.unintendedHoles, detail).toEqual([]);
        expect(r.intendedOpenOk, detail).toBe(true);
        expect(r.triangles).toBe(built.triangles);
      }
    },
  );

  it('reports an over-budget model', async () => {
    const { glb } = buildEngineeringGlb(stackModel(), {
      detail: 'detailed',
      drafts: true,
      generator: 'test',
    });
    const r = await validateGlb(glb, { budget: 1000, openings: {}, khronos });
    expect(r.withinBudget).toBe(false);
    expect(r.triangles).toBeGreaterThan(1000);
  });

  it('detects a punched hole as unintended', async () => {
    const whole = box();
    const punched = whole.map((p) => ({ ...p, indices: p.indices.slice(3) }));
    const ok = await validateGlb(glbOf([{ name: 'box-1', prims: whole }]), {
      budget: 1e6,
      khronos,
    });
    expect(ok.unintendedHoles).toEqual([]);
    const r = await validateGlb(
      glbOf([
        { name: 'box-1', prims: whole },
        { name: 'box-2', prims: punched },
      ]),
      { budget: 1e6, khronos },
    );
    expect(r.unintendedHoles).toEqual([{ node: 'box-2', loops: 1 }]);
  });

  it('a single-skin sheet in a doubleSided material is no hole', async () => {
    const s = sink();
    const p = s.prim('sheet');
    const v = (at: V3) => s.vertex(p, at, [0, 0, 1]);
    s.quad(p, v([0, 0, 0]), v([1, 0, 0]), v([1, 1, 0]), v([0, 1, 0]));
    const sheet = await validateGlb(glbOf([{ name: 'sheet-1', prims: s.out(), material: 1 }]), {
      budget: 1e6,
      khronos,
    });
    expect(sheet.unintendedHoles).toEqual([]);
    const grey = await validateGlb(glbOf([{ name: 'sheet-1', prims: s.out(), material: 0 }]), {
      budget: 1e6,
      khronos,
    });
    expect(grey.unintendedHoles).toEqual([{ node: 'sheet-1', loops: 1 }]);
  });

  it('an open flue keeps its mouth open; a capped one is detected', async () => {
    const open = flue(false);
    const capped = flue(true);
    expect(open.openings).toHaveLength(1);
    const ok = await validateGlb(glbOf([{ name: 'flue-1', prims: open.prims }]), {
      budget: 1e6,
      openings: { 'flue-1': open.openings },
      khronos,
    });
    expect(ok.intendedOpenOk).toBe(true);
    expect(ok.unintendedHoles).toEqual([]);
    const bad = await validateGlb(glbOf([{ name: 'flue-1', prims: capped.prims }]), {
      budget: 1e6,
      openings: { 'flue-1': capped.openings },
      khronos,
    });
    expect(bad.intendedOpenOk).toBe(false);
  });

  it('detects a cap or plug off the mouth plane and a partial cap', async () => {
    const disc =
      (y: number, r: number, x = 0) =>
      (s: MeshSink) => {
        s.disc('grey', { centre: [x, y, 0], normal: [0, 1, 0], r });
      };
    const open = await checkFlue(flue(false));
    expect(open.intendedOpenOk).toBe(true);
    expect(open.openingProblems).toEqual([]);
    const below = await checkFlue(flue(false, disc(9.995, 0.9)));
    expect(below.intendedOpenOk).toBe(false);
    // its rim lies 5 mm below the mouth plane, so it is no intended opening either
    expect(below.unintendedHoles).toEqual([{ node: 'flue-1', loops: 1 }]);
    expect((await checkFlue(flue(false, disc(10.005, 1)))).intendedOpenOk).toBe(false);
    // a plug 1 m down: the tube declares its 6 m passage, so it is found; without a declared
    // depth only the default half radius behind the mouth is checked
    const plugged = flue(false, disc(9, 0.9));
    expect(plugged.openings.map((o) => o.depth)).toEqual([6]);
    const shallow = plugged.openings.map((o) => ({ centre: o.centre, normal: o.normal, r: o.r }));
    expect((await checkFlue(plugged, shallow)).intendedOpenOk).toBe(true);
    const r = await checkFlue(plugged);
    expect(r.intendedOpenOk).toBe(false);
    expect(r.openingProblems).toEqual([
      { node: 'flue-1', problem: 'opening 1: the passage behind or in front of it is blocked' },
    ]);
    // a few triangles across part of the mouth
    expect((await checkFlue(flue(false, disc(10, 0.1, 0.3)))).intendedOpenOk).toBe(false);
  });

  it('finds a plug 80 percent down a 10 m flue liner from the depth in the file', async () => {
    const liner = (plug: boolean) => {
      const s = sink();
      s.annulusTube('grey', {
        centre: [0, 50, 0],
        axis: [0, 1, 0],
        rOuter: 0.5,
        rInner: 0.45,
        y0: -10,
        y1: 0,
        openings: 'top',
      });
      if (plug) s.disc('grey', { centre: [0, 42, 0], normal: [0, 1, 0], r: 0.45 });
      const prims = s.out();
      const openings = prims.flatMap((p) => p.openings ?? []);
      expect(openings.map((o) => o.depth)).toEqual([10]);
      return glbOf([{ name: 'liner-1', prims, extras: { openings } }]);
    };
    expect((await validateGlb(liner(false), { budget: 1e6, khronos })).intendedOpenOk).toBe(true);
    const r = await validateGlb(liner(true), { budget: 1e6, khronos });
    expect(r.intendedOpenOk).toBe(false);
    expect(r.openingProblems).toEqual([
      { node: 'liner-1', problem: 'opening 1: the passage behind or in front of it is blocked' },
    ]);
  });

  it('detects a capped annular passage when both bores are declared', async () => {
    const annulus = (capped: boolean) => {
      const s = sink();
      const tube = { centre: [0, 10, 0] as V3, axis: [0, 1, 0] as V3, y0: -6, y1: 0 };
      s.annulusTube('grey', { ...tube, rOuter: 1, rInner: 0.8, openings: 'top' });
      s.annulusTube('grey', { ...tube, rOuter: 0.6, rInner: 0.5, openings: 'top' });
      if (capped)
        s.disc('grey', {
          centre: [0, 10, 0],
          normal: [0, 1, 0],
          r: 0.8,
          holes: [{ c: [0, 0], r: 0.6 }],
          declareHoles: false,
        });
      const prims = s.out();
      return { prims, openings: prims.flatMap((p) => p.openings ?? []) };
    };
    expect((await checkFlue(annulus(true))).intendedOpenOk).toBe(false);
    // declaring only the inner bore (the real passage) of the open pair passes
    const open = annulus(false);
    const inner = open.openings.filter((o) => o.r === 0.5);
    expect(inner).toHaveLength(1);
    expect((await checkFlue(open, inner)).intendedOpenOk).toBe(true);
  });

  it('an opening declared where the mesh has no rim fails', async () => {
    const r = await validateGlb(glbOf([{ name: 'box-1', prims: box() }]), {
      budget: 1e6,
      openings: { 'box-1': [{ centre: [0, 5, 0], normal: [0, 1, 0], r: 0.3 }] },
      khronos,
    });
    expect(r.intendedOpenOk).toBe(false);
    expect(r.openingProblems).toEqual([
      { node: 'box-1', problem: 'opening 1: the mesh has no rim there' },
    ]);
  });

  it('reads the openings from node extras when none are given', async () => {
    const capped = flue(true);
    const r = await validateGlb(
      glbOf([{ name: 'flue-1', prims: capped.prims, extras: { openings: capped.openings } }]),
      { budget: 1e6, khronos },
    );
    expect(r.intendedOpenOk).toBe(false);
  });

  it('checks a rectangular opening against its outline, not its circle', async () => {
    const outline: V3[] = [
      [1, 0, -0.5],
      [1, 0, 0.5],
      [-1, 0, 0.5],
      [-1, 0, -0.5],
    ];
    const opening: Opening = {
      centre: [0, 0, 0],
      normal: [0, 1, 0],
      r: Math.hypot(1, 0.5),
      outline,
    };
    // a frame round the rectangle, its top face in the opening plane: the rim
    const frame = (s: MeshSink) => {
      for (const z of [-0.6, 0.6]) s.box('grey', { centre: [0, -0.05, z], size: [2, 0.1, 0.2] });
      for (const x of [-1.1, 1.1]) s.box('grey', { centre: [x, -0.05, 0], size: [0.2, 0.1, 1] });
    };
    // a bar crossing the plane inside the circle round the outline but outside the rectangle
    const s = sink();
    frame(s);
    s.box('grey', { centre: [0, 0, 0.9], size: [0.1, 1, 0.1] });
    const outside = await validateGlb(glbOf([{ name: 'hatch-1', prims: s.out() }]), {
      budget: 1e6,
      openings: { 'hatch-1': [opening] },
      khronos,
    });
    expect(outside.intendedOpenOk).toBe(true);
    const t = sink();
    frame(t);
    t.box('grey', { centre: [0.5, 0, 0], size: [0.1, 1, 0.1] });
    const inside = await validateGlb(glbOf([{ name: 'hatch-1', prims: t.out() }]), {
      budget: 1e6,
      openings: { 'hatch-1': [opening] },
      khronos,
    });
    expect(inside.intendedOpenOk).toBe(false);
  });

  it('counts degenerate and duplicate triangles', async () => {
    const [p] = box();
    if (!p) throw new Error('no box');
    const dup = { ...p, indices: [...p.indices, ...p.indices.slice(0, 3)] };
    const flat = { ...p, indices: [...p.indices, 0, 1, 1] };
    const r = await validateGlb(
      glbOf([
        { name: 'dup', prims: [dup] },
        { name: 'flat', prims: [flat] },
      ]),
      { budget: 1e6, khronos },
    );
    expect(r.duplicateTris).toBe(1);
    expect(r.degenerate).toBe(1);
  });

  it('flags out-of-range indices and non-finite positions', async () => {
    const [p] = box();
    if (!p) throw new Error('no box');
    const oob = { ...p, indices: [...p.indices, 0, 1, 9999] };
    const r = await validateGlb(glbOf([{ name: 'oob', prims: [oob] }]), { budget: 1e6, khronos });
    expect(r.indicesValid).toBe(false);
    expect(r.validatorErrors).toBeGreaterThan(0);
    expect(r.messages.some((m) => m.includes('ACCESSOR_INDEX_OOB'))).toBe(true);
    const nan = { ...p, positions: [Number.NaN, ...p.positions.slice(1)] };
    const n = await validateGlb(glbOf([{ name: 'nan', prims: [nan] }]), { budget: 1e6, khronos });
    expect(n.finite).toBe(false);
  });
});
