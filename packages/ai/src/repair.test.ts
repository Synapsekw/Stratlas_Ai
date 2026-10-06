import type { LanguageModelV4Content } from '@ai-sdk/provider';
import { InvalidToolInputError, NoSuchToolError, tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolCallRepair, repairJson } from './repair';

describe('repairJson', () => {
  it('leaves valid JSON alone', () => {
    expect(repairJson('{"a":1}')).toBe('{"a":1}');
  });

  it('fixes what small models get wrong', () => {
    const cases: [string, unknown][] = [
      [
        '{"target": {"kind": "place", "name": "tank 3"},}',
        { target: { kind: 'place', name: 'tank 3' } },
      ],
      ["{'view': 'top'}", { view: 'top' }],
      ['```json\n{"view": "top"}\n```', { view: 'top' }],
      ['Sure! {"view": "top"} I hope this helps.', { view: 'top' }],
      ['{view: "top", visible: True, layer: None}', { view: 'top', visible: true, layer: null }],
      ['{"ids": ["a", "b",]}', { ids: ['a', 'b'] }],
      ['', {}],
    ];
    for (const [input, want] of cases) {
      const out = repairJson(input);
      expect(out, input).not.toBeNull();
      expect(JSON.parse(out ?? 'null'), input).toEqual(want);
    }
  });

  it('gives up on text that holds no object', () => {
    expect(repairJson('I will fly to the tank now.')).toBeNull();
    expect(repairJson('{"a": ')).toBeNull();
  });
});

const tools = {
  set_view: tool({
    description: 'Set a standard view.',
    inputSchema: z.object({ view: z.enum(['top', 'north']) }),
  }),
} satisfies ToolSet;

const call = (toolName: string, input: string) => ({
  type: 'tool-call' as const,
  toolCallId: 'c1',
  toolName,
  input,
});

const finish = {
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
};

function fixer(reply: string) {
  return new MockLanguageModelV4({
    modelId: 'example',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: reply }] as LanguageModelV4Content[],
        ...finish,
      }),
  });
}

const base = {
  instructions: undefined,
  system: undefined,
  messages: [],
  tools,
  inputSchema: () => Promise.resolve({ type: 'object' as const }),
};

describe('createToolCallRepair', () => {
  it('repairs malformed JSON locally, without another request', async () => {
    const model = fixer('{"view":"north"}');
    const repair = createToolCallRepair({ model });
    const broken = call('set_view', "{'view': 'top',}");
    const fixed = await repair({
      ...base,
      toolCall: broken,
      error: new InvalidToolInputError({
        toolName: 'set_view',
        toolInput: broken.input,
        cause: 'x',
      }),
    });
    expect(fixed).toEqual({ ...broken, input: '{"view":"top"}' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('asks the model once with the schema error when the input does not fit', async () => {
    const model = fixer('```json\n{"view": "north"}\n```');
    const repair = createToolCallRepair({ model });
    const wrong = call('set_view', '{"view": "sideways"}');
    const fixed = await repair({
      ...base,
      toolCall: wrong,
      error: new InvalidToolInputError({
        toolName: 'set_view',
        toolInput: wrong.input,
        cause: 'Invalid enum value',
      }),
    });
    expect(fixed).toEqual({ ...wrong, input: '{"view":"north"}' });
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('set_view');
    expect(prompt).toContain('sideways');
  });

  it('gives up after the one retry', async () => {
    const model = fixer('I am not sure.');
    const repair = createToolCallRepair({ model });
    const wrong = call('set_view', '{"view": "sideways"}');
    expect(
      await repair({
        ...base,
        toolCall: wrong,
        error: new InvalidToolInputError({
          toolName: 'set_view',
          toolInput: wrong.input,
          cause: 'x',
        }),
      }),
    ).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('maps a tool name written differently to the real one', async () => {
    const model = fixer('');
    const repair = createToolCallRepair({ model });
    const odd = call('functions.Set-View', '{"view":"top"}');
    expect(
      await repair({
        ...base,
        toolCall: odd,
        error: new NoSuchToolError({ toolName: odd.toolName }),
      }),
    ).toEqual({ ...odd, toolName: 'set_view' });
    const unknown = call('teleport', '{}');
    expect(
      await repair({
        ...base,
        toolCall: unknown,
        error: new NoSuchToolError({ toolName: 'teleport' }),
      }),
    ).toBeNull();
  });
});
