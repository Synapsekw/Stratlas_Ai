/**
 * Acceptance A, C and G across the seams: the evidence packs written by the Python `model.evidence`
 * job (committed fixtures, synthetic only) go through the scripted proposal, the assembler, the
 * GLB writer and the file checks, as the app does, not through hand-made test packs.
 */
import { readFileSync } from 'node:fs';
import { EngineerProposal, EvidencePack, ProcModel, type EvidencePack as Pack } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { assemble } from './assemble/assemble';
import { base, byKind, must } from './assemble/testAssemble';
import { STACK_TRUTH, openingsOf, setupFor, stackProposal } from './fixtures';
import { buildEngineeringGlb } from './meshAssemblies';
import { khronos } from './testKhronos';
import { validateGlb } from './validate';

const fixture = (name: string): Pack => {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL(`../../../schema/src/__fixtures__/engineering/${name}`, import.meta.url),
      'utf8',
    ),
  );
  return EvidencePack.parse(raw);
};

const partial = fixture('evidence.partial-stack.json');
const single = fixture('evidence.single-photo.json');

/** The longest list anywhere in a value. */
function longest(v: unknown): number {
  if (Array.isArray(v)) return Math.max(v.length, ...v.map(longest));
  if (v && typeof v === 'object') return Math.max(0, ...Object.values(v).map(longest));
  return 0;
}

describe('A: a partial noisy chimney cloud with photos, through the whole chain', () => {
  const proposal = EngineerProposal.parse(stackProposal());
  const result = assemble({
    ...base,
    evidence: partial,
    proposal,
    family: 'chimney',
    setup: setupFor('chimney'),
  });
  const model = result.model;

  it('starts from a pack of measurements, not of points', () => {
    expect(partial.samples.kept).toBeGreaterThan(10_000);
    expect(longest(partial)).toBeLessThanOrEqual(256);
    expect(partial.photos.length).toBeGreaterThan(0);
    expect(partial.familyHints?.suggested).toBe('chimney');
  });

  it('draws the measured taper, the flues the evidence supports and the intermediate lights', () => {
    const shaft = must(byKind(model, 'shaft')[0]);
    expect(shaft.quality.profile?.basis).toBe('measured');
    const profile = shaft.params.profile;
    const r = (y: number) => {
      const i = profile.findIndex((p) => p.y >= y);
      const a = must(profile[Math.max(0, i - 1)]);
      const b = must(profile[Math.max(0, i)]);
      return b.y === a.y ? a.r : a.r + ((b.r - a.r) * (y - a.y)) / (b.y - a.y);
    };
    for (const y of [0, 30, 100]) {
      const want =
        y >= 55
          ? 6.5
          : 9 - (2.5 * y) / 55; /* the synthetic truth of the seeded cloud (fixtures.ts) */
      expect(Math.abs(r(y + shaft.params.base[1]) - want) / want).toBeLessThan(0.02);
    }
    // the pack saw the flues that stand outside the scan gap; the others are not measured
    const seen = must(partial.members.find((g) => g.kind === 'flue')).items.length;
    expect(seen).toBe(2);
    const flues = byKind(model, 'flue');
    expect(flues.filter((f) => f.quality.centre?.basis === 'measured')).toHaveLength(seen);
    expect(flues.length).toBeGreaterThanOrEqual(seen);
    for (const f of flues.filter((x) => x.quality.centre?.basis !== 'measured'))
      expect(f.quality.centre?.basis).not.toBe('measured');
    // lights: the two intermediate levels and the crown, from the pack's measured levels
    const levels = [
      ...new Set(
        byKind(model, 'warningLight').map((a) =>
          Math.round(a.params.centre[1] - shaft.params.base[1]),
        ),
      ),
    ].sort((a, b) => a - b);
    expect(levels).toEqual(STACK_TRUTH.lightLevels);
    expect(model.scale?.status).toBe('measured');
    expect(ProcModel.safeParse(model).success).toBe(true);
  });

  it('is authored geometry: smaller than the cloud, no input vertex reused, parts built by rule', async () => {
    const out = buildEngineeringGlb(model, { detail: 'standard', drafts: true, generator: 't' });
    expect(out.failed).toEqual([]);
    const r = await validateGlb(out.glb, { budget: 400_000, openings: openingsOf(model), khronos });
    expect(r.triangles).toBeGreaterThan(1_000);
    expect(r.triangles).toBeLessThan(partial.samples.kept);
    // no assembly stores a point list beyond its own path, and a profile stays short
    for (const a of model.assemblies) expect(longest(a.params)).toBeLessThanOrEqual(64);
    expect(out.nodes.length).toBe(model.assemblies.length);
  });

  it('G: the written file passes the validator, is finite and closed where it should be, within budget', async () => {
    const out = buildEngineeringGlb(model, { detail: 'standard', drafts: true, generator: 't' });
    const r = await validateGlb(out.glb, { budget: 400_000, openings: openingsOf(model), khronos });
    expect(r.validatorErrors).toBe(0);
    expect(r.finite).toBe(true);
    expect(r.indicesValid).toBe(true);
    expect(r.normalsUnit).toBe(true);
    expect(r.degenerate).toBe(0);
    expect(r.duplicateTris).toBe(0);
    expect(r.unintendedHoles).toEqual([]);
    expect(r.intendedOpenOk).toBe(true);
    expect(r.openingProblems).toEqual([]);
    expect(r.withinBudget).toBe(true);
    // over a smaller budget the same file is reported, not passed
    const tight = await validateGlb(out.glb, { budget: 100, khronos });
    expect(tight.withinBudget).toBe(false);
  });
});

describe('C: one ordinary photo, through the whole chain', () => {
  const setup = { ...setupFor('chimney'), placement: 'unplaced' as const };
  const result = assemble({
    ...base,
    evidence: single,
    proposal: EngineerProposal.parse(stackProposal()),
    family: 'chimney',
    setup,
  });
  const model = result.model;

  it('the pack claims no measurement and says reconstruction was not available', () => {
    expect(single.samples.kept).toBe(0);
    expect(single.taper).toBeNull();
    expect(single.axis).toBeNull();
    expect(single.members).toEqual([]);
    expect(single.reconstruction).toBe('unavailable');
    expect(single.photos).toHaveLength(1);
  });

  it('scale is provisional and asks for a reference; nothing is called measured', () => {
    expect(model.scale?.status).toBe('provisional');
    expect(result.unresolved.some((u) => /assumed|scale|reference/i.test(u))).toBe(true);
    for (const a of model.assemblies)
      for (const q of Object.values(a.quality)) expect(q.basis).not.toBe('measured');
    expect(ProcModel.safeParse(model).success).toBe(true);
  });

  it('marks what no photo showed as unobserved', () => {
    const shaft = must(byKind(model, 'shaft')[0]);
    expect(shaft.unobserved?.length ?? 0).toBeGreaterThan(0);
  });

  it('meshes and passes the file checks like any other model', async () => {
    const out = buildEngineeringGlb(model, { detail: 'fast', drafts: true, generator: 't' });
    expect(out.failed).toEqual([]);
    const r = await validateGlb(out.glb, { budget: 150_000, openings: openingsOf(model), khronos });
    expect(r.validatorErrors).toBe(0);
    expect(r.triangles).toBeGreaterThan(100);
    expect(r.unintendedHoles).toEqual([]);
  });
});
