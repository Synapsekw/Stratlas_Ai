import { describe, expect, it } from 'vitest';
import { EngineerRun } from './engineer';
import { CorrectionTarget, ModelCorrection } from './modelCorrections';

const NOW = '2026-10-17T00:00:00.000Z';
const correction = () => ({
  id: 'correction-1',
  modelId: 'synthetic',
  target: { kind: 'part', partId: 'radio-1' },
  comment: 'Please check this component.',
  baseFingerprint: `sha256:${'0'.repeat(64)}`,
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
  replies: [],
  history: [],
});

describe('bounded model correction records', () => {
  it('roundtrips part targets, viewpoints and permitted evidence references', () => {
    const value = {
      ...correction(),
      camera: { position: [4, 6, 8], target: [1, 2, 3], fovDeg: 45 },
      evidence: [{ kind: 'photo', ref: 'img-1' }],
    };
    expect(ModelCorrection.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('requires separate model-local and project-local pin positions and a source layer', () => {
    const pin = {
      kind: 'pin',
      position: [100, 28, -200],
      projectPosition: [0, 28, 0],
      radiusM: 2,
      sourceLayerId: 'cloud-1',
    };
    expect(CorrectionTarget.safeParse(pin).success).toBe(true);
    expect(CorrectionTarget.safeParse({ ...pin, position: [NaN, 1, 2] }).success).toBe(false);
    expect(CorrectionTarget.safeParse({ ...pin, projectPosition: undefined }).success).toBe(false);
    expect(CorrectionTarget.safeParse({ ...pin, sourceLayerId: '' }).success).toBe(false);
    expect(CorrectionTarget.safeParse({ ...pin, radiusM: 5.01 }).success).toBe(false);
  });

  it('refuses unreviewable states, oversized text and unknown instruction fields', () => {
    expect(ModelCorrection.safeParse({ ...correction(), status: 'proposed' }).success).toBe(false);
    expect(ModelCorrection.safeParse({ ...correction(), status: 'accepted' }).success).toBe(false);
    expect(ModelCorrection.safeParse({ ...correction(), comment: ' '.repeat(20) }).success).toBe(
      false,
    );
    expect(ModelCorrection.safeParse({ ...correction(), comment: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(ModelCorrection.safeParse({ ...correction(), execute: 'script' }).success).toBe(false);
    expect(
      ModelCorrection.safeParse({
        ...correction(),
        replies: Array(33).fill({ comment: 'Check again.', createdAt: NOW }),
      }).success,
    ).toBe(false);
    expect(
      ModelCorrection.safeParse({
        ...correction(),
        evidence: Array(25).fill({ kind: 'photo', ref: 'img-1' }),
      }).success,
    ).toBe(false);
  });

  it('persists at most 100 reports on a run while old runs still parse', () => {
    const run = {
      schema: 'aio.engineer-run/1',
      id: 'run-synthetic',
      modelId: 'synthetic',
      createdAt: NOW,
      setup: {
        sources: { clouds: [], meshes: [], photos: [] },
        family: 'auto',
        scope: 'asset',
        detail: 'standard',
        placement: 'unplaced',
      },
      stages: {},
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    };
    expect(EngineerRun.safeParse(run).success).toBe(true);
    expect(EngineerRun.safeParse({ ...run, corrections: [correction()] }).success).toBe(true);
    expect(
      EngineerRun.safeParse({ ...run, corrections: Array(101).fill(correction()) }).success,
    ).toBe(false);
  });

  it('accepts a model-wide target and refuses extra keys on it', () => {
    expect(CorrectionTarget.safeParse({ kind: 'model' }).success).toBe(true);
    expect(CorrectionTarget.safeParse({ kind: 'model', partId: 'x' }).success).toBe(false);
  });

  it('caps a model-wide proposal at 20 operations, a part proposal stays at 32', () => {
    const ops = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'remove', id: `p${i}` }));
    const record = (target: unknown, n: number) => ({
      ...correction(),
      target,
      status: 'proposed',
      proposal: {
        explanation: 'Remove them.',
        patch: ops(n),
        createdAt: NOW,
        before: [],
        candidateFingerprint: `sha256:${'1'.repeat(64)}`,
      },
    });
    expect(ModelCorrection.safeParse(record({ kind: 'model' }, 20)).success).toBe(true);
    expect(ModelCorrection.safeParse(record({ kind: 'model' }, 21)).success).toBe(false);
    expect(ModelCorrection.safeParse(record({ kind: 'part', partId: 'p0' }, 21)).success).toBe(
      true,
    );
    const old = record({ kind: 'model' }, 21).proposal;
    expect(
      ModelCorrection.safeParse({
        ...correction(),
        target: { kind: 'model' },
        history: [{ proposal: old, disposition: 'rejected', at: NOW }],
      }).success,
    ).toBe(false);
  });
});
