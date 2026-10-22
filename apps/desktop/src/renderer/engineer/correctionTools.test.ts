import { runRendererTool, ToolError, type RendererToolContext } from '@aio/ai';
import { stackModel, setupFor } from '@aio/modelling';
import type { EngineerRun, ProcModel } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCorrectionSession } from './correctionSession';
import {
  prepareCorrectionSubmission,
  registerCorrectionTools,
  setCorrectionSession,
} from './correctionTools';

const now = '2026-10-17T10:00:00.000Z';
let model: ProcModel;
let saved: EngineerRun;
let cloud = true;
let allow = false;
let images = 0;
const session = createCorrectionSession(
  () => ({
    projectId: 'test',
    model,
    run: saved,
    busy: false,
    save: (requests, next) => {
      saved = { ...saved, corrections: requests };
      if (next) model = next;
      return Promise.resolve();
    },
  }),
  () => now,
);
const ctx: RendererToolContext = {
  workspace: createWorkspace(),
  window: 'scene3d',
  scene: () => null,
  fetchJson: () => Promise.resolve(null),
  captureFrame: () => Promise.resolve(null),
  now: () => new Date(now),
};
const run = (name: string, input: unknown = {}) => runRendererTool(name, input, ctx);
beforeAll(() => {
  registerCorrectionTools();
});
beforeEach(async () => {
  model = stackModel();
  cloud = true;
  allow = false;
  images = 0;
  saved = {
    schema: 'aio.engineer-run/1',
    id: 'run-review',
    modelId: model.id,
    createdAt: now,
    setup: setupFor('chimney'),
    stages: {},
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  };
  saved.setup.sources.clouds.push({ layer: 'scan' });
  setCorrectionSession({
    session,
    cloudRoute: () => Promise.resolve(cloud),
    permissions: () => ({ photos: allow, scans: allow, drawings: allow }),
    readEvidence: () => {
      images++;
      return Promise.resolve('data:image/png;base64,AAAA');
    },
  });
  const a = model.assemblies[0];
  if (!a) throw Error('fixture');
  await session.create({
    id: 'fix-one',
    target: { kind: 'part', partId: a.id },
    comment: 'Inspect this selected part.',
    evidence: [{ kind: 'photo', ref: 'photo-one' }],
  });
  await session.create({
    id: 'fix-private',
    target: { kind: 'part', partId: a.id },
    comment: 'Private unsent note.',
  });
});
describe('explicit correction submission and evidence scope', () => {
  it('refuses tools until the person submits, and respects project cloud permissions', async () => {
    await expect(run('list_model_corrections')).rejects.toBeInstanceOf(ToolError);
    await expect(prepareCorrectionSubmission(['fix-one'])).rejects.toThrow(/cloud AI/);
    expect(images).toBe(0);
  });
  it('shares only submitted notes and selected geometry, with attached images only', async () => {
    allow = true;
    const preview = await prepareCorrectionSubmission(['fix-one']);
    expect(preview).toContain('Inspect this selected part.');
    expect(preview).not.toContain('Private unsent note');
    const listed = (await run('list_model_corrections')).result;
    expect(JSON.stringify(listed)).not.toContain('fix-private');
    expect(listed).toMatchObject({
      components: [expect.objectContaining({ id: model.assemblies[0]?.id })],
    });
    await expect(
      run('view_model_correction_evidence', { requestId: 'fix-one', imageId: 'other-image' }),
    ).rejects.toThrow(/attached/);
    expect(images).toBe(0);
    expect(
      (await run('view_model_correction_evidence', { requestId: 'fix-one', imageId: 'photo-one' }))
        .result,
    ).toMatchObject({ image: 'data:image/png;base64,AAAA' });
    expect(images).toBe(1);
  });
  it('revokes scope when comments, project session, geometry or permissions change', async () => {
    allow = true;
    await prepareCorrectionSubmission(['fix-one']);
    await session.reply('fix-one', 'A new unsent reply.');
    await expect(run('list_model_corrections')).rejects.toThrow(/changed/);
    await prepareCorrectionSubmission(['fix-one']);
    allow = false;
    await expect(run('list_model_corrections')).rejects.toThrow(/cloud AI/);
    allow = true;
    await prepareCorrectionSubmission(['fix-one']);
    model = structuredClone(model);
    await expect(run('list_model_corrections')).rejects.toThrow(/changed/);
    setCorrectionSession(null);
    await expect(run('list_model_corrections')).rejects.toThrow(/Open/);
  });
  it('keeps a multi-request send usable after the first request is proposed', async () => {
    cloud = false;
    for (const id of ['flue-1', 'flue-2'])
      await session.create({
        id: `fix-${id}`,
        target: { kind: 'part', partId: id },
        comment: `Remove ${id}.`,
      });
    await prepareCorrectionSubmission(['fix-flue-1', 'fix-flue-2']);
    await run('propose_model_correction', {
      requestId: 'fix-flue-1',
      proposal: { explanation: 'Remove', patch: [{ op: 'remove', id: 'flue-1' }] },
    });
    expect(saved.corrections?.find((r) => r.id === 'fix-flue-1')?.status).toBe('proposed');
    await expect(run('list_model_corrections')).resolves.toBeTruthy();
    await run('propose_model_correction', {
      requestId: 'fix-flue-2',
      proposal: { explanation: 'Remove too', patch: [{ op: 'remove', id: 'flue-2' }] },
    });
    expect(saved.corrections?.find((r) => r.id === 'fix-flue-2')?.status).toBe('proposed');
    await expect(prepareCorrectionSubmission(['fix-flue-1'])).rejects.toThrow(/open/);
  });
  it('permits a local route without cloud flags and exposes useful scoped proposal failures', async () => {
    cloud = false;
    await prepareCorrectionSubmission(['fix-one']);
    await expect(
      run('propose_model_correction', {
        requestId: 'fix-private',
        proposal: { explanation: 'Remove', patch: [{ op: 'remove', id: model.assemblies[0]?.id }] },
      }),
    ).rejects.toThrow(/submitted/);
    await expect(
      run('propose_model_correction', {
        requestId: 'fix-one',
        proposal: { explanation: 'Wrong component', patch: [{ op: 'remove', id: 'unrelated' }] },
      }),
    ).rejects.toThrow(/selected/);
  });
});
