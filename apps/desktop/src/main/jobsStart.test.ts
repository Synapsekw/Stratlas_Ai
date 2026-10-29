import type { IpcRequest } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { en } from '@aio/ui/i18n/en';
import { describe, expect, it, vi } from 'vitest';
import { detectPackRefusal } from './analytics/detectPack';
import { evidenceJobPackRefusal, evidencePackRefusal } from './evidencePack';
import { thermalPackRefusal } from './thermalPack';

/** Exercise the registered IPC callback without starting Electron or a pipeline process. */
function jobsStart(
  version: string,
  status: 'failed' | 'cancelled' | 'interrupted',
  saved: { params: Record<string, unknown>; packVersion: string; project?: string } = {
    params: {},
    packVersion: '0.13.1',
  },
  gpuBusy: (pipeline: string) => string | null = () => null,
) {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.ArrowFunction | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'handle' &&
      node.arguments[0]?.getText(source) === "'jobs:start'"
    ) {
      const fn = node.arguments[1];
      if (fn && ts.isArrowFunction(fn)) callback = fn;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!callback) throw new Error('jobs:start handler is not registered.');
  const start = vi.fn(() => Promise.resolve({ ok: true }));
  const detectStart = vi.fn(() => Promise.resolve({ ok: true }));
  const photoStarting = vi.fn();
  const findPack = vi.fn(() => Promise.resolve({ pack: { version } }));
  const compiled = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const handle = runInNewContext(compiled, {
    PACKAGE_EXTENSION: '.aio',
    jobs: {
      get: () => ({
        id: 'saved-evidence',
        project: 'synthetic',
        pipeline: 'model.evidence',
        status,
        ...saved,
      }),
      start,
    },
    jobStore: { all: () => [] },
    drawingJobRefusal: () => Promise.resolve(null),
    photoBusyRefusal: () => null,
    odmGuard: { busy: () => null },
    settings: { current: () => ({ dataRoot: 'synthetic' }) },
    process: { env: {} },
    packApp: {},
    findPack,
    walkPackRefusal: () => null,
    panoPackRefusal: () => null,
    cleanPackRefusal: () => null,
    antennaPackRefusal: () => null,
    readAntennaInventory: () => Promise.resolve(null),
    readAntennaDeletions: () => Promise.resolve(false),
    rfPackRefusal: () => null,
    thermalPackRefusal,
    evidenceJobPackRefusal,
    detectPackRefusal,
    detectQueue: { start: detectStart, gpuBusy, photoStarting },
    laneSphere: () => null,
  }) as (req: IpcRequest<'jobs:start'>) => Promise<{ ok: boolean; error?: string }>;
  return { handle, start, detectStart, findPack, photoStarting };
}

