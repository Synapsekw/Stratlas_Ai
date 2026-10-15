import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineerProposal, EngineerSetup } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  engineerCacheKey,
  estimateEngineerCostUsd,
  fileEngineerCache,
  imageSize,
  runEngineer,
  stripImageMetadata,
  type EngineerCall,
  type EngineerHost,
  type EngineerUsage,
} from './engineer';
import { PROMPT_VERSION } from './engineerPrompt';
import { describeError, InvalidProposalError } from './errors';
import { builtInProviders, createProviderRegistry } from './providers';
import type { ModelRoute } from './routes';

// ------------------------------------------------------------------ tiny real images

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function pngChunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)]);
}
/** A PNG with a text chunk that carries a file path (as some cameras and tools write). */
function png(w: number, h: number, text = 'Source\0C:\\Users\\someone\\IMG_0001.JPG'): string {
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(text, 'latin1')),
    pngChunk('IDAT', Buffer.from([1, 2, 3, 4])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
function seg(marker: number, data: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
}
/** A JPEG whose EXIF block carries free text and a path. */
function jpeg(w: number, h: number): string {
  const sof = Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0Owner note D:\\survey\\private.laz', 'latin1')),
    seg(0xfe, Buffer.from('comment: see /home/someone/scan.copc', 'latin1')),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

// ------------------------------------------------------------------ fixtures

function stackProposal(): EngineerProposal {
  return {
    family: { value: 'chimney', reasons: ['A tall round shaft with flues at the top.'] },
    identity: { sameAsset: true, conflicts: [] },
    components: [
      {
        role: 'shaft',
        kind: 'shaft',
        count: 1,
        units: 'ratio',
        params: { rBase: 0.05, rTop: 0.035, openTop: true, wall: 0.004 },
        imageIds: ['p1', 'side-1'],
        observed: true,
      },
      {
        role: 'flue',
        kind: 'flue',
        count: 3,
        units: 'ratio',
        params: { rOuter: 0.008, rInner: 0.006 },
        levels: [1],
        imageIds: ['p1'],
        observed: true,
        description: 'Three flues proud of the top.',
      },
    ],
    unresolved: ['Make and process duty unknown.'],
    notes: 'Concrete stack with three flues.',
  };
}

/** The proposal as the model sends it: params as name and value pairs, every field present. */
function wire(
  p: Omit<EngineerProposal, 'family'> & { family: { value: string; reasons: string[] } },
): unknown {
  return {
    ...p,
    components: p.components.map((c) => ({
      role: c.role,
      kind: c.kind,
      count: c.count,
      units: c.units,
      params: Object.entries(c.params).map(([name, value]) => ({ name, value })),
      levels: c.levels ?? [],
      imageIds: c.imageIds,
      observed: c.observed,
      description: c.description ?? '',
    })),
  };
}

const SETUP: EngineerSetup = {
  sources: {
    clouds: [{ layer: 'cloud-1' }],
    meshes: [],
    photos: [{ path: 'C:\\Users\\someone\\Pictures\\site\\IMG_0001.JPG' }],
  },
  family: 'auto',
  scope: 'asset',
  detail: 'standard',
  placement: 'unplaced',
};

function call(over: Partial<EngineerCall> = {}): EngineerCall {
  const images: EngineerCall['images'] = [
    { id: 'p1', kind: 'photo', dataUrl: jpeg(800, 600), bytes: 120 },
    { id: 'side-1', kind: 'side', dataUrl: png(512, 1024), bytes: 80, view: 'east' },
  ];
  return {
    projectId: 'proj-1',
    runId: 'run-a',
    pass: 1,
    images,
    summary: JSON.stringify({ heightM: null, slices: 12, note: 'top 10 percent occluded' }),
    setup: SETUP,
    ...over,
  };
}

// ------------------------------------------------------------------ provider fakes

type Provider = 'anthropic' | 'openai';
const MODELS: Record<Provider, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6-luna' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A provider-shaped reply carrying `obj` as the structured output. */
function reply(provider: Provider, url: string, body: Record<string, unknown>, obj: unknown) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (provider === 'anthropic') {
    const tools = body.tools as { name: string }[] | undefined;
    const tool = tools?.[0];
    return json(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODELS.anthropic,
      content: tool
        ? [{ type: 'tool_use', id: 'tu_1', name: tool.name, input: JSON.parse(text) as unknown }]
        : [{ type: 'text', text }],
      stop_reason: tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3000, output_tokens: 900 },
    });
  }
  if (url.includes('/chat/completions')) {
    return json(200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: MODELS.openai,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3000, completion_tokens: 900, total_tokens: 3900 },
    });
  }
  return json(200, {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: MODELS.openai,
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 3000,
      output_tokens: 900,
      total_tokens: 3900,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

interface MockOpts {
  provider?: Provider;
  model?: string;
  /** Replies in order (the last repeats); `status` answers with that HTTP error. */
  replies?: unknown[];
  reply?: unknown;
  offline?: boolean;
  key?: string | null;
  policy?: Partial<ReturnType<EngineerHost['policy']>>;
  cache?: Map<string, EngineerProposal>;
  spent?: number;
  budgetUsd?: number;
  signal?: AbortSignal;
  /** Hold every request until the signal aborts it. */
  hang?: boolean;
  resize?: EngineerHost['resize'];
  route?: Partial<ModelRoute>;
}

function mockHost(o: MockOpts = {}) {
  const provider = o.provider ?? 'anthropic';
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const keyReads: string[] = [];
  const usage: EngineerUsage[] = [];
  const cache = o.cache ?? new Map<string, EngineerProposal>();
  const replies = o.replies ?? [o.reply ?? wire(stackProposal())];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    bodies.push(body);
    if (o.hang) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      });
    }
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (typeof r === 'object' && r !== null && 'status' in r && typeof r.status === 'number') {
      return Promise.resolve(
        json(
          r.status,
          { error: { type: 'rate_limit_error', message: 'Too many requests.' } },
          {
            'retry-after': '0',
          },
        ),
      );
    }
    return Promise.resolve(reply(provider, url, body, r));
  };
  const offlineOnly = () => o.offline === true;
  const host: EngineerHost = {
    route: () => ({ task: 'engineer', provider, model: o.model ?? MODELS[provider], ...o.route }),
    key: (p) => {
      keyReads.push(p);
      return Promise.resolve(o.key === undefined ? 'sk-test-NOT-A-REAL-KEY-0123456789' : o.key);
    },
    offlineOnly,
    policy: () => ({ ai: 'allow', photos: true, scans: true, ...o.policy }),
    cache: {
      get: (k) => Promise.resolve(cache.get(k) ?? null),
      put: (k, p) => {
        cache.set(k, p);
        return Promise.resolve();
      },
    },
    spent: () => o.spent ?? 0,
    usage: (u) => usage.push(u),
    budgetUsd: o.budgetUsd ?? 2,
    signal: o.signal ?? new AbortController().signal,
    providers: createProviderRegistry(builtInProviders({ fetch, offlineOnly })),
    maxRetries: 0,
    ...(o.resize ? { resize: o.resize } : {}),
  };
  return { host, calls, bodies, keyReads, usage, cache };
}

