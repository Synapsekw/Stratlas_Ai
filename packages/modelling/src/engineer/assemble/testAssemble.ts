/**
 * Helpers of the assembler tests: a base input, the synthetic chimney assembled from its evidence
 * and proposal, and lookups that throw instead of returning undefined (no non-null assertions).
 */
import type { Assembly, AssemblyKind, EvidencePack, PartStatus, ProcModel } from '@aio/schema';
import { profileRadiusAt, shaftHeightAt } from '../builders/ctx';
import { setupFor, stackEvidence, stackProposal } from '../fixtures';
import { assemble, type AssembleInput, type AssembleResult, type UserOverrides } from './assemble';

export function must<T>(x: T | null | undefined, what = 'value'): T {
  if (x === null || x === undefined) throw new Error(`test: missing ${what}`);
  return x;
}

export const noUser = (): UserOverrides => ({
  params: {},
  counts: {},
  levels: {},
  removed: [],
  added: [],
});

export const base: AssembleInput = {
  modelId: 'stack-a',
  runId: 'run-a',
  family: 'chimney',
  scope: 'asset',
  evidence: null,
  proposal: null,
  setup: setupFor('chimney'),
  user: noUser(),
  previous: null,
  now: '2026-10-15T00:00:00.000Z',
};

/**
 * The synthetic chimney from its full evidence and proposal. `flues` is the person's correction
 * of the flue count; `levels` the light levels (metres) the proposal names.
 */
export function assembleStack(
  o: {
    flues?: number;
    levels?: number[];
    previous?: ProcModel | null;
    user?: Partial<UserOverrides>;
    evidence?: EvidencePack | null;
  } = {},
): AssembleResult {
  const user = { ...noUser(), ...o.user };
  if (o.flues !== undefined) user.counts = { ...user.counts, flue: o.flues };
  return assemble({
    ...base,
    evidence: o.evidence === undefined ? stackEvidence() : o.evidence,
    proposal: stackProposal(o.levels ? { levels: o.levels } : {}),
    previous: o.previous ?? null,
    user,
  });
}

export function withStatus(model: ProcModel, id: string, status: PartStatus): ProcModel {
  must(
    model.assemblies.find((a) => a.id === id),
    id,
  );
  return {
    ...model,
    assemblies: model.assemblies.map((a) => (a.id === id ? { ...a, status } : a)),
  };
}

export function byId(model: ProcModel, id: string): Assembly {
  return must(
    model.assemblies.find((a) => a.id === id),
    `assembly ${id}`,
  );
}

export function byKind<K extends AssemblyKind>(
  model: ProcModel,
  kind: K,
): Extract<Assembly, { kind: K }>[] {
  return model.assemblies.filter((a): a is Extract<Assembly, { kind: K }> => a.kind === kind);
}

/** Outer radius of the model's first shaft at world height `y`. */
export function radiusAt(model: ProcModel, y: number): number {
  const s = must(byKind(model, 'shaft')[0], 'shaft');
  return profileRadiusAt(s.params.profile, shaftHeightAt(s.params, y));
}
