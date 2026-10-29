import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { FieldSpec, IpcRequest } from '@aio/schema';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { ASK_MARKER, ASK_PROMPT_VERSION } from './ask';
import { ASK_CUT_SHORT, parseDataUrl, runAsk } from './askRun';
import type { StepUsage } from './main';
import type { ModelProvider } from './providers';
import type { ModelRoute } from './routes';
import { askReply, createScriptedProvider } from './scripted';

const IMG = 'data:image/png;base64,AAAA';

const ROUTE: ModelRoute = { task: 'vision', provider: 'anthropic', model: 'claude-sonnet-5-5' };

const askReq = (over: Partial<IpcRequest<'ai:ask'>> = {}): IpcRequest<'ai:ask'> => ({
  runId: 'ask-1',
  projectId: 'p1',
  backend: { kind: 'cloud', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  kind: 'find',
  prompt: 'Find all gauges.',
  fields: [],
  images: [{ key: 'photo:p1', dataUrl: IMG, width: 1000, height: 500 }],
  ...over,
});

function run(
  req: IpcRequest<'ai:ask'>,
  provider: ModelProvider,
  over: { route?: ModelRoute; signal?: AbortSignal } = {},
) {
  const usage: StepUsage[] = [];
  const recordUsage = vi.fn((u: StepUsage) => usage.push(u));
  const result = runAsk({
    req,
    route: over.route ?? ROUTE,
    provider,
    key: null,
    signal: over.signal ?? new AbortController().signal,
    maxRetries: 0,
    recordUsage,
  });
  return { result, usage, recordUsage };
}

const reply = (
  text: string,
  finish: 'stop' | 'length' | 'content-filter' = 'stop',
): LanguageModelV4GenerateResult => ({
  content: text ? [{ type: 'text', text }] : [],
  finishReason: { unified: finish, raw: finish },
  usage: {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 100, text: 100, reasoning: 0 },
  },
  warnings: [],
});

function mockProvider(model: MockLanguageModelV4): ModelProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    cloud: true,
    needsKey: false,
    languageModel: () => model,
  };
}

