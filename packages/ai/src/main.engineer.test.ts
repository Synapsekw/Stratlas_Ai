import type { LanguageModelV4 } from '@ai-sdk/provider';
import {
  ipc,
  type AiProvider,
  type EngineerSetup,
  type IpcEvent,
  type IpcRequest,
} from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIME_USED_UP } from './engineer';
import { readRunSpend, SPEND_SCHEMA } from './engineerSpend';
import {
  createAgentRuntime,
  MESSAGES,
  type AgentRuntime,
  type AgentRuntimeHost,
  type StepUsage,
} from './main';
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

/** The project folder of the tests: runs `run-a` and `run-b` are saved (their run.json). */
let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eng-ipc-'));
  for (const run of ['run-a', 'run-b']) {
    await mkdir(join(root, 'engineering', run), { recursive: true });
    await writeFile(join(root, 'engineering', run, 'run.json'), '{}');
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const runDir = (run = 'run-a') => join(root, 'engineering', run);

interface Opts {
  provider?: 'anthropic' | 'openai';
  flags?: { photos: boolean; scans: boolean };
  ai?: 'allow' | 'forbid';
  offline?: boolean;
  cloud?: boolean;
  model?: LanguageModelV4;
  now?: () => number;
  open?: boolean;
  unreadable?: boolean;
  /** Runs inside every model request (a test moves its clock while the request is in flight). */
  onGenerate?: () => void;
}

function setup(o: Opts = {}) {
  const provider = o.provider ?? 'anthropic';
  let requests = 0;
  const scripted = createScriptedProvider(provider, true, {
    onGenerate: () => {
      requests += 1;
      o.onGenerate?.();
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
        if (o.unreadable) return Promise.resolve({ error: 'The manifest could not be read.' });
        return Promise.resolve({
          ai: o.ai ?? 'allow',
          ...(o.flags ?? { photos: false, scans: false }),
        });
      },
      runDir: (_projectId, run) => (o.open === false ? undefined : join(root, 'engineering', run)),
      ...(o.now ? { now: o.now } : {}),
    },
  };
  const runtime = createAgentRuntime(host, {
    providers: createProviderRegistry([custom ?? scripted]),
    maxRetries: 0,
  });
  return { runtime, events, recorded, getKey, policyReads, requests: () => requests };
}

/** Through the send preview, as the app does: its token, with the boxes ticked in `once`. */
async function send(
  runtime: AgentRuntime,
  req: IpcRequest<'ai:engineer'>,
  once: { photos: boolean; scans: boolean } = { photos: false, scans: false },
) {
  const p = await runtime.engineerPreview(preview(req));
  if (!p.ok) throw new Error(p.error);
  return runtime.engineer({ ...req, consent: { token: p.consent, ...once } });
}

const ALLOWED = { photos: true, scans: true };

describe('ai:engineer', () => {
  it.each(['anthropic', 'openai'] as const)(
    '%s: returns a proposal, emits usage and records it to the project',
    async (provider) => {
      const t = setup({ provider, flags: ALLOWED });
      const r = await send(t.runtime, request());
      expect(r).toMatchObject({
        kind: 'proposal',
        cached: false,
        proposal: { family: { value: 'chimney' } },
        // the outcome carries the tokens, so the run can add them up
        usage: { inputTokens: 1200, outputTokens: 150 },
      });
      // and passes the IPC contract with them (the schema keeps the field)
      expect(ipc['ai:engineer'].response.parse(r)).toMatchObject({
        usage: { inputTokens: 1200, outputTokens: 150 },
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
    expect(await send(t.runtime, request())).toEqual({
      kind: 'refused',
      code: 'offline',
      reason: MESSAGES.offlineOnly,
    });
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('cloud AI off: refused before any key read', async () => {
    const t = setup({ cloud: false, flags: ALLOWED });
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('a project that forbids cloud AI is refused before any key read', async () => {
    const t = setup({ ai: 'forbid', flags: ALLOWED });
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('an unreadable manifest refuses with its reason, in the preview too', async () => {
    const t = setup({ unreadable: true });
    expect(await t.runtime.engineer(request())).toEqual({
      kind: 'refused',
      code: 'policy',
      reason: 'The manifest could not be read.',
    });
    expect(await t.runtime.engineerPreview(preview(request()))).toEqual({
      ok: false,
      error: 'The manifest could not be read.',
    });
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('every cloud request needs a token from the preview, also with both consents on', async () => {
    const t = setup({ flags: ALLOWED });
    for (const req of [request(), request({ images: [] })]) {
      const r = await t.runtime.engineer(req);
      expect(r).toMatchObject({ kind: 'refused', code: 'policy' });
      if (r.kind === 'refused') expect(r.reason).toContain('send preview');
      expect(
        await t.runtime.engineer({
          ...req,
          consent: { token: 'made-up', photos: true, scans: true },
        }),
      ).toMatchObject({ kind: 'refused', code: 'policy' });
    }
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
    expect(await send(t.runtime, request({ images: [] }))).toMatchObject({ kind: 'proposal' });
  });

  it('refuses photos when the flag on disk is off, whatever the renderer claims', async () => {
    const t = setup({ flags: { photos: false, scans: true } });
    const r = await send(t.runtime, request());
    expect(r).toMatchObject({ kind: 'refused', code: 'policy' });
    if (r.kind === 'refused') expect(r.reason).toContain('photos');
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
    // the flags are read from disk for every request (preview, then the request)
    expect(t.policyReads).toEqual(['p1', 'p1']);
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
    const r = await send(t.runtime, request(), { photos: true, scans: false });
    expect(r).toMatchObject({ kind: 'refused', code: 'policy' });
    if (r.kind === 'refused') expect(r.reason).toContain('scan views');
  });

  it('the project consents spare the boxes, not the preview', async () => {
    const t = setup({ flags: ALLOWED });
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'proposal' });
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
    const running = send(t.runtime, request());
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
    const first = send(t.runtime, request({ runId: 'ipc-1' }));
    await begun;
    expect(await send(t.runtime, request({ runId: 'ipc-2' }))).toMatchObject({
      kind: 'refused',
      code: 'busy',
    });
    // the same IPC run id is busy too
    expect(await send(t.runtime, request({ runId: 'ipc-1', pass: 2 }))).toMatchObject({
      kind: 'refused',
      code: 'busy',
    });
    // another engineering run is not held up by this one
    const other = send(t.runtime, request({ runId: 'ipc-3', engineerRun: 'run-b' }));
    release();
    expect(await first).toMatchObject({ kind: 'proposal' });
    expect(await other).toMatchObject({ kind: 'proposal' });
    // and once the first is back, the run takes the next request
    expect(await send(t.runtime, request({ runId: 'ipc-4', pass: 2 }))).toMatchObject({
      kind: 'proposal',
    });
  });

  it('the run has 10 minutes of AI time in all, counted while requests are in flight', async () => {
    let now = 1_000_000;
    // every request takes 5 minutes
    const slow = { flags: ALLOWED, now: () => now, onGenerate: () => (now += 5 * 60_000) };
    const t = setup(slow);
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'proposal' });
    expect((await readRunSpend(runDir()))?.aiMs).toBe(5 * 60_000);
    // an hour reading the send preview does not count; a new runtime (a restart) keeps the time
    now += 60 * 60_000;
    const after = setup(slow);
    expect(await send(after.runtime, request({ pass: 2 }))).toMatchObject({ kind: 'proposal' });
    expect((await readRunSpend(runDir()))?.aiMs).toBe(10 * 60_000);
    const p = await after.runtime.engineerPreview(preview(request({ pass: 3 })));
    if (!p.ok) throw new Error(p.error);
    const consent = { token: p.consent, photos: false, scans: false };
    expect(await after.runtime.engineer(request({ pass: 3, consent }))).toEqual({
      kind: 'refused',
      code: 'time',
      reason: TIME_USED_UP,
    });
    // a token is bound to its run: run-a's does not open run-b
    expect(
      await after.runtime.engineer(request({ pass: 3, engineerRun: 'run-b', consent })),
    ).toMatchObject({ kind: 'refused', code: 'policy' });
    // a new run starts its own time
    expect(await send(after.runtime, request({ engineerRun: 'run-b' }))).toMatchObject({
      kind: 'proposal',
    });
    expect(t.requests() + after.requests()).toBe(3);
  });

  it('a request that sends nothing does not start the run clock', async () => {
    let now = 1_000_000;
    const t = setup({ flags: ALLOWED, now: () => now });
    // no send preview: refused before anything is sent
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(await readRunSpend(runDir())).toBeNull();
    now += 30 * 60_000;
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'proposal' });
    // the clock starts with the first metered request
    expect(await readRunSpend(runDir())).toMatchObject({ startedAt: now, calls: 1 });
  });

  it('the last request a run may make gets no repair', async () => {
    await mkdir(join(runDir(), 'ai'), { recursive: true });
    // standard: 4 requests in all, 3 made
    const spend = { startedAt: Date.now(), spentUsd: 0, calls: 3, tokens: 10, unpriced: 0 };
    await writeFile(
      join(runDir(), 'ai', 'spend.json'),
      JSON.stringify({ schema: SPEND_SCHEMA, ...spend }),
    );
    const t = setup({ flags: ALLOWED });
    const r = await send(t.runtime, request({ summary: '{"note":"#engineer invalid"}' }));
    expect(r).toMatchObject({ kind: 'failed', code: 'invalid' });
    expect(t.requests()).toBe(1);
    expect((await readRunSpend(runDir()))?.calls).toBe(4);
  });

  it('the spend of a run is kept in the project and survives a restart', async () => {
    const a = setup({ flags: ALLOWED });
    const first = await send(a.runtime, request());
    if (first.kind !== 'proposal') throw new Error(first.kind);
    const once = await readRunSpend(runDir());
    expect(once).toMatchObject({ calls: 1, tokens: 1350, unpriced: 0 });
    expect(once?.spentUsd).toBeCloseTo(first.costUsd, 10);
    const b = setup({ flags: ALLOWED });
    expect(await send(b.runtime, request({ pass: 2 }))).toMatchObject({ kind: 'proposal' });
    const twice = await readRunSpend(runDir());
    expect(twice).toMatchObject({ calls: 2, tokens: 2700 });
    expect(twice?.spentUsd).toBeCloseTo(2 * first.costUsd, 10);
    expect((await readdir(join(runDir(), 'ai'))).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a run at its cost cap on disk is refused, whatever the runtime remembers', async () => {
    await mkdir(join(runDir(), 'ai'), { recursive: true });
    const spend = { startedAt: Date.now(), spentUsd: 1.9999, calls: 1, tokens: 10, unpriced: 0 };
    await writeFile(
      join(runDir(), 'ai', 'spend.json'),
      JSON.stringify({ schema: SPEND_SCHEMA, ...spend }),
    );
    const t = setup({ flags: ALLOWED });
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'refused', code: 'budget' });
    expect(t.requests()).toBe(0);
  });

  it('a run that has made all its requests is refused, also with an unknown price', async () => {
    await mkdir(join(runDir(), 'ai'), { recursive: true });
    const spend = { startedAt: Date.now(), spentUsd: 0, calls: 4, tokens: 10, unpriced: 4 };
    await writeFile(
      join(runDir(), 'ai', 'spend.json'),
      JSON.stringify({ schema: SPEND_SCHEMA, ...spend }),
    );
    const t = setup({ flags: ALLOWED });
    const r = await send(t.runtime, request({ costConfirmed: true }));
    expect(r).toMatchObject({ kind: 'refused', code: 'budget' });
    if (r.kind === 'refused') expect(r.reason).toContain('all the AI requests');
  });

  it('a spend record that cannot be read refuses rather than starting again', async () => {
    await mkdir(join(runDir(), 'ai'), { recursive: true });
    await writeFile(join(runDir(), 'ai', 'spend.json'), '{"schema":');
    const t = setup({ flags: ALLOWED });
    expect(await send(t.runtime, request())).toMatchObject({ kind: 'refused', code: 'budget' });
    expect(await readFile(join(runDir(), 'ai', 'spend.json'), 'utf8')).toBe('{"schema":');
  });

  it('a run that is not saved in the project is refused', async () => {
    const t = setup({ flags: ALLOWED });
    const r = await send(t.runtime, request({ engineerRun: 'run-unknown' }));
    expect(r).toMatchObject({ kind: 'refused', code: 'capability' });
    if (r.kind === 'refused') expect(r.reason).toContain('not saved');
    expect(t.requests()).toBe(0);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('a cache hit makes no request, also after a restart', async () => {
    const a = setup({ flags: ALLOWED });
    expect(await send(a.runtime, request())).toMatchObject({ cached: false });
    expect(a.requests()).toBe(1);
    expect((await readdir(join(runDir(), 'ai'))).filter((f) => f !== 'spend.json')).toHaveLength(1);
    const b = setup({ flags: ALLOWED });
    expect(await send(b.runtime, request())).toMatchObject({ kind: 'proposal', cached: true });
    expect(b.requests()).toBe(0);
    expect(b.events).toEqual([]);
  });

  it('a project that is not open is refused', async () => {
    const t = setup({ open: false });
    expect(await t.runtime.engineer(request())).toMatchObject({ kind: 'refused' });
    expect(await t.runtime.engineerPreview(preview(request()))).toMatchObject({ ok: false });
  });

  it('scripted replies through the IPC: flare, invalid then valid, rate limit', async () => {
    const t = setup({ flags: ALLOWED });
    expect(await send(t.runtime, request({ summary: '{"note":"#engineer flare"}' }))).toMatchObject(
      { kind: 'proposal', proposal: { family: { value: 'flare' } } },
    );
    expect(
      await send(t.runtime, request({ runId: 'ipc-2', summary: '{"note":"#engineer invalid"}' })),
    ).toMatchObject({ kind: 'proposal', proposal: { family: { value: 'chimney' } } });
    expect(
      await send(
        t.runtime,
        request({ runId: 'ipc-3', summary: '{"note":"#engineer rate-limit"}' }),
      ),
    ).toMatchObject({ kind: 'failed', code: 'rate-limit' });
  });
});
