import {
  ChatMessage,
  Conversation,
  type ConversationStep,
  type ConversationTurn,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  compactInput,
  compactValue,
  flattenHistory,
  historyFromConversation,
  pairToolHistory,
  RESULT_MAX,
  safeCallId,
} from './history';

const step = (over: Partial<ConversationStep> & { callId: string }): ConversationStep => ({
  name: 'find_places',
  input: { query: 'tank' },
  risk: 'read',
  status: 'done',
  canUndo: false,
  ...over,
});

describe('compactValue', () => {
  it('keeps a small result whole', () => {
    expect(compactValue({ id: 'T-3', x: 1.5 })).toBe('{"id":"T-3","x":1.5}');
  });

  it('cuts a large result under the limit and keeps ids, names and numbers', () => {
    const places = Array.from({ length: 300 }, (_, i) => ({
      id: `20-T-${String(i).padStart(4, '0')}`,
      name: `Tank ${String(i)}`,
      position: [1000.25 + i, 12.5, -300.75],
      volumeM3: 1234.5678 + i,
      note: 'x'.repeat(500),
    }));
    const out = compactValue({ places, image: `data:image/png;base64,${'A'.repeat(5000)}` });
    expect(out.length).toBeLessThanOrEqual(RESULT_MAX);
    expect(out).toContain('20-T-0000');
    expect(out).toContain('20-T-0001');
    expect(out).toContain('Tank 1');
    expect(out).toContain('1001.25');
    expect(out).toContain('1235.5678');
    expect(out).toMatch(/\d+ more/);
    expect(out).not.toContain('AAAA');
  });

  it('keeps a text result as text and says Done for nothing', () => {
    expect(compactValue('Camera at the north gate.')).toBe('Camera at the north gate.');
    expect(compactValue(undefined)).toBe('Done.');
    expect(compactValue('y'.repeat(5000)).length).toBeLessThanOrEqual(RESULT_MAX);
  });
});

describe('compactInput', () => {
  it('keeps an object and wraps anything else', () => {
    expect(compactInput({ target: { kind: 'place', name: 'T-3' } })).toEqual({
      target: { kind: 'place', name: 'T-3' },
    });
    expect(compactInput('x')).toEqual({ value: 'x' });
    expect(compactInput(undefined)).toEqual({});
  });

  it('cuts a large input but stays an object', () => {
    const cut = compactInput({ ids: Array.from({ length: 2000 }, (_, i) => `id-${String(i)}`) });
    expect(typeof cut).toBe('object');
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(2048);
  });
});

