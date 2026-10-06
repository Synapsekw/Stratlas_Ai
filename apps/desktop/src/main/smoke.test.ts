import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDERER_PROBE, smokeProbe, writeSmokeReport } from './smoke';

const answer = { runtime: { available: true, provider: 'cpu', version: '1.30.0' }, models: [] };

describe('packaged smoke report', () => {
  it('asks the window first, like Settings', async () => {
    const r = await smokeProbe({
      fromRenderer: () => Promise.resolve(answer),
      fromMain: () => Promise.reject(new Error('not used')),
    });
    expect(r).toEqual({ inference: answer, via: 'renderer' });
    expect(RENDERER_PROBE).toContain("'inference:models'");
  });

  it('falls back to main when the window call fails, and says why', async () => {
    const r = await smokeProbe({
      fromRenderer: () => Promise.reject(new Error('window.aio is undefined')),
      fromMain: () => Promise.resolve({ runtime: answer.runtime }),
    });
    expect(r).toEqual({
      inference: { runtime: answer.runtime },
      via: 'main',
      rendererError: 'window.aio is undefined',
    });
  });

  it('reports a runtime that never answers instead of hanging', async () => {
    const never = () => new Promise<unknown>(() => undefined);
    const r = await smokeProbe({ fromRenderer: never, fromMain: never, timeoutMs: 20 });
    expect(r.via).toBe('main');
    expect(r.rendererError).toContain('did not answer within');
    expect(r.inference).toEqual({ error: expect.stringContaining('did not answer') as string });
  });

  it('writes the report as JSON, creating the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-smoke-'));
    try {
      const path = join(dir, 'nested', 'smoke-report.json');
      await writeSmokeReport(path, { inference: answer, via: 'renderer' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        inference: answer,
        via: 'renderer',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