/** Images in a provider request body, whatever the provider's part names. */
function countImages(body: unknown): number {
  return (JSON.stringify(body).match(/"type":"(image|input_image|image_url)"/g) ?? []).length;
}

// ------------------------------------------------------------------ tests

describe('runEngineer', () => {
  it.each(['anthropic', 'openai'] as const)(
    '%s returns a validated proposal through the same path',
    async (provider) => {
      const { host, calls, usage, bodies } = mockHost({ provider, reply: wire(stackProposal()) });
      const r = await runEngineer(call(), host);
      expect(r).toMatchObject({ kind: 'proposal', cached: false });
      if (r.kind !== 'proposal') return;
      expect(r.proposal).toEqual(stackProposal());
      expect(r.costUsd).toBeGreaterThan(0);
      // both use the provider's native JSON schema output, no tool-call convention
      expect(JSON.stringify(bodies[0])).toContain('"type":"json_schema"');
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatch(
        provider === 'anthropic'
          ? /^https:\/\/api\.anthropic\.com\//
          : /^https:\/\/api\.openai\.com\//,
      );
      expect(usage).toEqual([
        expect.objectContaining({
          projectId: 'proj-1',
          runId: 'run-a',
          provider,
          model: MODELS[provider],
          inputTokens: 3000,
          outputTokens: 900,
        }),
      ]);
    },
  );

  it('offline: refused, no request, no key read', async () => {
    const { host, calls, keyReads } = mockHost({ offline: true });
    expect(await runEngineer(call(), host)).toMatchObject({ kind: 'refused', code: 'offline' });
    expect(calls.length).toBe(0);
    expect(keyReads.length).toBe(0);
  });

  it('refuses an unknown cloud model before any request', async () => {
    const { host, calls, keyReads } = mockHost({ provider: 'openai', model: 'acme-vlm-2' });
    const r = await runEngineer(call(), host);
    expect(r).toMatchObject({ kind: 'refused', code: 'capability' });
    if (r.kind === 'refused') expect(r.reason).toContain('"Treat as vision model"');
    expect(calls.length + keyReads.length).toBe(0);
  });

  it('a project that forbids cloud AI is refused before any request', async () => {
    const { host, calls, keyReads } = mockHost({ policy: { ai: 'forbid' } });
    expect(await runEngineer(call(), host)).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(calls.length + keyReads.length).toBe(0);
  });

  it('photos without aiCloudPhotos are refused before any request', async () => {
    const { host, calls, keyReads } = mockHost({ policy: { photos: false } });
    const r = await runEngineer(call(), host);
    expect(r).toMatchObject({ kind: 'refused', code: 'policy' });
    if (r.kind === 'refused') expect(r.reason).toContain('photos');
    expect(calls.length + keyReads.length).toBe(0);
  });

  it('scan views without aiCloudScans are refused; photos alone then pass', async () => {
    const t = mockHost({ policy: { scans: false } });
    expect(await runEngineer(call(), t.host)).toMatchObject({ kind: 'refused', code: 'policy' });
    expect(t.calls.length).toBe(0);
    const generated = call({
      images: [{ id: 'g1', kind: 'generated', dataUrl: png(64, 64), bytes: 10 }],
    });
    expect(await runEngineer(generated, t.host)).toMatchObject({ kind: 'refused', code: 'policy' });
    const photosOnly = call({ images: call().images.filter((i) => i.kind === 'photo') });
    expect(await runEngineer(photosOnly, t.host)).toMatchObject({ kind: 'proposal' });
    expect(t.calls.length).toBe(1);
  });

  it('no key', async () => {
    const { host, calls } = mockHost({ key: null });
    const r = await runEngineer(call(), host);
    expect(r).toMatchObject({ kind: 'refused', code: 'no-key' });
    if (r.kind === 'refused')
      expect(r.reason).toBe('Add an Anthropic key in Settings, AI providers.');
    expect(calls.length).toBe(0);
  });

  it('invalid reply gets one repair, then fails as invalid without throwing', async () => {
    const bad = { ...stackProposal(), family: { value: 'windmill', reasons: [] } };
    const t = mockHost({ replies: [wire(bad), 'not json at all'] });
    const r = await runEngineer(call(), t.host);
    expect(r).toMatchObject({ kind: 'failed', code: 'invalid' });
    if (r.kind === 'failed') {
      expect(r.error).toContain('did not match the engineering proposal format');
      expect(r.error).not.toMatch(/[\u2013\u2014]/);
    }
    expect(t.calls.length).toBe(2);
    // the repair request names what was wrong
    expect(JSON.stringify(t.bodies[1])).toContain('did not match the schema');
    expect(JSON.stringify(t.bodies[1])).toContain('family.value');
    expect(t.cache.size).toBe(0);
    // both requests are metered
    expect(t.usage).toHaveLength(2);
  });

  it('a repaired reply is accepted', async () => {
    const bad = { ...stackProposal(), family: { value: 'windmill', reasons: [] } };
    const t = mockHost({ replies: [wire(bad), wire(stackProposal())] });
    expect(await runEngineer(call(), t.host)).toMatchObject({ kind: 'proposal' });
    expect(t.calls.length).toBe(2);
    expect(t.cache.size).toBe(1);
  });

  it('429 surfaces as rate-limit and keeps the cache empty', async () => {
    const t = mockHost({ replies: [{ status: 429 }] });
    const r = await runEngineer(call(), t.host);
    expect(r).toMatchObject({ kind: 'failed', code: 'rate-limit' });
    if (r.kind === 'failed') expect(r.error).toContain('busy or rate limited');
    expect(t.cache.size).toBe(0);
    expect(t.calls.length).toBe(1);
  });

  it('cancel aborts the fetch and returns cancelled', async () => {
    const ctl = new AbortController();
    const t = mockHost({ hang: true, signal: ctl.signal });
    const running = runEngineer(call(), t.host);
    await vi.waitFor(() => {
      expect(t.calls.length).toBe(1);
    });
    ctl.abort();
    expect(await running).toMatchObject({ kind: 'failed', code: 'cancelled' });
    expect(t.cache.size).toBe(0);
  });

  it('a cached reply is reused with no request (resume)', async () => {
    const cache = new Map<string, EngineerProposal>();
    const first = mockHost({ cache });
    expect(await runEngineer(call(), first.host)).toMatchObject({ cached: false });
    const again = mockHost({ cache });
    const r = await runEngineer(call(), again.host);
    expect(r).toMatchObject({ kind: 'proposal', cached: true, costUsd: 0 });
    expect(again.calls.length).toBe(0);
    expect(again.usage).toHaveLength(0);
  });

  it('a cached reply is still behind the offline and sharing gates', async () => {
    const cache = new Map<string, EngineerProposal>();
    await runEngineer(call(), mockHost({ cache }).host);
    expect(await runEngineer(call(), mockHost({ cache, offline: true }).host)).toMatchObject({
      kind: 'refused',
      code: 'offline',
    });
  });

  it('budget pre-flight refuses when spent plus estimate exceeds the cap', async () => {
    const route: ModelRoute = { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' };
    const estimate = estimateEngineerCostUsd(call(), route);
    expect(estimate).toBeGreaterThan(0);
    const t = mockHost({ spent: 2 - (estimate ?? 0) / 2, budgetUsd: 2 });
    const r = await runEngineer(call(), t.host);
    expect(r).toMatchObject({ kind: 'refused', code: 'budget' });
    if (r.kind === 'refused') expect(r.reason).toContain('AI cost cap of US$2.00');
    expect(t.calls.length).toBe(0);
  });

  it('at the cap with an earlier pass, returns the best result so far with a note', async () => {
    const t = mockHost({ spent: 1.99, budgetUsd: 2 });
    const r = await runEngineer(call({ pass: 2, previous: stackProposal() }), t.host);
    expect(r).toMatchObject({ kind: 'proposal', cached: false, costUsd: 0, stopped: 'budget' });
    if (r.kind === 'proposal') {
      expect(r.proposal.components).toEqual(stackProposal().components);
      expect(r.proposal.unresolved.at(-1)).toContain('AI cost cap');
    }
    expect(t.calls.length).toBe(0);
  });

  it('a model without a price needs the cost confirmed in the preview', async () => {
    const route = { treatAsVision: true };
    expect(
      estimateEngineerCostUsd(call(), {
        task: 'engineer',
        provider: 'openai',
        model: 'acme-vlm-2',
        ...route,
      }),
    ).toBeUndefined();
    const t = mockHost({ provider: 'openai', model: 'acme-vlm-2', route });
    const r = await runEngineer(call(), t.host);
    expect(r).toMatchObject({ kind: 'refused', code: 'budget' });
    if (r.kind === 'refused') expect(r.reason).toContain('price of this model is not known');
    expect(t.calls.length).toBe(0);
    const confirmed = mockHost({ provider: 'openai', model: 'acme-vlm-2', route });
    expect(await runEngineer(call({ costConfirmed: true }), confirmed.host)).toMatchObject({
      kind: 'proposal',
    });
    expect(confirmed.calls.length).toBe(1);
  });

  it('sends only the pack images and the summary (no arrays, no file paths of originals)', async () => {
    const { host, bodies } = mockHost({ provider: 'anthropic', reply: wire(stackProposal()) });
    await runEngineer(call(), host);
    const body = JSON.stringify(bodies[0]);
    expect(body).not.toMatch(/\.laz|\.copc|\\\\|C:\//i);
    expect(body).not.toContain('IMG_0001');
    expect(body).not.toContain('Pictures');
    expect(countImages(bodies[0])).toBe(call().images.length);
    expect(body).toContain('Image p1 (photo)');
    expect(body).toContain('Image side-1 (side, east)');
    expect(body).toContain('top 10 percent occluded');
  });

  it('strips image metadata (EXIF, comments, text chunks) before sending', async () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const { host, bodies } = mockHost({ provider });
      await runEngineer(call(), host);
      const decoded = [...JSON.stringify(bodies[0]).matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)]
        .map((m) => Buffer.from(m[0], 'base64').toString('latin1'))
        .join(' ');
      expect(decoded).toContain('JFIF');
      expect(decoded).not.toMatch(/Exif|private\.laz|scan\.copc|IMG_0001|someone/);
    }
  });

  it('redacts local paths that slip into the summary', async () => {
    const { host, bodies } = mockHost();
    await runEngineer(
      call({
        summary: 'cloud from E:\\Data\\site\\scan.laz and /home/someone/x.copc, height 41 m',
      }),
      host,
    );
    const body = JSON.stringify(bodies[0]);
    expect(body).not.toMatch(/scan\.laz|x\.copc|E:\\\\|\/home\//);
    expect(body).toContain('height 41 m');
  });

  it('downscales images over the model limit and refuses when it cannot', async () => {
    const big = call({
      images: [{ id: 'p1', kind: 'photo', dataUrl: png(4000, 3000), bytes: 9_000_000 }],
    });
    const resize = vi.fn((_d: string, maxPx: number) =>
      Promise.resolve(png(maxPx, Math.round((maxPx * 3) / 4))),
    );
    const t = mockHost({ resize });
    expect(await runEngineer(big, t.host)).toMatchObject({ kind: 'proposal' });
    expect(resize).toHaveBeenCalledWith(expect.any(String), 1568);
    const sent = JSON.stringify(t.bodies[0]);
    const decoded = [...sent.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)].map((m) =>
      imageSize(Buffer.from(m[0], 'base64')),
    );
    expect(decoded).toContainEqual({ w: 1568, h: 1176 });
    const without = mockHost();
    expect(await runEngineer(big, without.host)).toMatchObject({
      kind: 'refused',
      code: 'capability',
    });
    expect(without.calls.length).toBe(0);
  });

  it('sends at most the model image limit and says what was left out', async () => {
    const many = call({
      images: Array.from({ length: 10 }, (_, i) => ({
        id: `p${String(i)}`,
        kind: 'photo' as const,
        dataUrl: png(64, 64),
        bytes: 10,
      })),
    });
    const t = mockHost({ provider: 'openai', model: 'acme-vlm-2', route: { treatAsVision: true } });
    const r = await runEngineer({ ...many, costConfirmed: true }, t.host);
    expect(countImages(t.bodies[0])).toBe(8);
    expect(r).toMatchObject({ kind: 'proposal' });
    if (r.kind === 'proposal') expect(r.proposal.unresolved.at(-1)).toContain('2 images');
  });

  it('refuses an image id that is not a plain id', async () => {
    const t = mockHost();
    const r = await runEngineer(
      call({ images: [{ id: 'C:/x/y.jpg', kind: 'photo', dataUrl: png(8, 8), bytes: 1 }] }),
      t.host,
    );
    expect(r).toMatchObject({ kind: 'refused', code: 'capability' });
    expect(t.calls.length).toBe(0);
  });

  it('conflicting identity is returned, flagged, and not cached as success', async () => {
    const p = stackProposal();
    const conflicting: EngineerProposal = {
      ...p,
      identity: {
        sameAsset: false,
        conflicts: [{ imageIds: ['p1'], reason: 'A lattice tower, not the stack in the scan.' }],
      },
    };
    const t = mockHost({ reply: wire(conflicting) });
    const r = await runEngineer(call(), t.host);
    expect(r).toMatchObject({ kind: 'proposal', identityConflict: true });
    if (r.kind === 'proposal') expect(r.proposal.identity.conflicts[0]?.imageIds).toEqual(['p1']);
    expect(t.cache.size).toBe(0);
  });
});

