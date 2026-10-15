import { EngineerProposal, EvidencePack, ProcModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { buildEngineeringGlb } from '../meshAssemblies';
import {
  FLARE_TRUTH,
  LATTICE_TRUTH,
  MONOPOLE_TRUTH,
  STACK_TRUTH,
  flareEvidence,
  flareProposal,
  latticeEvidence,
  latticeProposal,
  monopoleEvidence,
  monopoleProposal,
  setupFor,
  stackEvidence,
  stackProposal,
} from '../fixtures';
import { khronos } from '../testKhronos';
import { validateGlb } from '../validate';
import { assemble } from './assemble';
import { base, byKind, must, noUser, radiusAt } from './testAssemble';

const truthR0 = must(STACK_TRUTH.profile[0]).r;

describe('chimney family', () => {
  it('draft from measurements has the measured taper, flue count and both light levels', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence({ partial: true }),
      proposal: stackProposal(),
    });
    const shaft = must(byKind(r.model, 'shaft')[0]);
    expect(must(shaft.params.profile[0]).r).toBeCloseTo(truthR0, 0);
    expect(shaft.quality.profile?.basis).toBe('measured');
    expect(byKind(r.model, 'flue')).toHaveLength(STACK_TRUTH.flues);
    const levels = [
      ...new Set(byKind(r.model, 'warningLight').map((a) => Math.round(a.params.centre[1]))),
    ].sort((a, b) => a - b);
    expect(levels).toEqual(STACK_TRUTH.lightLevels);
    expect(r.model.scale?.status).toBe('measured');
    expect(ProcModel.safeParse(r.model).success).toBe(true);
  });

  it('marks the back of a partly seen shaft unobserved and the guessed lights inferred', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence({ partial: true }),
      proposal: stackProposal(),
    });
    expect(must(byKind(r.model, 'shaft')[0]).unobserved).toContain('back');
    const lights = byKind(r.model, 'warningLight');
    expect(lights.some((l) => l.quality.centre?.basis === 'measured')).toBe(true);
    expect(lights.some((l) => l.quality.centre?.basis === 'inferred')).toBe(true);
    expect(byKind(r.model, 'warningLight')).toHaveLength(
      STACK_TRUTH.lightLevels.length * STACK_TRUTH.lightsPerLevel,
    );
  });

  it('measures profile heights from the shaft base, not from the project datum', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence({ base: [3, 12.5, -4] }),
      proposal: stackProposal(),
    });
    const shaft = must(byKind(r.model, 'shaft')[0]);
    expect(shaft.params.base).toEqual([3, 12.5, -4]);
    expect(must(shaft.params.profile[0]).y).toBe(0);
    expect(must(shaft.params.profile.at(-1)).y).toBeCloseTo(STACK_TRUTH.height, 6);
    const crown = byKind(r.model, 'warningLight').filter((l) => l.id.startsWith('light-crown'));
    for (const l of crown) expect(l.params.centre[1]).toBeCloseTo(12.5 + STACK_TRUTH.height, 6);
  });

  it('is authored geometry, not the input: no assembly carries raw points, all positions come from builders', async () => {
    const model = assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() }).model;
    const { glb, failed } = buildEngineeringGlb(model, {
      detail: 'standard',
      drafts: true,
      generator: 't',
    });
    expect(failed).toEqual([]);
    const r = await validateGlb(glb, { budget: 400_000, openings: {}, khronos });
    expect(r.validatorErrors).toBe(0);
    expect(r.triangles).toBeGreaterThan(0);
    expect(r.triangles).toBeLessThan(stackEvidence().samples.kept); // smaller than the cloud
  });

  it('lights sit on the shaft surface using the taper radius', () => {
    const r = assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() });
    const lights = byKind(r.model, 'warningLight');
    expect(lights.length).toBeGreaterThan(0);
    for (const l of lights) {
      const [x, y, z] = l.params.centre;
      const gap = Math.hypot(x, z) - radiusAt(r.model, y);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(0.6);
    }
  });

  it('takes light azimuths from the evidence (measured) when it sees every light', () => {
    const r = assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() });
    for (const l of byKind(r.model, 'warningLight'))
      expect(l.quality.centre?.basis).toBe('measured');
  });

  it('no measured scale and no reference: scale provisional and nothing labelled measured', () => {
    const r = assemble({ ...base, evidence: null, proposal: stackProposal() });
    expect(r.model.scale?.status).toBe('provisional');
    expect(
      r.model.assemblies
        .flatMap((a) => Object.values(a.quality))
        .some((q) => q.basis === 'measured'),
    ).toBe(false);
    expect(r.model.evidence?.unresolved.some((u) => u.includes('assumed'))).toBe(true);
    expect(ProcModel.safeParse(r.model).success).toBe(true);
  });

  it('nothing is added because chimneys usually have it: no ladder without evidence or proposal', () => {
    const model = assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() }).model;
    for (const kind of ['ladder', 'ringPlatform', 'duct', 'cabinet', 'guardrail'] as const)
      expect(byKind(model, kind)).toHaveLength(0);
  });

  it('adds a proposed ladder, platform, duct and cabinet, placed by rule and inferred', () => {
    const p = stackProposal();
    const extra = (kind: string, role: string, params: Record<string, number | boolean> = {}) => ({
      role,
      kind,
      count: 1,
      units: 'ratio' as const,
      params,
      imageIds: [],
      observed: true,
    });
    const proposal = EngineerProposal.parse({
      ...p,
      components: [
        ...p.components,
        extra('ladder', 'ladder', { cage: true }),
        { ...extra('ringPlatform', 'platform', { guardrail: true }), levels: [0.75] },
        extra('duct', 'duct', { entryRatio: 0.04 }),
        extra('cabinet', 'cabinet'),
      ],
    });
    const r = assemble({ ...base, evidence: stackEvidence(), proposal });
    const ladder = must(byKind(r.model, 'ladder')[0]);
    expect(ladder.id).toBe('ladder-1');
    expect(ladder.params.bottom[2]).toBeLessThan(0); // the north face
    expect(ladder.params.cage).toBe(true);
    expect(ladder.quality.bottom?.basis).toBe('inferred');
    const platform = must(byKind(r.model, 'ringPlatform')[0]);
    expect(platform.params.y).toBeCloseTo(0.75 * STACK_TRUTH.height, 6);
    expect(platform.params.rInner).toBeGreaterThan(radiusAt(r.model, platform.params.y));
    expect(byKind(r.model, 'guardrail')).toHaveLength(1);
    expect(byKind(r.model, 'duct')).toHaveLength(1);
    expect(byKind(r.model, 'cabinet')).toHaveLength(1);
    expect(ProcModel.safeParse(r.model).success).toBe(true);
    const { failed } = buildEngineeringGlb(r.model, {
      detail: 'fast',
      drafts: true,
      generator: 't',
    });
    expect(failed).toEqual([]);
  });

  it('flues stay inside the crown radius minus clearance and do not intersect', () => {
    const crownR = must(STACK_TRUTH.profile.at(-1)).r;
    for (const flues of [3, 6, 9]) {
      const p = stackProposal({ flues });
      const proposal = {
        ...p,
        components: p.components.map((c) =>
          c.kind === 'flue' ? { ...c, params: { ...c.params, rOuter: 0.3 } } : c,
        ),
      };
      const r = assemble({
        ...base,
        setup: { ...base.setup, reference: { what: 'height', valueM: STACK_TRUTH.height } },
        proposal,
      });
      const shaft = must(byKind(r.model, 'shaft')[0]);
      const bore = crownR - must(shaft.params.wall);
      const fl = byKind(r.model, 'flue');
      expect(fl).toHaveLength(flues);
      for (const f of fl) {
        const [x, , z] = f.params.centre;
        expect(Math.hypot(x, z) + f.params.rOuter).toBeLessThanOrEqual(bore - 0.1);
      }
      for (const [i, a] of fl.entries())
        for (const b of fl.slice(i + 1)) {
          const d = Math.hypot(
            a.params.centre[0] - b.params.centre[0],
            a.params.centre[2] - b.params.centre[2],
          );
          expect(d).toBeGreaterThan(a.params.rOuter + b.params.rOuter);
        }
      const deck = must(byKind(r.model, 'deck')[0]);
      for (const [i, o] of deck.params.openings.entries())
        expect(o.r).toBeCloseTo(must(fl[i]).params.rOuter + 0.02, 9);
    }
  });

  it('a reference height scales a provisional model and marks it reference', () => {
    const proposal = stackProposal();
    const provisional = assemble({ ...base, proposal }).model;
    const scaled = assemble({
      ...base,
      proposal,
      setup: { ...base.setup, reference: { what: 'height', valueM: 90, label: 'drawing' } },
    }).model;
    expect(scaled.scale).toEqual({
      status: 'reference',
      reference: { what: 'height', valueM: 90, label: 'drawing' },
    });
    const top = (m: ProcModel) => must(must(byKind(m, 'shaft')[0]).params.profile.at(-1));
    const bottom = (m: ProcModel) => must(must(byKind(m, 'shaft')[0]).params.profile[0]);
    expect(top(scaled).y).toBeCloseTo(90, 9);
    // the same shape, only its size follows the reference
    expect(bottom(scaled).r / top(scaled).y).toBeCloseTo(
      bottom(provisional).r / top(provisional).y,
    );
    expect(must(byKind(scaled, 'shaft')[0]).quality.profile?.basis).toBe('observed');
  });

  it('removing a role drops its drafts', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence(),
      proposal: stackProposal(),
      user: { ...noUser(), removed: ['band'] },
    });
    expect(byKind(r.model, 'band')).toHaveLength(0);
    expect(byKind(r.model, 'shaft')).toHaveLength(1);
  });

  it('a person value the schema refuses is not applied and is flagged', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence(),
      proposal: stackProposal(),
      user: { ...noUser(), params: { 'flue-1': { rInner: 5 } } },
    });
    const f = must(byKind(r.model, 'flue').find((a) => a.id === 'flue-1'));
    expect(f.params.rInner).toBeLessThan(f.params.rOuter);
    expect(r.flagged.map((x) => x.id)).toContain('flue-1');
  });

  it('records what supports the model and what the proposal could not place', () => {
    const p = stackProposal();
    const proposal = {
      ...p,
      components: [
        ...p.components,
        {
          role: 'hopper',
          kind: 'hopper',
          count: 1,
          units: 'ratio' as const,
          params: {},
          imageIds: [],
          observed: true,
        },
      ],
      unresolved: ['Paint colour of the top band is unclear.'],
    };
    const r = assemble({ ...base, evidence: stackEvidence(), proposal });
    const inv = must(r.model.evidence);
    expect(inv.supported).toContain('shaft-1');
    expect(inv.missing.some((m) => m.includes('hopper'))).toBe(true);
    expect(inv.unresolved).toContain('Paint colour of the top band is unclear.');
    expect(r.model.family).toBe('chimney');
    expect(r.model.run).toEqual({ id: 'run-a', detail: 'standard' });
  });

  it('photos count 2 flues, the cloud 3: the observed count wins, the strongest kept, noted', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence(),
      proposal: stackProposal({ flues: 2 }),
    });
    const fl = byKind(r.model, 'flue');
    expect(fl).toHaveLength(2);
    expect(fl.every((f) => f.quality.centre?.basis === 'measured')).toBe(true);
    expect(r.unresolved.filter((u) => u.includes('flues'))).toEqual([
      'The AI counts 2 flues, the measurements 3: 2 used (the AI count).',
    ]);
  });

  it('photos count 5 flues, the cloud 3: five, the two beyond the cloud inferred, noted', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence(),
      proposal: stackProposal({ flues: 5 }),
    });
    const fl = byKind(r.model, 'flue');
    expect(fl).toHaveLength(5);
    expect(fl.filter((f) => f.quality.centre?.basis === 'measured')).toHaveLength(3);
    expect(fl.filter((f) => f.quality.centre?.basis === 'inferred')).toHaveLength(2);
    expect(r.unresolved).toContain(
      'The AI counts 5 flues, the measurements 3: 5 used (the AI count).',
    );
  });

  it('an unseen AI count gives way to the cloud, and agreeing counts leave no note', () => {
    const p = stackProposal({ flues: 2 });
    const unseen = {
      ...p,
      components: p.components.map((c) => (c.kind === 'flue' ? { ...c, observed: false } : c)),
    };
    const r = assemble({ ...base, evidence: stackEvidence(), proposal: unseen });
    expect(byKind(r.model, 'flue')).toHaveLength(3);
    expect(r.unresolved).toContain(
      'The AI counts 2 flues, the measurements 3: 3 used (the measured count).',
    );
    const agree = assemble({ ...base, evidence: stackEvidence(), proposal: stackProposal() });
    expect(agree.unresolved.some((u) => u.includes('The AI counts'))).toBe(false);
  });

  it('a level where the cloud sees fewer lights than the photos uses the photos and notes it', () => {
    const r = assemble({
      ...base,
      evidence: stackEvidence({ partial: true }),
      proposal: stackProposal(),
    });
    expect(r.unresolved).toContain(
      'The AI counts 3 lights at 40.0 m, the measurements 1: 3 used (the AI count).',
    );
  });

  it("the person's flue count is not the person's open top: the shaft's basis stays", () => {
    const run = (flues?: number) =>
      assemble({
        ...base,
        evidence: stackEvidence(),
        proposal: stackProposal(),
        user: { ...noUser(), counts: flues === undefined ? {} : { flue: flues } },
      });
    const shaft = (r: ReturnType<typeof run>) => must(byKind(r.model, 'shaft')[0]);
    const before = shaft(run());
    const after = shaft(run(4));
    expect(after.quality).toEqual(before.quality);
    expect(after.quality.openTop?.basis).not.toBe('user');
    expect(byKind(run(4).model, 'flue')).toHaveLength(4);
    // a count that changes the open top: inferred, still not the person's
    const none = shaft(run(0));
    expect(none.quality.openTop?.basis).toBe('inferred');
  });

  it('a generic model is the shaft alone', () => {
    const r = assemble({
      ...base,
      family: 'generic',
      evidence: stackEvidence(),
      proposal: stackProposal(),
    });
    expect(r.model.assemblies.map((a) => a.kind)).toEqual(['shaft']);
  });
});

describe('fixtures', () => {
  it('every evidence pack and proposal is valid', () => {
    for (const e of [
      stackEvidence(),
      stackEvidence({ partial: true }),
      flareEvidence(),
      latticeEvidence(),
      monopoleEvidence(),
    ])
      expect(EvidencePack.safeParse(e).success).toBe(true);
    for (const p of [stackProposal(), flareProposal(), latticeProposal(), monopoleProposal()])
      expect(EngineerProposal.safeParse(p).success).toBe(true);
    expect(FLARE_TRUTH.height).toBeGreaterThan(0);
    expect(LATTICE_TRUTH.legs).toBe(4);
    expect(MONOPOLE_TRUTH.height).toBeGreaterThan(0);
    expect(setupFor('auto').family).toBe('auto');
  });
});
