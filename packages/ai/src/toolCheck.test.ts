import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  gradeCase,
  neededFor,
  runToolCheck,
  TOOL_CHECK_CASES,
  type ToolCheckCase,
} from './toolCheck';

const finish = (reason: 'stop' | 'tool-calls') => ({
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 3200, noCache: 3200, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  },
  warnings: [],
});

const userText = (call: LanguageModelV4CallOptions): string =>
  call.prompt
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');

/** A model that answers each case through `answer` (a tool call, text, or a thrown error). */
function scripted(answer: (ask: string) => { tool: string; input: unknown } | string | Error): {
  model: MockLanguageModelV4;
  seen: LanguageModelV4CallOptions[];
} {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      await Promise.resolve();
      seen.push(call);
      const text = userText(call);
      const ask = TOOL_CHECK_CASES.find((c) => text.includes(c.ask))?.ask ?? text;
      const a = answer(ask);
      if (a instanceof Error) throw a;
      if (typeof a === 'string') {
        return {
          content: [{ type: 'text', text: a }] as LanguageModelV4Content[],
          ...finish('stop'),
        };
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: a.tool,
            input: typeof a.input === 'string' ? a.input : JSON.stringify(a.input),
          },
        ] as LanguageModelV4Content[],
        ...finish('tool-calls'),
      };
    },
  });
  return { model, seen };
}

/** The right first call for each case. */
const RIGHT: Record<string, { tool: string; input: unknown } | string> = {
  'fly-to-place': { tool: 'find_places', input: { query: 'Tank 3' } },
  'whole-site': { tool: 'frame_all', input: {} },
  'top-view': { tool: 'set_view', input: { view: 'top' } },
  'hide-layer': { tool: 'list_layers', input: {} },
  'count-issues': { tool: 'summarize_issues', input: {} },
  'survey-dates': { tool: 'list_surveys', input: {} },
  volume: { tool: 'get_volume', input: {} },
  'worst-finding': { tool: 'show_issue', input: {} },
  'critical-photos': { tool: 'show_photos', input: { severity: 3 } },
  'draft-issue': { tool: 'find_places', input: { query: 'Tank 2' } },
  'open-issues-list': { tool: 'list_issues', input: {} },
  thanks: 'You are welcome.',
};
const byAsk = (ask: string) => {
  const c = TOOL_CHECK_CASES.find((x) => x.ask === ask);
  return c ? RIGHT[c.id] : undefined;
};

describe('the tool-calling check', () => {
  it('passes a model that makes the right first call on every case, with the compact profile', async () => {
    const { model, seen } = scripted((ask) => byAsk(ask) ?? 'no idea');
    const r = await runToolCheck({ model });
    expect(r.cases.filter((c) => !c.ok)).toEqual([]);
    expect(r).toMatchObject({ passed: true, total: 12, correct: 12, needed: 10, invalidCalls: 0 });
    expect(r.promptTokens).toBe(3200);
    // the compact profile: compact prompt, short tool list, the window context first
    const first = seen[0];
    expect(first?.prompt[0]).toMatchObject({ role: 'system' });
    const system = first?.prompt[0]?.content;
    expect(typeof system === 'string' && system.includes('3D')).toBe(true);
    const names = first?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('fly_to');
    expect(names).toContain('run_action');
    expect(names).not.toContain('list_detections');
    expect(first ? userText(first) : '').toContain('<window_context');
  });

  it('fails a model that answers in text where a tool is needed', async () => {
    const { model } = scripted((ask) => (ask.startsWith('Thanks') ? 'OK.' : 'I would fly there.'));
    const r = await runToolCheck({ model });
    expect(r.passed).toBe(false);
    expect(r.correct).toBe(1);
    expect(r.cases[0]).toMatchObject({ outcome: 'text-only', ok: false });
  });

  it('counts calls to unknown tools as invalid, and arguments that miss the point as bad', async () => {
    const { model } = scripted((ask) => {
      if (ask.startsWith('Fly')) return { tool: 'teleport', input: {} };
      if (ask.startsWith('Switch')) return { tool: 'set_view', input: { view: 'north' } };
      return byAsk(ask) ?? 'no';
    });
    const r = await runToolCheck({ model });
    expect(r.cases.find((c) => c.id === 'fly-to-place')).toMatchObject({
      ok: false,
      outcome: 'invalid-call',
    });
    expect(r.invalidCalls).toBe(1);
    expect(r.cases.find((c) => c.id === 'top-view')).toMatchObject({
      ok: false,
      outcome: 'bad-args',
    });
    expect(r).toMatchObject({ correct: 10, passed: true });
  });

  it('throws when the server cannot be reached for the first case', async () => {
    const down = new APICallError({
      message: 'connect ECONNREFUSED',
      url: 'http://127.0.0.1:1/v1/chat/completions',
      requestBodyValues: {},
      isRetryable: true,
    });
    const { model } = scripted(() => down);
    await expect(runToolCheck({ model })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('needs four in five right', () => {
    expect(neededFor(12)).toBe(10);
    expect(neededFor(10)).toBe(8);
    expect(neededFor(5)).toBe(4);
  });

  it('grades a tool call on a text case as wrong', () => {
    const c: ToolCheckCase = { id: 't', ask: 'Thanks', expect: [] };
    expect(gradeCase(c, { toolName: 'frame_all', input: {} })).toMatchObject({
      ok: false,
      outcome: 'wrong-tool',
    });
    expect(gradeCase(c, undefined)).toMatchObject({ ok: true });
  });
});
