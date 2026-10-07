import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSP_PROBE, GLOBE_PROBE, RENDERER_PROBE, smokeProbe, writeSmokeReport } from './smoke';

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

  it('adds the CSP probe answer, or why it failed', async () => {
    const csp = { url: 'file:///index.html', meta: "script-src 'self'", eval: 'EvalError: x' };
    const r = await smokeProbe({
      csp: () => Promise.resolve(csp),
      fromRenderer: () => Promise.resolve(answer),
      fromMain: () => Promise.reject(new Error('not used')),
    });
    expect(r).toEqual({ inference: answer, via: 'renderer', csp });
    const failed = await smokeProbe({
      csp: () => Promise.reject(new Error('Script failed to execute')),
      fromRenderer: () => Promise.reject(new Error('no bridge')),
      fromMain: () => Promise.resolve(answer),
    });
    expect(failed.csp).toEqual({ error: 'Script failed to execute' });
    expect(failed.via).toBe('main');
  });

  it('probes eval in the page without DevTools evaluation', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the probe's own text
    const run = new Function(`return ${CSP_PROBE};`) as () => unknown;
    const doc = { querySelector: () => ({ getAttribute: () => 'policy' }) };
    const g = globalThis as Record<string, unknown>;
    g.document = doc;
    g.location = { href: 'file:///x/index.html' };
    try {
      expect(run()).toEqual({ url: 'file:///x/index.html', meta: 'policy', eval: 'allowed' });
    } finally {
      delete g.document;
      delete g.location;
    }
  });

  it('opens the Globe after the runtime answered, and reports a probe that fails or hangs', async () => {
    const order: string[] = [];
    const globe = { url: 'file:///index.html', ready: true, workers: ['w.js'], wasm: {} };
    const r = await smokeProbe({
      fromRenderer: () => {
        order.push('runtime');
        return Promise.resolve(answer);
      },
      fromMain: () => Promise.reject(new Error('not used')),
      globe: () => {
        order.push('globe');
        return Promise.resolve(globe);
      },
    });
    expect(r).toEqual({ inference: answer, via: 'renderer', globe });
    expect(order).toEqual(['runtime', 'globe']);
    const failed = await smokeProbe({
      fromRenderer: () => Promise.resolve(answer),
      fromMain: () => Promise.reject(new Error('not used')),
      globe: () => Promise.reject(new Error('Script failed to execute')),
    });
    expect(failed.globe).toEqual({ error: 'Script failed to execute' });
    const hung = await smokeProbe({
      fromRenderer: () => Promise.resolve(answer),
      fromMain: () => Promise.reject(new Error('not used')),
      globe: () => new Promise<unknown>(() => undefined),
      globeTimeoutMs: 20,
    });
    expect(hung.globe).toEqual({
      error: expect.stringContaining('The Globe probe did not answer') as string,
    });
  });

  it('the Globe probe is one script the window can run', () => {
    // compiled, not run: it needs the app's window
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the probe's own text
    expect(() => new Function(`return ${GLOBE_PROBE};`)).not.toThrow();
    expect(GLOBE_PROBE).toContain('cesium/ThirdParty/draco_decoder.wasm');
    expect(GLOBE_PROBE).toContain('__aioGlobe');
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
