import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { AiProvider, IpcRequest } from '@aio/schema';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  DETECT_MARKER,
  DETECT_PROMPT_VERSION,
  detectInstructions,
  detectUserText,
  estimateDetect,
  extractJson,
  imageTokens,
  parseDetectReply,
  planBatches,
  sendSize,
} from './detect';
import { createAgentRuntime, MESSAGES, type AgentRuntimeHost } from './main';
import { createProviderRegistry, type ModelProvider } from './providers';
import { createScriptedProvider, scriptedDetections } from './scripted';

const classes = [
  { id: 'moderate', label: 'Moderate visible rust' },
  { id: 'heavy', label: 'Heavy visible deterioration' },
];
const severity = {
  levels: [
    { value: 1, label: 'Light' },
    { value: 2, label: 'Moderate' },
    { value: 3, label: 'Heavy' },
  ],
  uncertain: true,
};

describe('batching and the estimate', () => {
  it('splits into batches of at most the size, capped at 8', () => {
    expect(planBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], 4).map((b) => b.length)).toEqual([4, 4, 1]);
    expect(
      planBatches(
        Array.from({ length: 20 }, (_, i) => i),
        50,
      ).map((b) => b.length),
    ).toEqual([8, 8, 4]);
    expect(planBatches([1, 2], 0)).toEqual([[1], [2]]);
    expect(planBatches([], 4)).toEqual([]);
  });

  it('scales images to the send size, never up', () => {
    expect(sendSize(2560, 1708)).toEqual([1568, 1046]);
    expect(sendSize(800, 600)).toEqual([800, 600]);
  });

  it('counts image tokens per provider', () => {
    expect(imageTokens('anthropic', 1568, 1046)).toBe(Math.ceil((1568 * 1046) / 750));
    // 1568 x 1046 fits 2048, shortest side to 768: 1151 x 768, 3 x 2 tiles
    expect(imageTokens('openai', 1568, 1046)).toBe(85 + 170 * 6);
    expect(imageTokens('google', 300, 200)).toBe(258);
    expect(imageTokens('google', 1568, 1046)).toBe(258 * 3 * 2);
  });

  it('estimates tokens and cost for a run, free for a local model', () => {
    const images = Array.from({ length: 10 }, () => ({ width: 2560, height: 1708 }));
    const e = estimateDetect({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      images,
      prompt: { classes, severity },
      batchSize: 4,
    });
    expect(e.requests).toBe(3);
    expect(e.inputTokens).toBeGreaterThan(10 * 2186);
    expect(e.outputTokens).toBe(3 * 40 + 10 * 160);
    expect(e.costUsd).toBeCloseTo((e.inputTokens * 4 + e.outputTokens * 20) / 1e6, 6);
    expect(
      estimateDetect({ provider: 'local', model: 'x', images, prompt: { classes } }).costUsd,
    ).toBe(0);
    expect(
      estimateDetect({ provider: 'openai', model: 'unknown-model', images, prompt: { classes } })
        .costUsd,
    ).toBeUndefined();
  });
});

describe('prompt', () => {
  it('lists classes and severity levels and asks for normalised JSON', () => {
    const p = detectInstructions({ classes, severity });
    expect(p).toContain('"id":"moderate"');
    expect(p).toContain('Severity levels (JSON, use the value)');
    expect(p).toContain('"uncertain": true');
    expect(p).not.toMatch(/[–—]/);
    expect(detectUserText(3, ' flange bolts ')).toBe(
      `${DETECT_MARKER}\nThere are 3 images, numbered 1 to 3 in the order attached. Report the defects in each.\nFocus: flange bolts`,
    );
  });
});

