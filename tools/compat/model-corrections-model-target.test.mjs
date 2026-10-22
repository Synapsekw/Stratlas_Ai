// Model-wide correction target (plan 2026-10-22-model-typed-corrections) is additive but 0.21 to
// 0.24 refuse a run file holding one (documented in contract-changes). Pinned against 0.21.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const NOW = '2026-10-22T00:00:00.000Z';
const run = (target) => ({
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
  corrections: [
    {
      id: 'correction-1',
      modelId: 'synthetic',
      target,
      comment: 'Please check this.',
      baseFingerprint: `sha256:${'0'.repeat(64)}`,
      status: 'open',
      createdAt: NOW,
      updatedAt: NOW,
      replies: [],
      history: [],
    },
  ],
});

describe('model-wide correction target', () => {
  it('0.21 refuses a run holding a model-wide request (documented)', () => {
    const value = run({ kind: 'model' });
    expect(current.EngineerRun.safeParse(value).success).toBe(true);
    expect(v021.EngineerRun.safeParse(value).success).toBe(false);
  });

  it('runs without model-wide requests read the same in 0.21', () => {
    const value = run({ kind: 'part', partId: 'radio-1' });
    expect(current.EngineerRun.safeParse(value).success).toBe(true);
    expect(v021.EngineerRun.safeParse(value).success).toBe(true);
  });
});