describe('engineerCacheKey', () => {
  const route: ModelRoute = { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' };
  it('is stable and changes with every input that affects the reply', () => {
    const k = engineerCacheKey(call(), route);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(engineerCacheKey(call(), route)).toBe(k);
    const changed = [
      engineerCacheKey(call({ pass: 2 }), route),
      engineerCacheKey(call({ summary: 'other' }), route),
      engineerCacheKey(call({ setup: { ...SETUP, detail: 'detailed' } }), route),
      engineerCacheKey(call({ images: call().images.slice(0, 1) }), route),
      engineerCacheKey(
        call({
          images: [{ ...call().images[0], dataUrl: png(9, 9) } as EngineerCall['images'][0]],
        }),
        route,
      ),
      engineerCacheKey(call({ previous: stackProposal() }), route),
      engineerCacheKey(call(), { ...route, model: 'claude-sonnet-5-5' }),
      engineerCacheKey(call(), { ...route, provider: 'openai' }),
    ];
    for (const c of changed) expect(c).not.toBe(k);
    expect(new Set(changed).size).toBe(changed.length);
    expect(PROMPT_VERSION).toBe('eng-1');
  });

  it('does not change with the run id or project (resume in another run)', () => {
    expect(engineerCacheKey(call({ runId: 'run-b', projectId: 'p2' }), route)).toBe(
      engineerCacheKey(call(), route),
    );
  });
});

describe('fileEngineerCache', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes atomically, reads back, and treats a broken file as a miss', async () => {
    dir = await mkdtemp(join(tmpdir(), 'eng-cache-'));
    const cache = fileEngineerCache(join(dir, 'ai'));
    const key = 'a'.repeat(64);
    expect(await cache.get(key)).toBeNull();
    await cache.put(key, stackProposal());
    expect(await cache.get(key)).toEqual(stackProposal());
    expect((await readdir(join(dir, 'ai'))).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'ai', `${key}.json`), 'utf8'))).toMatchObject({
      promptVersion: PROMPT_VERSION,
    });
    await writeFile(join(dir, 'ai', `${key}.json`), '{"half":');
    expect(await cache.get(key)).toBeNull();
    // a key that is not a hash never becomes a path
    expect(await cache.get('../../escape')).toBeNull();
    await expect(cache.put('../../escape', stackProposal())).rejects.toThrow();
  });
});

describe('image helpers', () => {
  it('reads PNG and JPEG sizes', () => {
    const dims = (u: string) => imageSize(Buffer.from(u.split(',')[1] ?? '', 'base64'));
    expect(dims(png(512, 1024))).toEqual({ w: 512, h: 1024 });
    expect(dims(jpeg(800, 600))).toEqual({ w: 800, h: 600 });
  });

  it('keeps the image data when stripping metadata', () => {
    const bytes = Buffer.from(png(10, 20).split(',')[1] ?? '', 'base64');
    const out = stripImageMetadata(bytes, 'image/png');
    expect(imageSize(out)).toEqual({ w: 10, h: 20 });
    expect(out.toString('latin1')).toContain('IDAT');
    expect(out.toString('latin1')).not.toContain('tEXt');
  });
});

describe('describeError', () => {
  it('maps an invalid proposal to a clear message without the reply', () => {
    const d = describeError(new InvalidProposalError('family.value: invalid option "x"'), {
      label: 'OpenAI',
      model: 'gpt-6-luna',
    });
    expect(d.message).toContain('OpenAI gpt-6-luna');
    expect(d.message).toContain('did not match');
    expect(d.message).not.toContain('invalid option');
    expect(d.log).toContain('invalid option');
  });
});