describe('reply parser', () => {
  it('reads fenced JSON, maps classes by id or label and clamps coordinates', () => {
    const text =
      'Here you go:\n```json\n{"images":[{"image":1,"detections":[' +
      '{"class":"Moderate","box":[0.1,0.2,0.3,0.4],"confidence":0.7,"severity":2},' +
      '{"class":"heavy visible deterioration","box":[-0.2,0.5,0.3,1.4],"severity":null,"uncertain":true},' +
      '{"class":"stain","polygon":[[0,0],[1,0],[1,1]],"note":" faint "}' +
      ']},{"image":2,"detections":[]}]}\n```';
    const r = parseDetectReply(text, 2, classes);
    if (typeof r === 'string') throw new Error(r);
    expect(r.results[0]).toEqual([
      {
        classId: 'moderate',
        label: 'Moderate',
        box: [0.1, 0.2, 0.3, 0.4],
        confidence: 0.7,
        severity: 2,
      },
      {
        classId: 'heavy',
        label: 'heavy visible deterioration',
        box: [0, 0.5, 0.3, 1],
        severity: null,
        uncertain: true,
      },
      {
        classId: '',
        label: 'stain',
        polygon: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        note: 'faint',
      },
    ]);
    expect(r.results[1]).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('skips proposals without a shape and images that were not sent, with warnings', () => {
    const r = parseDetectReply(
      '{"images":[{"image":1,"detections":[{"class":"moderate"}]},{"image":5,"detections":[]}]}',
      1,
      classes,
    );
    if (typeof r === 'string') throw new Error(r);
    expect(r.results).toEqual([[]]);
    expect(r.warnings).toHaveLength(2);
  });

  it('refuses an answer that is not the format, quoting it', () => {
    expect(parseDetectReply('Sorry, I cannot help.', 1, classes)).toBe(
      'The model did not answer in the detection format: "Sorry, I cannot help."',
    );
    expect(extractJson('no json')).toBeUndefined();
  });
});

const image = (key: string) => ({
  key,
  dataUrl: 'data:image/jpeg;base64,/9j/AA==',
  width: 100,
  height: 80,
});
const detectReq = (over: Partial<IpcRequest<'ai:detect'>> = {}): IpcRequest<'ai:detect'> => ({
  runId: 'd1',
  projectId: 'ebsm',
  classes,
  severity,
  images: [image('photo:photos:p001'), image('photo:photos:p002')],
  ...over,
});

function host(over: Partial<AgentRuntimeHost> = {}): AgentRuntimeHost {
  return {
    getKey: () => Promise.resolve('sk-test-key-0123456789'),
    cloudAllowed: () => true,
    emit: () => undefined,
    ...over,
  };
}

function withModel(model: MockLanguageModelV4, over: Partial<AgentRuntimeHost> = {}) {
  const provider: ModelProvider = {
    id: 'anthropic',
    label: 'Anthropic',
    cloud: true,
    needsKey: true,
    languageModel: () => model,
  };
  return createAgentRuntime(host(over), {
    providers: createProviderRegistry([provider]),
    maxRetries: 0,
  });
}

const reply = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'end_turn' },
  usage: {
    inputTokens: { total: 5000, noCache: 5000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 300, text: 300, reasoning: 0 },
  },
  warnings: [],
});

