import { ProcModel, type EvidencePack, type ModelFamily } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { profileRadiusAt } from '../builders/ctx';
import { FLARE_TRUTH, flareEvidence, flareProposal, openingsOf, setupFor } from '../fixtures';
import { buildEngineeringGlb } from '../meshAssemblies';
import { khronos } from '../testKhronos';
import { validateGlb } from '../validate';
import { assemble, type AssembleInput } from './assemble';
import { SERVICE_LINE_OFFSET } from './flare';
import { base as stackBase, byKind, must, radiusAt } from './testAssemble';

const base = (family: ModelFamily): AssembleInput => ({
  ...stackBase,
  modelId: `${family}-a`,
  family,
  setup: setupFor(family),
});

const CHIMNEY_ONLY = ['flue', 'band', 'deck'];

/** Builds the model's GLB and checks it with the Khronos validator and the closure checks. */
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

/** The flare evidence with four lattice legs round the riser at the ground. */
function derrickEvidence(): EvidencePack {
  const e = flareEvidence();
  return {
    ...e,
    members: [
      ...e.members,
      {
        kind: 'leg',
        items: [
          [2, 2],
          [2, -2],
          [-2, -2],
          [-2, 2],
        ].map(([x = 0, z = 0]) => ({ centre: [x, 0, z], size: 0.15, support: 200 })),
        metrics: { residualM: 0.02 },
      },
    ],
  };
}