describe('historyFromConversation', () => {
  const turns: ConversationTurn[] = [
    { kind: 'user', id: 'u1', text: 'Which tanks are there?', chips: [], frame: false },
    {
      kind: 'assistant',
      id: 'a1',
      runId: 'r1',
      status: 'done',
      parts: [
        { type: 'text', text: 'Looking. ' },
        { type: 'step', callId: 'c1' },
        { type: 'step', callId: 'c2' },
        { type: 'text', text: 'There are two: T-1 and T-2.' },
      ],
    },
    { kind: 'user', id: 'u2', text: 'Fly to the second one', chips: [], frame: false },
  ];

  it('carries tool calls and their results between the text', () => {
    const steps = {
      c1: step({ callId: 'c1', result: '{"places":[{"id":"T-1"},{"id":"T-2"}]}' }),
      c2: step({ callId: 'c2', name: 'list_layers', input: {}, summary: '3 layers' }),
    };
    const h = historyFromConversation(turns, steps);
    expect(h).toEqual([
      { role: 'user', content: 'Which tanks are there?' },
      {
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [
          { callId: 'c1', name: 'find_places', input: { query: 'tank' } },
          { callId: 'c2', name: 'list_layers', input: {} },
        ],
      },
      {
        role: 'tool',
        results: [
          {
            callId: 'c1',
            name: 'find_places',
            status: 'ok',
            output: '{"places":[{"id":"T-1"},{"id":"T-2"}]}',
          },
          // a step saved before results were kept: its summary stands in
          { callId: 'c2', name: 'list_layers', status: 'ok', output: '3 layers' },
        ],
      },
      { role: 'assistant', content: 'There are two: T-1 and T-2.' },
      { role: 'user', content: 'Fly to the second one' },
    ]);
    for (const m of h) expect(ChatMessage.safeParse(m).success).toBe(true);
  });

  it('reads a conversation saved by an older build (no results) and closes a reply cut on calls', () => {
    const saved = Conversation.parse({
      schema: 'aio.conversation/1',
      id: 'old',
      title: 'Old',
      window: 'scene3d',
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-20T10:01:00Z',
      turns: [
        { kind: 'user', id: 'u1', text: 'Draft an issue', chips: [], frame: false },
        {
          kind: 'assistant',
          id: 'a1',
          runId: 'r1',
          status: 'stopped',
          parts: [{ type: 'step', callId: 'c9' }],
        },
      ],
      steps: {
        c9: {
          callId: 'c9',
          name: 'create_issue_draft',
          input: { title: 'Crack' },
          risk: 'write',
          status: 'rejected',
          canUndo: false,
        },
      },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true },
    });
    const h = historyFromConversation(saved.turns, saved.steps);
    expect(h.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ callId: 'c9', name: 'create_issue_draft', input: { title: 'Crack' } }],
      },
      {
        role: 'tool',
        results: [
          {
            callId: 'c9',
            name: 'create_issue_draft',
            status: 'declined',
            output: 'The person declined this action.',
          },
        ],
      },
      { role: 'assistant', content: '(The person stopped this reply here.)' },
    ]);
  });

  it('says what happened to steps that never ran, failed or were undone', () => {
    const h = historyFromConversation(
      [
        {
          kind: 'assistant',
          id: 'a',
          runId: 'r',
          status: 'done',
          parts: [
            { type: 'step', callId: 'w' },
            { type: 'step', callId: 'e' },
            { type: 'step', callId: 'u' },
            { type: 'step', callId: 'missing' },
          ],
        },
      ],
      {
        w: step({ callId: 'w', status: 'awaiting' }),
        e: step({ callId: 'e', status: 'error', summary: 'No such place' }),
        u: step({ callId: 'u', status: 'undone', summary: 'Camera moved' }),
      },
    );
    const tool = h[1];
    expect(tool?.role).toBe('tool');
    if (tool?.role !== 'tool') return;
    expect(tool.results.map((r) => [r.status, r.output])).toEqual([
      ['error', 'Not run yet: it waits for the person to approve it.'],
      ['error', 'No such place'],
      ['ok', 'Camera moved (The person undid this later.)'],
    ]);
  });
});

describe('pairToolHistory', () => {
  it('fills a missing result, drops an orphan and closes a reply before the next user message', () => {
    const out = pairToolHistory([
      { role: 'user', content: 'a' },
      { role: 'tool', results: [{ callId: 'x', name: 'n', status: 'ok', output: 'orphan' }] },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { callId: 'c1', name: 'fly_to', input: {} },
          { callId: 'c1', name: 'fly_to', input: {} },
          { callId: 'c2', name: 'zoom', input: {} },
        ],
      },
      { role: 'tool', results: [{ callId: 'c2', name: 'zoom', status: 'ok', output: 'ok' }] },
      { role: 'user', content: 'b' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { callId: 'c1', name: 'fly_to', input: {} },
          { callId: 'c2', name: 'zoom', input: {} },
        ],
      },
      {
        role: 'tool',
        results: [
          { callId: 'c1', name: 'fly_to', status: 'error', output: 'No result recorded.' },
          { callId: 'c2', name: 'zoom', status: 'ok', output: 'ok' },
        ],
      },
      { role: 'assistant', content: '(The reply ended here.)' },
      { role: 'user', content: 'b' },
    ]);
  });

  it('makes ids providers accept', () => {
    expect(safeCallId('call:abc/1')).toBe('call_abc_1');
  });
});

describe('flattenHistory', () => {
  it('turns tool work into lines of the assistant message for small models', () => {
    const out = flattenHistory([
      { role: 'user', content: 'Which tanks?' },
      {
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [{ callId: 'c1', name: 'find_places', input: { query: 'tank' } }],
      },
      {
        role: 'tool',
        results: [{ callId: 'c1', name: 'find_places', status: 'ok', output: '[T-1, T-2]' }],
      },
      { role: 'assistant', content: 'T-1 and T-2.' },
      { role: 'user', content: 'The second one' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'Which tanks?' },
      {
        role: 'assistant',
        content: 'Looking.\n[Called find_places {"query":"tank"}: [T-1, T-2]]\nT-1 and T-2.',
      },
      { role: 'user', content: 'The second one' },
    ]);
  });
});