describe('runAsk on the scripted provider', () => {
  it('normalises the scripted pixel boxes of a find to 0 to 1 of the image', async () => {
    const fields: FieldSpec[] = [
      { key: 'reading', label: 'Reading', type: 'number', unit: 'bar' },
      { key: 'broken', label: 'Broken', type: 'yesno' },
      { key: 'kind', label: 'Kind', type: 'choice', choices: ['dial', 'digital'] },
      { key: 'tag', label: 'Tag', type: 'text' },
    ];
    const { result, usage } = run(askReq({ fields }), createScriptedProvider('anthropic'));
    const r = await result;
    expect(r).toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      promptVersion: ASK_PROMPT_VERSION,
      inputTokens: 1200,
      outputTokens: 150,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.box).toEqual([0.1, 0.2, 0.3, 0.5]);
    expect(r.items[1]?.box).toEqual([0.6, 0.4, 0.8, 0.7]);
    expect(r.items[0]).toMatchObject({ label: 'scripted item', note: 'Scripted item 1.' });
    expect(r.items[0]?.fields.map((f) => f.value)).toEqual([42.5, 'yes', 'dial', 'scripted']);
    expect(usage).toHaveLength(1);
  });

  it('reads a change request on two images with the built-in fields first', async () => {
    const req = askReq({
      kind: 'change',
      prompt: 'What changed?',
      images: [
        { key: 'a', dataUrl: IMG, width: 800, height: 600, label: '1 March' },
        { key: 'b', dataUrl: IMG, width: 800, height: 600, label: '1 April' },
      ],
    });
    const r = await run(req, createScriptedProvider('anthropic')).result;
    if (!r.ok) throw new Error(r.error);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.label).toBe('scripted item');
    expect(r.items[0]?.fields.slice(0, 2).map((f) => [f.key, f.value])).toEqual([
      ['change_type', 'new'],
      ['what', 'scripted object'],
    ]);
  });

  it('answers an ask with text and no items', async () => {
    const r = await run(
      askReq({ kind: 'ask', prompt: 'Is the flange corroded?' }),
      createScriptedProvider('anthropic'),
    ).result;
    if (!r.ok) throw new Error(r.error);
    expect(r.items).toEqual([]);
    expect(r.text).toMatch(/^Scripted answer: /);
  });

  it('sends the images first, then the prompt, then the follow-up turns in order', async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('The second answer.') });
    const r = await run(
      askReq({
        kind: 'ask',
        prompt: 'And the bolts?',
        turns: [
          { role: 'user', text: 'Is the flange corroded?' },
          { role: 'assistant', text: 'Slightly, at the lower edge.' },
        ],
      }),
      mockProvider(model),
    ).result;
    expect(r).toMatchObject({ ok: true, text: 'The second answer.' });
    const call = model.doGenerateCalls[0];
    const prompt = call?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const first = prompt[0];
    const parts = first?.role === 'user' ? first.content : [];
    expect(parts[0]).toMatchObject({ type: 'text', text: 'Image 1:' });
    expect(parts[1]).toMatchObject({ type: 'file', mediaType: 'image/png' });
    const opening = parts[2];
    expect(opening?.type === 'text' ? opening.text : '').toContain(ASK_MARKER);
    expect(opening?.type === 'text' ? opening.text : '').toContain('Is the flange corroded?');
    expect(prompt[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Slightly, at the lower edge.' }],
    });
    expect(prompt[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'And the bolts?' }],
    });
    // no sampling settings and no prefill
    expect(call?.temperature).toBeUndefined();
    expect(call?.topP).toBeUndefined();
    expect(call?.maxOutputTokens).toBe(6000);
    expect(call?.providerOptions).toEqual({ anthropic: { effort: 'low' } });
  });

  it('labels the two images of a change request and asks Opus with medium effort', async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('[]') });
    const r = await run(
      askReq({
        kind: 'change',
        images: [
          { key: 'a', dataUrl: IMG, width: 800, height: 600, label: '1 March' },
          { key: 'b', dataUrl: IMG, width: 800, height: 600, label: '1 April' },
        ],
      }),
      mockProvider(model),
      { route: { task: 'vision', provider: 'anthropic', model: 'claude-opus-5-5' } },
    ).result;
    expect(r).toMatchObject({ ok: true, items: [] });
    const call = model.doGenerateCalls[0];
    const first = call?.prompt[0];
    const parts = first?.role === 'user' ? first.content : [];
    expect(parts.map((p) => (p.type === 'text' ? p.text : p.type))).toEqual([
      'Image 1 (1 March):',
      'file',
      'Image 2 (1 April):',
      'file',
      expect.stringContaining('Image 1 was taken on 1 March') as unknown,
    ]);
    expect(call?.maxOutputTokens).toBe(12000);
    expect(call?.providerOptions).toEqual({ anthropic: { effort: 'medium' } });
  });

  it('asks OpenAI with low reasoning effort', async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('[]') });
    await run(
      askReq(),
      { ...mockProvider(model), id: 'openai' },
      {
        route: { task: 'vision', provider: 'openai', model: 'gpt-6-luna' },
      },
    ).result;
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: 'low' },
    });
  });

  it('asks once more after an unreadable reply, then answers format, metering both calls', async () => {
    const onGenerate = vi.fn();
    const { result, usage } = run(
      askReq({ prompt: 'garbage please' }),
      createScriptedProvider('anthropic', true, { onGenerate }),
    );
    const r = await result;
    expect(r).toMatchObject({ ok: false, code: 'format' });
    if (!r.ok) expect(r.error).toContain('I could not do that.');
    expect(onGenerate).toHaveBeenCalledTimes(2);
    expect(usage).toHaveLength(2);
    expect(usage.reduce((s, u) => s + u.inputTokens, 0)).toBe(2400);
  });

  it('uses the second reply when the first cannot be read, summing the usage', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        reply('no list here'),
        reply('[{"bbox_2d":[100,100,300,250],"label":"gauge","note":"left"}]'),
      ],
    });
    const r = await run(askReq(), mockProvider(model)).result;
    expect(r).toMatchObject({ ok: true, inputTokens: 2000, outputTokens: 200 });
    if (r.ok) expect(r.items[0]?.box).toEqual([0.1, 0.2, 0.3, 0.5]);
  });

  it('keeps the items of a reply cut short, with a warning', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: reply(
        '[{"bbox_2d":[100,100,300,250],"label":"gauge","note":"a"},{"bbox_2d":[600,200,8',
        'length',
      ),
    });
    const r = await run(askReq(), mockProvider(model)).result;
    if (!r.ok) throw new Error(r.error);
    expect(r.items).toHaveLength(1);
    expect(r.warnings).toContain(ASK_CUT_SHORT);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('answers refused when the model declines', async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('', 'content-filter') });
    const { result, usage } = run(askReq(), mockProvider(model));
    expect(await result).toEqual({
      ok: false,
      code: 'refused',
      error: 'Anthropic, claude-sonnet-5-5: the model declined this request.',
    });
    expect(usage).toHaveLength(1);
  });

  it('answers stopped when the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockLanguageModelV4({ doGenerate: reply('[]') });
    const r = await run(askReq(), mockProvider(model), { signal: controller.signal }).result;
    expect(r).toEqual({ ok: false, error: 'Stopped.', stopped: true });
  });

  it('refuses an image that is not a data URL', async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('[]') });
    const r = await run(
      askReq({
        images: [{ key: 'x', dataUrl: 'data:image/png,notbase64', width: 10, height: 10 }],
      }),
      mockProvider(model),
    ).result;
    expect(r).toMatchObject({ ok: false });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe('parseDataUrl', () => {
  it('reads the media type and the base64 data', () => {
    expect(parseDataUrl('data:image/jpeg;base64,QUJD')).toEqual({
      mediaType: 'image/jpeg',
      base64: 'QUJD',
    });
    expect(parseDataUrl('data:text/plain;base64,QUJD')).toBeNull();
  });
});

describe('askReply', () => {
  it('gives the fixed failure text for garbage', () => {
    expect(askReply(`${ASK_MARKER}\ngarbage\nOutput JSON only: []`)).toBe('I could not do that.');
  });

  it('answers other text with its start', () => {
    expect(askReply('Hello there')).toBe('Scripted answer: Hello there');
  });

  it('places the boxes in pixels of the named size', () => {
    const text = `${ASK_MARKER}\nFind.\nOutput JSON only: [{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}] (it is 200 x 100 pixels as sent)`;
    const list = JSON.parse(askReply(text)) as { bbox_2d: number[] }[];
    expect(list.map((i) => i.bbox_2d)).toEqual([
      [20, 20, 60, 50],
      [120, 40, 160, 70],
    ]);
  });
});