describe('detect in the main runtime', () => {
  it('sends instructions, numbered images and the marker, and returns proposals per key', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'claude-opus-5-5',
      doGenerate: reply(
        '{"images":[{"image":2,"detections":[{"class":"moderate","box":[0.1,0.1,0.2,0.2],"confidence":0.8}]}]}',
      ),
    });
    const recordUsage = vi.fn();
    const rt = withModel(model, { recordUsage });
    const r = await rt.detect(detectReq());
    expect(r).toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: DETECT_PROMPT_VERSION,
      inputTokens: 5000,
      outputTokens: 300,
      results: [
        { key: 'photo:photos:p001', detections: [] },
        { key: 'photo:photos:p002', detections: [{ classId: 'moderate', confidence: 0.8 }] },
      ],
    });
    if (r.ok) expect(r.costUsd).toBeCloseTo((5000 * 4 + 300 * 20) / 1e6, 8);
    expect(recordUsage).toHaveBeenCalledWith(
      'ebsm',
      expect.objectContaining({ inputTokens: 5000 }),
    );
    const call = model.doGenerateCalls[0];
    const prompt = call?.prompt ?? [];
    expect(prompt[0]).toMatchObject({ role: 'system' });
    const user = prompt.find((m) => m.role === 'user');
    const parts = user?.role === 'user' ? user.content : [];
    expect(parts.filter((p) => p.type === 'file')).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(DETECT_MARKER) as unknown,
    });
  });

  it('goes through the same gates as the agent: cloud off, project policy, key', async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('{}') });
    expect(await withModel(model, { cloudAllowed: () => false }).detect(detectReq())).toEqual({
      ok: false,
      error: MESSAGES.cloudOff,
    });
    expect(
      await withModel(model, { policy: () => Promise.resolve('forbid') }).detect(detectReq()),
    ).toEqual({
      ok: false,
      error: MESSAGES.forbidden,
    });
    expect(
      await withModel(model, { getKey: () => Promise.resolve(null) }).detect(detectReq()),
    ).toEqual({
      ok: false,
      error: 'Add an Anthropic key in Settings, AI providers.',
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('reports the provider’s exact error with its status, never the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: 'Number of request tokens has exceeded your per-minute rate limit',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 429,
            data: {
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: 'Number of request tokens has exceeded your per-minute rate limit',
              },
            },
          }),
        ),
    });
    const r = await withModel(model).detect(detectReq());
    expect(r).toEqual({
      ok: false,
      status: 429,
      error:
        'Anthropic is busy or rate limited: Number of request tokens has exceeded your per-minute rate limit. (HTTP 429) Wait a moment and try again.',
    });
    expect(warn.mock.calls.join(' ')).not.toContain('sk-test');
    warn.mockRestore();
  });

  it('refuses an answer in another format and can be stopped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = new MockLanguageModelV4({ doGenerate: reply('No defects, I think.') });
    expect(await withModel(bad).detect(detectReq())).toEqual({
      ok: false,
      error:
        'Anthropic, claude-opus-5-5: The model did not answer in the detection format: "No defects, I think."',
    });
    let release: () => void = () => undefined;
    const slow = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) => {
          release = () => undefined;
          abortSignal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const rt = withModel(slow);
    const pending = rt.detect(detectReq({ runId: 'stop-me' }));
    await new Promise((r) => setTimeout(r, 10));
    rt.cancel('stop-me');
    expect(await pending).toEqual({ ok: false, error: MESSAGES.stopped, stopped: true });
    release();
    warn.mockRestore();
  });

  it('checks the vision route in ai:status when asked', async () => {
    const rt = createAgentRuntime(host(), {
      providers: createProviderRegistry([createScriptedProvider('anthropic')]),
    });
    expect(await rt.status({ task: 'vision' })).toMatchObject({
      ready: true,
      route: { task: 'vision', model: 'claude-opus-5-5' },
    });
  });
});

describe('scripted detections (e2e)', () => {
  const prompt = (text: string): LanguageModelV4Prompt => [
    { role: 'system', content: detectInstructions({ classes }) },
    { role: 'user', content: [{ type: 'text', text }] },
  ];

  it('answers one proposal per image in the first class', async () => {
    const out = scriptedDetections(prompt(detectUserText(3)));
    const r = parseDetectReply(out ?? '', 3, classes);
    if (typeof r === 'string') throw new Error(r);
    expect(r.results.map((x) => x.length)).toEqual([1, 1, 1]);
    expect(r.results[1]?.[0]).toMatchObject({ classId: 'moderate', box: [0.25, 0.3, 0.25, 0.2] });
    expect(scriptedDetections(prompt('hello'))).toBeNull();
    expect(scriptedDetections(prompt(detectUserText(1, 'nothing here')))).toBe(
      '{"images":[{"image":1,"detections":[]}]}',
    );

    const rt = createAgentRuntime(host(), {
      providers: createProviderRegistry([createScriptedProvider('anthropic' satisfies AiProvider)]),
    });
    const res = await rt.detect(detectReq());
    expect(res.ok && res.results.map((x) => x.detections.length)).toEqual([1, 1]);
  });
});