describe('flare family', () => {
  it('flare builds a riser shaft, a flare tip, platforms and service lines, no flues or bands', () => {
    const m = assemble({
      ...base('flare'),
      evidence: flareEvidence(),
      proposal: flareProposal(),
    }).model;
    const kinds = new Set(m.assemblies.map((a) => a.kind));
    expect(kinds.has('flareTip')).toBe(true);
    expect(kinds.has('ringPlatform')).toBe(true);
    expect(kinds.has('pipeRun')).toBe(true);
    expect(kinds.has('flue')).toBe(false);
    expect(kinds.has('band')).toBe(false);
    const names: string[] = [...kinds];
    for (const k of CHIMNEY_ONLY) expect(names).not.toContain(k);
    expect(byKind(m, 'shaft')).toHaveLength(1);
    expect(byKind(m, 'ladder')).toHaveLength(1);
    expect(ProcModel.safeParse(m).success).toBe(true);
  });

  it('measures the riser taper, puts the tip on top and the platform at the measured height', () => {
    const m = assemble({
      ...base('flare'),
      evidence: flareEvidence(),
      proposal: flareProposal(),
    }).model;
    const shaft = must(byKind(m, 'shaft')[0]);
    expect(shaft.quality.profile?.basis).toBe('measured');
    expect(must(shaft.params.profile[0]).r).toBeCloseTo(must(FLARE_TRUTH.profile[0]).r, 1);
    expect(shaft.params.openTop).toBe(false);
    const tip = must(byKind(m, 'flareTip')[0]);
    expect(tip.parent).toBe(shaft.id);
    expect(tip.params.base[1]).toBeCloseTo(FLARE_TRUTH.height, 6);
    expect(tip.params.r).toBeCloseTo(FLARE_TRUTH.tipR, 6);
    expect(tip.params.height).toBeCloseTo(FLARE_TRUTH.tipHeight, 6);
    expect(tip.params.pilots).toBe(FLARE_TRUTH.pilots);
    expect(tip.params.windshield).toBe(true);
    expect(tip.quality.r?.basis).toBe('observed');
    const platform = must(byKind(m, 'ringPlatform')[0]);
    expect(platform.params.y).toBeCloseTo(must(FLARE_TRUTH.platformLevels[0]), 6);
    expect(platform.quality.y?.basis).toBe('measured');
    expect(platform.params.rOuter).toBeCloseTo(2.4, 6);
    expect(platform.quality.rOuter?.basis).toBe('measured');
    expect(platform.params.rInner).toBeGreaterThan(radiusAt(m, platform.params.y));
    expect(platform.params.shaft).toBe(shaft.id);
    const rail = must(byKind(m, 'guardrail')[0]);
    expect(rail.parent).toBe(platform.id);
  });

  it('runs the service line up the riser from the ground to the tip, riser radius + 0.4 m out', () => {
    const m = assemble({
      ...base('flare'),
      evidence: flareEvidence(),
      proposal: flareProposal(),
    }).model;
    const pipes = byKind(m, 'pipeRun');
    expect(pipes).toHaveLength(FLARE_TRUTH.serviceLines);
    const pipe = must(pipes[0]);
    const path = pipe.params.path;
    const first = must(path[0]);
    const last = must(path.at(-1));
    expect(first[1]).toBeLessThan(1);
    expect(last[1]).toBeCloseTo(FLARE_TRUTH.height, 6);
    expect(pipe.params.diameter).toBeCloseTo(0.15, 6);
    const shaft = must(byKind(m, 'shaft')[0]);
    // every point up the riser stands the radius there plus the offset off the axis, to the west
    for (const p of path.slice(1)) {
      const r = profileRadiusAt(shaft.params.profile, p[1] - shaft.params.base[1]);
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(r + SERVICE_LINE_OFFSET, 6);
      expect(p[0]).toBeLessThan(0);
    }
    expect(pipe.parent).toBe(shaft.id);
  });

  it('invents nothing unevidenced: no ladder or service line without a proposal; the tip is noted', () => {
    const r = assemble({ ...base('flare'), evidence: flareEvidence(), proposal: null });
    const kinds = new Set(r.model.assemblies.map((a) => a.kind));
    expect(kinds.has('ladder')).toBe(false);
    expect(kinds.has('pipeRun')).toBe(false);
    expect(kinds.has('warningLight')).toBe(false);
    // the platform member is evidence: it stays, measured
    expect(must(byKind(r.model, 'ringPlatform')[0]).quality.y?.basis).toBe('measured');
    const tip = must(byKind(r.model, 'flareTip')[0]);
    expect(Object.values(tip.quality).every((q) => q.basis === 'inferred')).toBe(true);
    expect(r.unresolved.some((u) => u.includes('No flare tip was seen'))).toBe(true);
    expect(ProcModel.safeParse(r.model).success).toBe(true);
  });

  it('a person can add a service line the photos did not show', () => {
    const r = assemble({
      ...base('flare'),
      evidence: flareEvidence(),
      proposal: null,
      user: { ...stackBase.user, counts: { pipe: 2 } },
    });
    expect(byKind(r.model, 'pipeRun')).toHaveLength(2);
  });

  it('leg members make a derrick: a lattice round the riser, the riser not sized from its slices', () => {
    const r = assemble({
      ...base('flare'),
      evidence: derrickEvidence(),
      proposal: flareProposal(),
    });
    const lattice = must(byKind(r.model, 'lattice')[0]);
    const shaft = must(byKind(r.model, 'shaft')[0]);
    expect(lattice.parent).toBe(shaft.id);
    expect(lattice.params.legs).toBe(4);
    expect(lattice.params.widthBase).toBeCloseTo(4, 6);
    expect(lattice.quality.legs?.basis).toBe('measured');
    // the slices measure the lattice now: the riser radii are the AI's
    expect(shaft.quality.profile?.basis).toBe('observed');
    expect(ProcModel.safeParse(r.model).success).toBe(true);
  });

  it('a guyed support says so: the guy wires are listed as unresolved', () => {
    const p = flareProposal();
    const r = assemble({
      ...base('flare'),
      evidence: flareEvidence(),
      proposal: {
        ...p,
        components: p.components.map((c) =>
          c.kind === 'shaft' ? { ...c, params: { ...c.params, support: 'guyed' } } : c,
        ),
      },
    });
    expect(byKind(r.model, 'lattice')).toHaveLength(1);
    expect(must(byKind(r.model, 'lattice')[0]).name).toBe('Guyed mast');
    expect(r.unresolved.some((u) => u.includes('guy wires'))).toBe(true);
  });

  it('the flare model passes validateGlb with its openings and closure', async () => {
    const m = assemble({
      ...base('flare'),
      evidence: flareEvidence(),
      proposal: flareProposal(),
    }).model;
    await expectValidGlb(m);
    const derrick = assemble({
      ...base('flare'),
      evidence: derrickEvidence(),
      proposal: flareProposal(),
    }).model;
    await expectValidGlb(derrick);
  });
});