describe('jobs:start resume feature gate', () => {
  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'refuses resuming %s evidence jobs on the unrepaired pack',
    async (status) => {
      const t = jobsStart('0.13.0', status);
      expect(await t.handle({ resume: 'saved-evidence' })).toEqual({
        ok: false,
        error: evidencePackRefusal('model.evidence', '0.13.0', {
          params: {},
          packVersion: '0.13.1',
        }),
      });
      expect(t.start).not.toHaveBeenCalled();
    },
  );

  it.each(['0.13.1', '0.15.0', '0.16.0', 'dev'])(
    'allows the saved evidence pipeline to resume on pack %s',
    async (version) => {
      const t = jobsStart(version, 'failed');
      expect(await t.handle({ resume: 'saved-evidence' })).toEqual({ ok: true });
      expect(t.findPack).toHaveBeenCalledOnce();
      expect(t.start).toHaveBeenCalledWith({ resume: 'saved-evidence' });
    },
  );

  it('refuses new component evidence and drawing-free enhanced resumes on an older pack', async () => {
    const fresh = jobsStart('0.15.0', 'failed');
    const req = { pipeline: 'model.evidence' as const, project: 'synthetic', params: {} };
    expect(await fresh.handle(req)).toMatchObject({ ok: false });
    expect(fresh.start).not.toHaveBeenCalled();
    const resumed = jobsStart('0.15.0', 'failed', {
      params: { clouds: [{ layer: 'scan' }] },
      packVersion: '0.16.0',
    });
    expect(await resumed.handle({ resume: 'saved-evidence' })).toMatchObject({ ok: false });
    expect(resumed.start).not.toHaveBeenCalled();
  });

  it('refuses thermal.decode on a pack below 0.22.0 with the update text', async () => {
    const req = {
      pipeline: 'thermal.decode' as const,
      project: 'synthetic',
      params: { layerId: 'ph' },
    };
    const old = jobsStart('0.20.0', 'failed');
    expect(await old.handle(req)).toEqual({
      ok: false,
      error: thermalPackRefusal('thermal.decode', '0.20.0'),
    });
    expect(old.start).not.toHaveBeenCalled();
    const current = jobsStart('0.22.0', 'failed');
    expect(await current.handle(req)).toEqual({ ok: true });
  });

  it('refuses detect.vlm on processing tools below 0.27.0 before the detector queue', async () => {
    const req = { pipeline: 'detect.vlm' as const, project: 'synthetic', params: {} };
    const old = jobsStart('0.26.0', 'failed');
    expect(await old.handle(req)).toEqual({
      ok: false,
      error: detectPackRefusal('detect.vlm', '0.26.0'),
    });
    expect(old.detectStart).not.toHaveBeenCalled();
    const current = jobsStart('0.27.0', 'failed');
    expect(await current.handle(req)).toEqual({ ok: true });
    expect(current.detectStart).toHaveBeenCalledWith(req);
  });

  it('refuses a photo job while a detector run holds the graphics card', async () => {
    const busy = (p: string) => (p === 'photo.align' ? en['detect.preset.gpuBusy'] : null);
    const t = jobsStart('0.23.0', 'failed', undefined, busy);
    const req = { pipeline: 'photo.align' as const, project: 'synthetic', params: {} };
    expect(await t.handle(req)).toEqual({ ok: false, error: en['detect.preset.gpuBusy'] });
    expect(t.start).not.toHaveBeenCalled();
    expect(t.photoStarting).not.toHaveBeenCalled();
    const other = { pipeline: 'walk.process' as const, project: 'synthetic', params: {} };
    expect(await t.handle(other)).toEqual({ ok: true });
  });

  it('stops a model kept warm after a local ask before a job that is let through starts', async () => {
    const t = jobsStart('0.23.0', 'failed');
    const req = { pipeline: 'photo.align' as const, project: 'synthetic', params: {} };
    expect(await t.handle(req)).toEqual({ ok: true });
    expect(t.photoStarting).toHaveBeenCalledWith('photo.align');
    expect(t.photoStarting.mock.invocationCallOrder[0]).toBeLessThan(
      t.start.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('allows new component evidence on the component-processing pack', async () => {
    const fresh = jobsStart('0.16.0', 'failed');
    const req = { pipeline: 'model.evidence' as const, project: 'synthetic', params: {} };
    expect(await fresh.handle(req)).toEqual({ ok: true });
    expect(fresh.start).toHaveBeenCalledWith(req);
  });

  it('recognizes a prerelease drawing-free component checkpoint independently of its pack label', async () => {
    const project = await mkdtemp(join(tmpdir(), 'evidence-checkpoint-gate-'));
    try {
      const folder = join(project, 'jobs', 'saved-evidence');
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, 'job.json'),
        JSON.stringify({ pipeline: 'model.evidence', pipelineVersion: 'components/7' }),
      );
      const old = jobsStart('0.15.0', 'interrupted', {
        params: { clouds: [{ layer: 'scan' }] },
        packVersion: '0.14.0',
        project,
      });
      expect(await old.handle({ resume: 'saved-evidence' })).toMatchObject({ ok: false });
      expect(old.start).not.toHaveBeenCalled();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
