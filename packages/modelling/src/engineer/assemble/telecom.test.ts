import {
  ProcModel,
  type EngineerProposal,
  type EvidencePack,
  type ModelFamily,
  type ProposalComponent,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { ctxFor, profileRadiusAt } from '../builders/ctx';
import { MeshSink, SEGMENTS } from '../geom';
import { buildAssembly } from '../meshAssemblies';
import { vertexAt } from '../testGeom';
import {
  LATTICE_TRUTH,
  MONOPOLE_TRUTH,
  latticeEvidence,
  latticeProposal,
  monopoleEvidence,
  monopoleProposal,
  openingsOf,
  setupFor,
} from '../fixtures';
import { buildEngineeringGlb } from '../meshAssemblies';
import { khronos } from '../testKhronos';
import { validateGlb } from '../validate';
import { assemble, type AssembleInput } from './assemble';
import { clusterBearings, meanBearing, outlineReach } from './telecom';
import { base as stackBase, byId, byKind, must, noUser } from './testAssemble';

const base = (family: ModelFamily): AssembleInput => ({
  ...stackBase,
  modelId: `${family}-a`,
  family,
  setup: setupFor(family),
});

const CHIMNEY_ONLY = ['shaft', 'flue', 'band', 'deck', 'flareTip'];

const dir = (az: number) => {
  const t = (az * Math.PI) / 180;
  return [Math.sin(t), -Math.cos(t)] as const;
};

/** The proposal with `extra` components added. */
const plus = (p: EngineerProposal, ...extra: ProposalComponent[]): EngineerProposal => ({
  ...p,
  components: [...p.components, ...extra],
});
const seen = (
  c: Omit<ProposalComponent, 'imageIds' | 'observed' | 'units'>,
): ProposalComponent => ({ units: 'ratio', imageIds: ['img-side-1'], observed: true, ...c });

async function expectValidGlb(model: ProcModel) {
  const built = buildEngineeringGlb(model, { detail: 'standard', drafts: true, generator: 't' });
  expect(built.failed).toEqual([]);
  const r = await validateGlb(built.glb, {
    budget: 400_000,
    openings: openingsOf(model),
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
  expect(r.triangles).toBeGreaterThan(0);
}

const lattice = (o: Partial<AssembleInput> = {}) =>
  assemble({
    ...base('telecom-lattice'),
    evidence: latticeEvidence(),
    proposal: latticeProposal(),
    ...o,
  });
const monopole = (o: Partial<AssembleInput> = {}) =>
  assemble({
    ...base('telecom-monopole'),
    evidence: monopoleEvidence(),
    proposal: monopoleProposal(),
    ...o,
  });

describe('telecom helpers', () => {
  it('clusters bearings across north and splits sectors at wide gaps', () => {
    expect(clusterBearings([350, 10, 120, 125, 240])).toEqual([[0, 1], [2, 3], [4]].map((g) => g));
    expect(clusterBearings([0, 0, 0])).toEqual([[0, 1, 2]]);
    expect(clusterBearings([])).toEqual([]);
    expect(meanBearing([350, 10])).toBeCloseTo(0, 6);
    expect(meanBearing([80, 100])).toBeCloseTo(90, 6);
  });

  it('reaches a square outline at its face, wherever the ray meets it', () => {
    const sq = [
      [1, 0, 1],
      [-1, 0, 1],
      [-1, 0, -1],
      [1, 0, -1],
    ] as [number, number, number][];
    expect(outlineReach(sq, [0, 0, 0], 0)).toBeCloseTo(1, 9);
    expect(outlineReach(sq, [0, 0, 0], 45)).toBeCloseTo(Math.SQRT2, 9);
    expect(outlineReach(sq, [0, 0, 0], 120)).toBeCloseTo(1 / Math.sin(Math.PI / 3), 9);
  });
});

describe('telecom lattice family', () => {
  it('lattice builds legs and bracing as one lattice assembly plus separate antennas and mounts', () => {
    const m = lattice().model;
    expect(byKind(m, 'lattice')).toHaveLength(1);
    expect(byKind(m, 'shaft')).toHaveLength(0);
    expect(byKind(m, 'antenna').map((a) => a.id)).toEqual([
      'antenna-s1-1',
      'antenna-s1-2',
      'antenna-s2-1',
      'antenna-s2-2',
      'antenna-s3-1',
      'antenna-s3-2',
    ]);
    expect(must(byKind(m, 'lattice')[0]).params.legs).toBe(LATTICE_TRUTH.legs);
    expect(byKind(m, 'antennaMount').map((a) => a.id)).toEqual([
      'mount-s1-1',
      'mount-s1-2',
      'mount-s2-1',
      'mount-s2-2',
      'mount-s3-1',
      'mount-s3-2',
    ]);
    expect(ProcModel.safeParse(m).success).toBe(true);
  });

  it('measures the legs, widths and section; bays are the proposal count of X bracing', () => {
    const m = lattice().model;
    const l = must(byKind(m, 'lattice')[0]);
    expect(l.params.widthBase).toBeCloseTo(LATTICE_TRUTH.widthBase, 6);
    expect(l.params.widthTop).toBeCloseTo(LATTICE_TRUTH.widthTop, 1);
    expect(l.params.height).toBeCloseTo(LATTICE_TRUTH.height, 6);
    expect(l.quality.legs?.basis).toBe('measured');
    expect(l.quality.widthBase?.basis).toBe('measured');
    expect(l.quality.widthTop?.basis).toBe('measured');
    expect(l.params.legSection).toBeCloseTo(0.2, 6);
    expect(l.params.bays).toHaveLength(LATTICE_TRUTH.bays);
    expect(l.params.bays.every((b) => b.bracing === 'X')).toBe(true);
    const total = l.params.bays.reduce((s, b) => s + b.height, 0);
    expect(total).toBeCloseTo(l.params.height, 6);
  });

  it('without a bay count the bays are evenly 4 to 6 m', () => {
    const p = latticeProposal();
    const m = lattice({
      proposal: {
        ...p,
        components: p.components.map((c) =>
          c.kind === 'lattice' ? { ...c, params: { legs: 4 } } : c,
        ),
      },
    }).model;
    const bays = must(byKind(m, 'lattice')[0]).params.bays;
    for (const b of bays) {
      expect(b.height).toBeGreaterThanOrEqual(4);
      expect(b.height).toBeLessThanOrEqual(6);
    }
  });

  it('antennas are numbered clockwise from north by sector, face their sector, sit on their mounts', () => {
    const m = lattice().model;
    const l = must(byKind(m, 'lattice')[0]);
    const facings = byKind(m, 'antenna').map((a) => Math.round(a.params.azimuthDeg));
    expect(facings).toEqual([0, 0, 120, 120, 240, 240]);
    for (const a of byKind(m, 'antenna')) {
      expect(a.quality.centre?.basis).toBe('measured');
      const mount = byId(m, a.parent ?? '');
      expect(mount.kind).toBe('antennaMount');
      expect(mount.parent).toBe(l.id);
    }
    // within a sector the first clockwise from north comes first
    const s1 = byKind(m, 'antenna').filter((a) => a.id.startsWith('antenna-s1-'));
    const x = s1.map((a) => a.params.centre[0]);
    expect(must(x[0])).toBeGreaterThan(0);
    expect(must(x[1])).toBeLessThan(0);
  });

  it('antennas sit on mounts at the pole or leg radius at their height', () => {
    // lattice: a mount's arms end 5 cm inside the face (plus half a leg) at the antenna height
    const m = lattice().model;
    const l = must(byKind(m, 'lattice')[0]).params;
    for (const mount of byKind(m, 'antennaMount')) {
      const p = mount.params;
      const [fx, fz] = dir(p.azimuthDeg);
      const back = [p.centre[0] - fx * p.size[2], p.centre[2] - fz * p.size[2]] as const;
      const w = l.widthBase + ((l.widthTop - l.widthBase) * (p.centre[1] - l.base[1])) / l.height;
      // a square lattice's face is w / 2 from the axis: along the bearing, (w / 2) / max(|sin|, |cos|)
      const face = w / 2 / Math.max(Math.abs(fx), Math.abs(fz));
      expect(back[0] * fx + back[1] * fz).toBeCloseTo(face + l.legSection / 2 - 0.05, 6);
      const ant = must(byKind(m, 'antenna').find((a) => a.parent === mount.id));
      // the antenna's back touches the mount pipe
      const behind = [
        ant.params.centre[0] - fx * (ant.params.size[2] / 2),
        ant.params.centre[2] - fz * (ant.params.size[2] / 2),
      ];
      const gap = Math.hypot(must(behind[0]) - p.centre[0], must(behind[1]) - p.centre[2]);
      expect(gap).toBeLessThanOrEqual(p.size[0] / 2);
      expect(ant.params.centre[1]).toBeCloseTo(p.centre[1], 6);
    }
    // monopole: the arms end 5 cm inside the pole surface at the antenna height
    const mm = monopole().model;
    const pole = must(byKind(mm, 'monopole')[0]).params;
    const mount = must(byKind(mm, 'antennaMount')[0]).params;
    const [fx, fz] = dir(mount.azimuthDeg);
    const back = Math.hypot(
      mount.centre[0] - fx * mount.size[2] - pole.base[0],
      mount.centre[2] - fz * mount.size[2] - pole.base[2],
    );
    const r = profileRadiusAt(pole.profile, mount.centre[1] - pole.base[1]);
    expect(back).toBeCloseTo(r - 0.05, 6);
    expect(r).toBeCloseTo(
      must(MONOPOLE_TRUTH.profile[0]).r +
        ((must(MONOPOLE_TRUTH.profile[1]).r - must(MONOPOLE_TRUTH.profile[0]).r) *
          MONOPOLE_TRUTH.antennaY) /
          MONOPOLE_TRUTH.height,
      1,
    );
  });

  it('keeps sector numbers when a sector is no longer seen (no renumbering)', () => {
    const first = lattice().model;
    const ev = latticeEvidence();
    const partial: EvidencePack = {
      ...ev,
      members: ev.members.map((g) =>
        g.kind === 'antenna-candidate'
          ? { ...g, items: g.items.filter((it) => it.azimuthDeg !== 0) }
          : g,
      ),
    };
    const r = lattice({
      evidence: partial,
      previous: first,
      user: { ...noUser(), counts: { antenna: 4 } },
    });
    expect(byKind(r.model, 'antenna').map((a) => a.id)).toEqual([
      'antenna-s2-1',
      'antenna-s2-2',
      'antenna-s3-1',
      'antenna-s3-2',
    ]);
    expect(r.kept).toEqual(expect.arrayContaining(['antenna-s2-1', 'mount-s3-2']));
    expect(r.changed).toEqual(expect.arrayContaining(['antenna-s1-1', 'mount-s1-2']));
  });

  it('without antenna evidence the proposal count is spread over its sectors from north, inferred', () => {
    const r = lattice({ evidence: null });
    const ants = byKind(r.model, 'antenna');
    expect(ants.map((a) => a.id)).toEqual([
      'antenna-s1-1',
      'antenna-s1-2',
      'antenna-s2-1',
      'antenna-s2-2',
      'antenna-s3-1',
      'antenna-s3-2',
    ]);
    expect(ants.map((a) => a.params.azimuthDeg)).toEqual([0, 0, 120, 120, 240, 240]);
    expect(ants.every((a) => a.quality.centre?.basis === 'inferred')).toBe(true);
    expect(r.unresolved.some((u) => u.includes('bearings of the antennas are not known'))).toBe(
      true,
    );
    expect(ProcModel.safeParse(r.model).success).toBe(true);
  });

  it('lights on a lattice stand off the face at their height by their size, counted as on a chimney', () => {
    const r = lattice({
      proposal: plus(
        latticeProposal(),
        seen({
          role: 'light',
          kind: 'warningLight',
          count: 2,
          params: { fixture: 'single' },
          levels: [0.5],
        }),
      ),
    });
    const lights = byKind(r.model, 'warningLight');
    expect(lights.map((a) => a.id)).toEqual(['light-l1-1', 'light-l1-2']);
    const l = must(byKind(r.model, 'lattice')[0]).params;
    const north = must(lights.find((a) => a.params.outward[2] < -0.99));
    const y = north.params.centre[1];
    expect(y).toBeCloseTo(LATTICE_TRUTH.height / 2, 6);
    const w = l.widthBase + ((l.widthTop - l.widthBase) * y) / l.height;
    expect(-north.params.centre[2]).toBeCloseTo(w / 2 + l.legSection / 2 + north.params.size, 1);
    expect(north.parent).toBe('lattice-1');
    expect(r.unresolved.some((u) => u.includes('bearings of the lights'))).toBe(true);
    // the person's count wins, as on a chimney
    const three = lattice({
      proposal: plus(
        latticeProposal(),
        seen({ role: 'light', kind: 'warningLight', count: 2, params: {}, levels: [0.5] }),
      ),
      user: { ...noUser(), counts: { 'light-l1': 3 } },
    });
    expect(byKind(three.model, 'warningLight')).toHaveLength(3);
  });

  it('has no chimney parts, and places proposed ladders, platforms and cabinets clear of the antennas', () => {
    const r = lattice({
      proposal: plus(
        latticeProposal(),
        seen({ role: 'ladder', kind: 'ladder', count: 1, params: { cage: true } }),
        seen({
          role: 'platform',
          kind: 'ringPlatform',
          count: 1,
          params: { guardrail: true },
          levels: [0.9],
        }),
      ),
    });
    const names: string[] = r.model.assemblies.map((a) => a.kind);
    for (const k of CHIMNEY_ONLY.filter((k) => k !== 'deck')) expect(names).not.toContain(k);
    // the platform is a plate round the tower (a ring platform rings a shaft): its one opening is
    // the tower's passage on the axis, never a flue opening
    const deck = must(byKind(r.model, 'deck')[0]);
    expect(deck.category).toBe('Access');
    expect(deck.params.openings).toHaveLength(1);
    expect(must(deck.params.openings[0]).centre).toEqual([0, 0]);
    expect(must(deck.params.openings[0]).r).toBeGreaterThan(
      (LATTICE_TRUTH.widthTop / 2) * Math.SQRT2,
    );
    expect(deck.params.y).toBeCloseTo(0.9 * LATTICE_TRUTH.height, 6);
    expect(byKind(r.model, 'ladder')).toHaveLength(1);
    expect(byKind(r.model, 'cabinet')).toHaveLength(1);
    const ladder = must(byKind(r.model, 'ladder')[0]);
    // the ladder climbs a face no antenna faces
    const az = (Math.atan2(ladder.params.bottom[0], -ladder.params.bottom[2]) * 180) / Math.PI;
    for (const s of LATTICE_TRUTH.sectors)
      expect(Math.abs(((az - s + 540) % 360) - 180)).toBeGreaterThan(30);
    expect(byKind(r.model, 'guardrail')).toHaveLength(1);
    expect(ProcModel.safeParse(r.model).success).toBe(true);
  });
});

describe('tower access placement', () => {
  type P = [number, number, number];
  const anchored = (family: ModelFamily, B: P): AssembleInput => ({
    ...base(family),
    evidence: null,
    setup: { ...setupFor(family), placement: 'anchor', anchor: B },
  });
  const ladderProp = seen({ role: 'ladder', kind: 'ladder', count: 1, params: { cage: true } });
  /** Compass bearing the built ladder's cage stands out to, square to the ladder line. */
  function cageBearing(model: ProcModel, B: P): { az: number; bearing: number } {
    const l = must(byKind(model, 'ladder')[0]);
    const sink = new MeshSink(SEGMENTS.standard);
    buildAssembly(sink, l, ctxFor(model));
    const cage = must(sink.out().find((p) => p.material === 'steel-galv-cage'));
    const n = cage.positions.length / 3;
    const c = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const v = vertexAt(cage, i);
      for (let k = 0; k < 3; k++) c[k] = (c[k] ?? 0) + (v[k] ?? 0) / n;
    }
    const { bottom, top } = l.params;
    const d = [top[0] - bottom[0], top[1] - bottom[1], top[2] - bottom[2]];
    const dl = Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
    const rel = [0, 1, 2].map((k) => (c[k] ?? 0) - (bottom[k] ?? 0));
    const t = rel.reduce((s, r, k) => s + (r * (d[k] ?? 0)) / dl, 0);
    const v = rel.map((r, k) => r - (t * (d[k] ?? 0)) / dl);
    const bearing = (Math.atan2(v[0] ?? 0, -(v[2] ?? 0)) * 180) / Math.PI;
    const az = (Math.atan2(bottom[0] - B[0], -(bottom[2] - B[2])) * 180) / Math.PI;
    return { az, bearing };
  }
  const angle = (a: number, b: number) => {
    const d = Math.abs((((a - b) % 360) + 360) % 360);
    return Math.min(d, 360 - d);
  };

  const ANCHORS: P[] = [
    [50, 0, -30],
    [-40, 0, 25],
  ];
  it.each(
    (['telecom-lattice', 'telecom-monopole'] as const).flatMap((f) =>
      ANCHORS.map((B): [ModelFamily, P] => [f, B]),
    ),
  )('a ladder on an off-origin %s at %j faces out along its bearing', (family, B) => {
    const p = family === 'telecom-lattice' ? latticeProposal() : monopoleProposal();
    const m = assemble({ ...anchored(family, B), proposal: plus(p, ladderProp) }).model;
    const tower = must(m.assemblies.find((a) => a.kind === 'lattice' || a.kind === 'monopole'));
    expect(tower.params.base).toEqual(B);
    const { az, bearing } = cageBearing(m, B);
    expect(angle(az, bearing)).toBeLessThan(1);
  });

  it('a proposed platform inside the antennas moves just below the lowest one, noted', () => {
    const r = lattice({
      proposal: plus(
        latticeProposal(),
        seen({ role: 'platform', kind: 'ringPlatform', count: 1, params: {}, levels: [0.95] }),
      ),
    });
    const deck = must(byKind(r.model, 'deck')[0]);
    const bottoms = [...byKind(r.model, 'antenna'), ...byKind(r.model, 'antennaMount')].map(
      (a) => a.params.centre[1] - a.params.size[1] / 2,
    );
    const lowest = Math.min(...bottoms);
    expect(deck.params.y).toBeLessThan(lowest);
    expect(deck.params.y).toBeGreaterThan(lowest - 0.2);
    expect(deck.quality.y?.basis).toBe('inferred');
    expect(r.unresolved.some((u) => u.includes('moved below the antennas'))).toBe(true);
    // a level clear of the antennas stays where it was proposed, without a note
    const clear = lattice({
      proposal: plus(
        latticeProposal(),
        seen({ role: 'platform', kind: 'ringPlatform', count: 1, params: {}, levels: [0.5] }),
      ),
    });
    expect(must(byKind(clear.model, 'deck')[0]).params.y).toBeCloseTo(20, 6);
    expect(clear.unresolved.some((u) => u.includes('moved below the antennas'))).toBe(false);
  });
});

describe('telecom monopole family', () => {
  it('monopole uses a monopole, never a shaft', () => {
    const r = monopole();
    const m = r.model;
    expect(byKind(m, 'monopole')).toHaveLength(1);
    const names: string[] = m.assemblies.map((a) => a.kind);
    for (const k of CHIMNEY_ONLY) expect(names).not.toContain(k);
    expect(names).not.toContain('lattice');
    const pole = must(byKind(m, 'monopole')[0]);
    expect(pole.params.sides).toBe(MONOPOLE_TRUTH.sides);
    expect(pole.quality.sides?.basis).toBe('observed');
    expect(pole.quality.profile?.basis).toBe('measured');
    expect(must(pole.params.profile[0]).r).toBeCloseTo(must(MONOPOLE_TRUTH.profile[0]).r, 1);
    expect(byKind(m, 'antenna').map((a) => a.id)).toEqual(['antenna-s1-1']);
    expect(byKind(m, 'antennaMount').map((a) => [a.id, a.parent])).toEqual([
      ['mount-s1-1', pole.id],
    ]);
    expect(must(byKind(m, 'antenna')[0]).parent).toBe('mount-s1-1');
    expect(ProcModel.safeParse(m).success).toBe(true);
  });

  it('a monopole without sides from the AI is round', () => {
    const p = monopoleProposal();
    const m = monopole({
      proposal: {
        ...p,
        components: p.components.map((c) =>
          c.kind === 'monopole' ? { ...c, params: { rBase: 0.02, rTop: 0.01 } } : c,
        ),
      },
    }).model;
    expect(must(byKind(m, 'monopole')[0]).params.sides).toBe(0);
  });
});

describe('telecom output', () => {
  it('every family output passes validateGlb', async () => {
    await expectValidGlb(lattice().model);
    await expectValidGlb(monopole().model);
    await expectValidGlb(lattice({ evidence: null }).model);
    const extras = (p: EngineerProposal) =>
      plus(
        p,
        seen({ role: 'ladder', kind: 'ladder', count: 1, params: { cage: true } }),
        seen({
          role: 'platform',
          kind: 'ringPlatform',
          count: 1,
          params: { guardrail: true },
          levels: [0.85],
        }),
        seen({ role: 'light', kind: 'warningLight', count: 2, params: {}, levels: [0.5, 1] }),
      );
    await expectValidGlb(lattice({ proposal: extras(latticeProposal()) }).model);
    await expectValidGlb(monopole({ proposal: extras(monopoleProposal()) }).model);
  });
});
