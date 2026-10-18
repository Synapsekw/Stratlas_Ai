import { stackModel, setupFor } from '@aio/modelling';
import type { EngineerRun, ModelCorrection, ProcModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createCorrectionSession } from './correctionSession';

const now = '2026-10-17T10:00:00.000Z';
function harness() {
  let model = stackModel();
  let run: EngineerRun = {
    schema: 'aio.engineer-run/1',
    id: 'run-review',
    modelId: model.id,
    createdAt: now,
    setup: setupFor('chimney'),
    stages: {},
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  };
  let projectId = 'project-one';
  let fail = false;
  const api = createCorrectionSession(
    () => ({
      model,
      run,
      projectId,
      busy: false,
      save: (requests: ModelCorrection[], next?: ProcModel) => {
        if (fail) return Promise.reject(Error('disk full'));
        run = { ...run, corrections: structuredClone(requests) };
        if (next) model = next;
        return Promise.resolve();
      },
    }),
    () => now,
  );
  return {
    api,
    model: () => model,
    run: () => run,
    switch: () => {
      projectId = 'project-two';
    },
    fail: () => {
      fail = true;
    },
  };
}
describe('persisted model correction session', () => {
  it('keeps geometry untouched until a person accepts and preserves all unrelated assemblies', async () => {
    const h = harness();
    const original = h.model();
    const a = original.assemblies.find((a) => a.kind === 'flue');
    if (!a) throw Error('fixture');
    await h.api.create({
      id: 'fix-one',
      target: { kind: 'part', partId: a.id },
      comment: 'Increase the outer radius to 1.05 m.',
    });
    await h.api.propose('fix-one', {
      explanation: 'The reviewer supplied the radius.',
      patch: [{ op: 'replace', assembly: { ...a, params: { ...a.params, rOuter: 1.05 } } }],
    });
    expect(h.model()).toBe(original);
    expect(h.run().corrections?.[0]?.status).toBe('proposed');
    const candidate = await h.api.candidate('fix-one');
    expect(candidate.georef).toEqual(original.georef);
    expect(candidate.assemblies.filter((x) => x.id !== a.id)).toEqual(
      original.assemblies.filter((x) => x.id !== a.id),
    );
    await h.api.accept('fix-one');
    expect(h.model().assemblies.find((x) => x.id === a.id)?.params).toMatchObject({ rOuter: 1.05 });
    expect(h.run().corrections?.[0]?.status).toBe('accepted');
  });
  it('leaves the proposal and model intact when saving acceptance fails', async () => {
    const h = harness();
    const original = h.model();
    const a = original.assemblies.find((a) => a.kind === 'flue');
    if (!a) throw Error('fixture');
    await h.api.create({
      id: 'fix-one',
      target: { kind: 'part', partId: a.id },
      comment: 'Change radius.',
    });
    await h.api.propose('fix-one', {
      explanation: 'Requested size.',
      patch: [{ op: 'replace', assembly: { ...a, params: { ...a.params, rOuter: 1.05 } } }],
    });
    h.fail();
    await expect(h.api.accept('fix-one')).rejects.toThrow('disk full');
    expect(h.model()).toBe(original);
    expect(h.run().corrections?.[0]?.status).toBe('proposed');
  });
  it('refuses a hash-completion from a project that was closed while work was pending', async () => {
    const h = harness();
    const a = h.model().assemblies[0];
    if (!a) throw Error('fixture');
    const pending = h.api.create({
      id: 'fix-one',
      target: { kind: 'part', partId: a.id },
      comment: 'Inspect this part.',
    });
    h.switch();
    await expect(pending).rejects.toThrow(/project or model changed/);
    expect(h.run().corrections).toBeUndefined();
  });
});
