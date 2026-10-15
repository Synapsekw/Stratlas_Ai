import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { AiProvider, EngineerSetup, IpcEvent, IpcRequest } from '@aio/schema';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIME_USED_UP } from './engineer';
import { createAgentRuntime, MESSAGES, type AgentRuntimeHost, type StepUsage } from './main';
import { createProviderRegistry, type ModelProvider } from './providers';
import type { ModelRoute } from './routes';
import { createScriptedProvider } from './scripted';

type AiEvent = IpcEvent<'ai:event'>;

/** An 8 x 8 PNG (header only: the scripted model never decodes it). */
const PNG = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('IEND', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
]).toString('base64')}`;

const SETUP: EngineerSetup = {
  sources: { clouds: [], meshes: [], photos: [] },
  family: 'auto',
  scope: 'asset',
  detail: 'standard',
  placement: 'unplaced',
};

function request(over: Partial<IpcRequest<'ai:engineer'>> = {}): IpcRequest<'ai:engineer'> {
  return {
    runId: 'ipc-1',
    projectId: 'p1',
    engineerRun: 'run-a',
    pass: 1,
    images: [
      { id: 'p1', kind: 'photo', dataUrl: PNG, bytes: 40 },
      { id: 'side-1', kind: 'side', dataUrl: PNG, bytes: 40, view: 'east' },
    ],
    summary: JSON.stringify({ slices: 12 }),
    setup: SETUP,
    ...over,
  };
}

function preview(r: IpcRequest<'ai:engineer'>): IpcRequest<'ai:engineerPreview'> {
  return {
    projectId: r.projectId,
    engineerRun: r.engineerRun,
    pass: r.pass,
    images: r.images,
    summary: r.summary,
    setup: r.setup,
    ...(r.previous ? { previous: r.previous } : {}),
  };
}

interface Opts {
  provider?: 'anthropic' | 'openai';
  flags?: { photos: boolean; scans: boolean };
  ai?: 'allow' | 'forbid';
  offline?: boolean;
  cloud?: boolean;
  cacheDir?: string;
  model?: LanguageModelV4;
  now?: () => number;
  open?: boolean;
}

function setup(o: Opts = {}) {
  const provider = o.provider ?? 'anthropic';
  let requests = 0;
  const scripted = createScriptedProvider(provider, true, {
    onGenerate: () => {
      requests += 1;
    },
  });
  const model = o.model;
  const custom: ModelProvider | null = model ? { ...scripted, languageModel: () => model } : null;
  const events: AiEvent[] = [];
  const recorded: { projectId: string; usage: StepUsage }[] = [];
  const getKey = vi.fn<(p: AiProvider) => Promise<string | null>>(() => Promise.resolve(null));
  const policyReads: string[] = [];
  const route: ModelRoute = {
    task: 'vision',
    provider,
    model: provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6-luna',
  };
  const host: AgentRuntimeHost = {
    getKey,
    cloudAllowed: () => o.cloud ?? true,
    offlineOnly: () => o.offline === true,
    emit: (e) => events.push(e),
    routes: () => [route],
    recordUsage: (projectId, usage) => recorded.push({ projectId, usage }),
    engineer: {
      policy: (projectId) => {
        policyReads.push(projectId);
        if (o.open === false) return Promise.resolve(null);
        return Promise.resolve({
          ai: o.ai ?? 'allow',
          ...(o.flags ?? { photos: false, scans: false }),
        });
      },
      cacheDir: (_p, run) => (o.cacheDir ? join(o.cacheDir, run, 'ai') : undefined),
      ...(o.now ? { now: o.now } : {}),
    },
  };
  const runtime = createAgentRuntime(host, {
    providers: createProviderRegistry([custom ?? scripted]),
    maxRetries: 0,
  });
  return { runtime, events, recorded, getKey, policyReads, requests: () => requests };
}

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

const ALLOWED = { photos: true, scans: true };

describe('ai:engineer', () => {
  it.each(['anthropic', 'openai'] as const)(
    '%s: returns a proposal, emits usage and records it to the project',
    async (provider) => {
      const t = setup({ provider, flags: ALLOWED });
      const r = await t.runtime.engineer(request());
      expect(r).toMatchObject({
        kind: 'proposal',
        cached: false,
        proposal: { family: { value: 'chimney' } },
      });
      expect(t.requests()).toBe(1);
      expect(t.events).toEqual([
        expect.objectContaining({ type: 'usage', runId: 'ipc-1', provider }),
      ]);
      expect(t.recorded).toHaveLength(1);
      expect(t.recorded[0]).toMatchObject({
        projectId: 'p1',
        usage: { provider, inputTokens: 1200, outputTokens: 150 },
      });
    },
  );

  it('offline: refused, nothing sent, no key read', async () => {
    const t = setup({ offline: true, flags: ALLOWED });
    expect(await t.runtime.engineer(request())).toEqual({
      kind: 'refused',
      code: 'offline',
      reason: MESSAGES.offlineOnly,
    });
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('cloud AI off: refused before any key read', async () => {
    const t = setup({ cloud: false, flags: ALLOWED });
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('a project that forbids cloud AI is refused before any key read', async () => {
    const t = setup({ ai: 'forbid', flags: ALLOWED });
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('refuses photos when the flag on disk is off, whatever the renderer claims', async () => {
    const t = setup({ flags: { photos: false, scans: true } });
    const r = await t.runtime.engineer(
      request({ consent: { token: 'made-up', photos: true, scans: true } }),
    );
    expect(r).toMatchObject({ kind: 'refused', code: 'policy' });
    if (r.kind === 'refused') expect(r.reason).toContain('photos');
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
    // the flags are read from disk for every request
    expect(t.policyReads).toEqual(['p1']);
  });

  it('a one-time consent from the preview counts once, for that content only', async () => {
    const t = setup({ flags: { photos: false, scans: false } });
    const p = await t.runtime.engineerPreview(preview(request()));
    if (!p.ok) throw new Error(p.error);
    expect(p.flags).toEqual({ photos: false, scans: false });
    const consent = { token: p.consent, photos: true, scans: true };
    // another content with this token: refused (and the token is spent)
    expect(await t.runtime.engineer(request({ summary: '{"slices":13}', consent }))).toMatchObject({
      kind: 'refused',
      code: 'policy',
    });
    const again = await t.runtime.engineerPreview(preview(request()));
    if (!again.ok) throw new Error(again.error);
    const once = { token: again.consent, photos: true, scans: true };
    expect(await t.runtime.engineer(request({ consent: once }))).toMatchObject({
      kind: 'proposal',
    });
    // the same token a second time: not valid any more
    expect(
      await t.runtime.engineer(request({ runId: 'ipc-2', pass: 2, consent: once })),
    ).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(t.requests()).toBe(1);
  });

  it('a one-time consent covers only the kinds ticked', async () => {
    const t = setup({ flags: { photos: false, scans: false } });
    const p = await t.runtime.engineerPreview(preview(request()));
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.engineer(
      request({ consent: { token: p.consent, photos: true, scans: false } }),
    );
    expect(r).toMatchObject({ kind: 'refused', code: 'policy' });
    if (r.kind === 'refused') expect(r.reason).toContain('scan views');
  });

  it('a consent for the project needs no token', async () => {
    const t = setup({ flags: ALLOWED });
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'proposal' });
  });

  it('the preview shows what is sent and sends nothing', async () => {
    const t = setup({ flags: { photos: true, scans: false } });
    const p = await t.runtime.engineerPreview(preview(request()));
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({
      route: { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' },
      cloud: true,
      flags: { photos: true, scans: false },
    });
    expect(p.estimateUsd).toBeGreaterThan(0);
    expect(p.content.images.map((im) => [im.id, im.kind])).toEqual([
      ['p1', 'photo'],
      ['side-1', 'side'],
    ]);
    expect(p.content.text).toContain('"slices":12');
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('cancel mid-call returns cancelled', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const hanging: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'scripted',
      modelId: 'claude-opus-5-5',
      supportedUrls: {},
      doGenerate: (opts) =>
        new Promise((_, reject) => {
          started();
          opts.abortSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      doStream: () => Promise.reject(new Error('not used')),
    };
    const t = setup({ flags: ALLOWED, model: hanging });
    const running = t.runtime.engineer(request());
    await begun;
    t.runtime.cancel('ipc-1');
    expect(await running).toMatchObject({ kind: 'failed', code: 'cancelled' });
  });

  it('one request in flight per run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const scripted = createScriptedProvider('anthropic').languageModel('claude-opus-5-5', null);
    if (typeof scripted === 'string') throw new Error('unexpected');
    const slow: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'scripted',
      modelId: 'claude-opus-5-5',
      supportedUrls: {},
      doGenerate: async (opts) => {
        started();
        await gate;
        return (scripted as LanguageModelV4).doGenerate(opts);
      },
      doStream: () => Promise.reject(new Error('not used')),
    };
    const t = setup({ flags: ALLOWED, model: slow });
    const first = t.runtime.engineer(request({ runId: 'ipc-1' }));
    await begun;
    expect(await t.runtime.engineer(request({ runId: 'ipc-2' }))).toMatchObject({
      kind: 'refused',
      code: 'busy',
    });
    // the same IPC run id is busy too
    expect(await t.runtime.engineer(request({ runId: 'ipc-1', pass: 2 }))).toMatchObject({
      kind: 'refused',
      code: 'busy',
    });
    // another engineering run is not held up by this one
    const other = t.runtime.engineer(request({ runId: 'ipc-3', engineerRun: 'run-b' }));
    release();
    expect(await first).toMatchObject({ kind: 'proposal' });
    expect(await other).toMatchObject({ kind: 'proposal' });
    // and once the first is back, the run takes the next request
    expect(await t.runtime.engineer(request({ runId: 'ipc-4', pass: 2 }))).toMatchObject({
      kind: 'proposal',
    });
  });

  it('the run has 10 minutes of AI time in all', async () => {
    let now = 1_000_000;
    const t = setup({ flags: ALLOWED, now: () => now });
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'proposal' });
    now += 9 * 60_000;
    expect(await t.runtime.engineer(request({ pass: 2 }))).toMatchObject({ kind: 'proposal' });
    now += 61_000;
    expect(await t.runtime.engineer(request({ pass: 3 }))).toEqual({
      kind: 'refused',
      code: 'time',
      reason: TIME_USED_UP,
    });
    // a new run starts its own time
    expect(await t.runtime.engineer(request({ engineerRun: 'run-b' }))).toMatchObject({
      kind: 'proposal',
    });
    expect(t.requests()).toBe(3);
  });

  it('a cache hit makes no request, also after a restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'eng-ipc-'));
    const a = setup({ flags: ALLOWED, cacheDir: dir });
    expect(await a.runtime.engineer(request())).toMatchObject({ cached: false });
    expect(a.requests()).toBe(1);
    expect(await readdir(join(dir, 'run-a', 'ai'))).toHaveLength(1);
    const b = setup({ flags: ALLOWED, cacheDir: dir });
    expect(await b.runtime.engineer(request())).toMatchObject({ kind: 'proposal', cached: true });
    expect(b.requests()).toBe(0);
    expect(b.events).toEqual([]);
  });

  it('a project that is not open is refused', async () => {
    const t = setup({ open: false });
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(await t.runtime.engineerPreview(preview(request()))).toMatchObject({ ok: false });
  });

  it('scripted replies through the IPC: flare, invalid then valid, rate limit', async () => {
    const t = setup({ flags: ALLOWED });
    expect(
      await t.runtime.engineer(request({ summary: '{"note":"#engineer flare"}' })),
    ).toMatchObject({ kind: 'proposal', proposal: { family: { value: 'flare' } } });
    expect(
      await t.runtime.engineer(
        request({ runId: 'ipc-2', summary: '{"note":"#engineer invalid"}' }),
      ),
    ).toMatchObject({ kind: 'proposal', proposal: { family: { value: 'chimney' } } });
    expect(
      await t.runtime.engineer(
        request({ runId: 'ipc-3', summary: '{"note":"#engineer rate-limit"}' }),
      ),
    ).toMatchObject({ kind: 'failed', code: 'rate-limit' });
  });
});
