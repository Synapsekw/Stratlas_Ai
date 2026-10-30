/**
 * The agent runtime through the real Anthropic and OpenAI providers of the AI SDK, with a mocked
 * fetch: what goes on the wire (cache breakpoints, thinking, the step-cap summary, earlier tool
 * work) and that the replies are read back.
 */
import type { IpcEvent, IpcRequest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntimeHost } from './main';
import { builtInProviders, createProviderRegistry } from './providers';

type AiEvent = IpcEvent<'ai:event'>;

const sse = (events: { event?: string; data: unknown }[]) =>
  events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)
    .join('');

const streamResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

function anthropicToolUse(id: string, name: string): string {
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: `msg_${id}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function anthropicText(text: string): string {
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_t',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function openaiText(text: string): string {
  return sse([
    {
      data: {
        type: 'response.created',
        response: { id: 'resp_1', created_at: 1_700_000_000, model: 'gpt-5', service_tier: null },
      },
    },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_1' },
      },
    },
    {
      data: {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_1' },
      },
    },
    {
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          incomplete_details: null,
          usage: { input_tokens: 10, output_tokens: 2 },
          service_tier: null,
        },
      },
    },
  ]);
}

function runtimeWith(replies: string[], host: Partial<AgentRuntimeHost> = {}, maxSteps?: number) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    );
    const next = replies.shift();
    return Promise.resolve(
      next ? streamResponse(next) : new Response('no more replies', { status: 500 }),
    );
  };
  const events: AiEvent[] = [];
  let runtime: ReturnType<typeof createAgentRuntime> | undefined;
  const done = new Promise<AiEvent>((resolve) => {
    runtime = createAgentRuntime(
      {
        getKey: () => Promise.resolve('test-key-not-real'),
        cloudAllowed: () => true,
        emit: (e) => {
          events.push(e);
          if (e.type === 'tool-call') {
            queueMicrotask(() => {
              runtime?.toolResult({ runId: e.runId, callId: e.callId, approved: true, result: [] });
            });
          }
          if (e.type === 'done' || e.type === 'error') resolve(e);
        },
        ...host,
      },
      {
        providers: createProviderRegistry(builtInProviders({ fetch })),
        maxRetries: 0,
        ...(maxSteps ? { maxSteps } : {}),
      },
    );
  });
  if (!runtime) throw new Error('no runtime');
  return { runtime, bodies, events, done };
}

const call = (callId: string, name: string) => ({
  role: 'assistant' as const,
  content: '',
  toolCalls: [{ callId, name, input: {} }],
});

describe('agent runtime on the wire', () => {
  it('Anthropic: at most four cache breakpoints, thinking, 16k output, and a summary that runs no tool', async () => {
    const t = runtimeWith(
      [
        anthropicToolUse('toolu_a', 'list_layers'),
        anthropicToolUse('toolu_b', 'list_layers'),
        anthropicText('I listed the layers twice. Left: nothing.'),
      ],
      {},
      2,
    );
    const req: IpcRequest<'ai:send'> = {
      runId: 'r1',
      window: 'scene3d',
      context: {},
      messages: [
        { role: 'user', content: 'One' },
        { role: 'assistant', content: 'A.' },
        { role: 'user', content: 'Two' },
        call('toolu_old', 'list_layers'),
        {
          role: 'tool',
          results: [{ callId: 'toolu_old', name: 'list_layers', status: 'ok', output: '[]' }],
        },
        { role: 'assistant', content: 'B.' },
        { role: 'user', content: 'Three' },
      ],
    };
    expect(await t.runtime.send(req)).toEqual({ ok: true });
    expect((await t.done).type).toBe('done');
    expect(t.bodies).toHaveLength(3);
    for (const body of t.bodies) {
      const marks = JSON.stringify(body).split('"cache_control"').length - 1;
      expect(marks).toBeGreaterThan(0);
      expect(marks).toBeLessThanOrEqual(4);
      expect(body.max_tokens).toBe(16_000);
      expect((body.thinking as { type?: string } | undefined)?.type).toBe('adaptive');
    }
    expect(t.bodies[0]?.tool_choice).not.toEqual({ type: 'none' });
    // the summary: tools still declared (the history has tool_use blocks) but told not to call one
    expect((t.bodies[2]?.tools as unknown[] | undefined)?.length).toBeGreaterThan(0);
    expect(t.bodies[2]?.tool_choice).not.toEqual({ type: 'any' });
    expect(JSON.stringify(t.bodies[2]?.messages)).toContain('Do not call any tool');
    const text = t.events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
    expect(text).toContain('Left: nothing.');
  });

  it('OpenAI: a declined result and a call to a tool no longer offered still go out', async () => {
    const t = runtimeWith([openaiText('Only one survey date: nothing to compare.')], {
      routes: () => [{ task: 'chat', provider: 'openai', model: 'gpt-5' }],
    });
    const req: IpcRequest<'ai:send'> = {
      runId: 'r1',
      window: 'scene3d',
      context: {},
      facts: { captures: 1, photos: false, clips: false, pointClouds: false, models: false },
      messages: [
        { role: 'user', content: 'Draft and compare' },
        call('call_1', 'create_issue_draft'),
        {
          role: 'tool',
          results: [
            {
              callId: 'call_1',
              name: 'create_issue_draft',
              status: 'declined',
              output: 'The person declined this action.',
            },
          ],
        },
        call('call_2', 'compare_captures'),
        {
          role: 'tool',
          results: [{ callId: 'call_2', name: 'compare_captures', status: 'ok', output: '{}' }],
        },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'Again' },
      ],
    };
    expect(await t.runtime.send(req)).toEqual({ ok: true });
    expect((await t.done).type).toBe('done');
    const body = JSON.stringify(t.bodies[0]);
    expect(body).toContain('compare_captures');
    expect(body).toContain('The person declined this action.');
    const tools = (t.bodies[0]?.tools as { name?: string }[] | undefined) ?? [];
    expect(tools.map((x) => x.name)).not.toContain('compare_captures');
    expect(tools.map((x) => x.name)).toContain('fly_to');
    const text = t.events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
    expect(text).toContain('nothing to compare');
  });
});
