import { CorrectionProposalInput, EngineerProposal, type EngineerSetup } from '@aio/schema';
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { correctionPrompt } from './correctionPrompt';
import { runEngineer, type EngineerCall, type EngineerHost } from './engineer';
import { createProviderRegistry } from './providers';
import {
  createScriptedProvider,
  SCRIPT,
  SCRIPTED_ENGINEER,
  scriptedCorrectionTurn,
  scriptedTurn,
  scriptInput,
  wordsAfter,
} from './scripted';
import { getToolSpec } from './tools';

const PNG =
  'data:image/png;base64,' +
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
  ]).toString('base64');

const SETUP: EngineerSetup = {
  sources: { clouds: [], meshes: [], photos: [] },
  family: 'auto',
  scope: 'asset',
  detail: 'standard',
  placement: 'unplaced',
};

function call(marker: string): EngineerCall {
  return {
    projectId: 'p1',
    runId: 'run-1',
    pass: 1,
    images: [{ id: 'p1', kind: 'photo', dataUrl: PNG, bytes: 40 }],
    summary: JSON.stringify({ note: marker }),
    setup: SETUP,
  };
}

function host(provider: 'anthropic' | 'openai'): EngineerHost & { requests: () => number } {
  let requests = 0;
  const counted = createScriptedProvider(provider, true, {
    onGenerate: () => {
      requests += 1;
    },
  });
  return {
    route: () => ({
      task: 'engineer',
      provider,
      model: provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6-luna',
    }),
    key: () => Promise.resolve(null),
    offlineOnly: () => false,
    policy: () => ({ ai: 'allow', photos: true, scans: true }),
    cache: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    spent: () => 0,
    usage: () => undefined,
    budgetUsd: 2,
    signal: new AbortController().signal,
    providers: createProviderRegistry([counted]),
    maxRetries: 0,
    requests: () => requests,
  };
}

describe('scripted corrections', () => {
  const user = (text: string) => [
    { role: 'user' as const, content: [{ type: 'text' as const, text }] },
  ];
  it('saves "remember that ..." as a project note, the rest of the message as its text', () => {
    expect(scriptedTurn(user('Remember that the piles here are named SP-1 to SP-9.'))).toEqual({
      kind: 'tool',
      tool: 'remember_note',
      input: { text: 'The piles here are named SP-1 to SP-9' },
    });
  });

  it('"there are four flues, not three" sets the flue count', () => {
    expect(scriptedTurn(user('There are four flues, not three.'))).toEqual({
      kind: 'tool',
      tool: 'set_count',
      input: { role: 'flue', count: 4 },
    });
  });
  it('"add the intermediate warning lights" sets the light levels', () => {
    expect(scriptedTurn(user('Please add the intermediate warning lights'))).toEqual({
      kind: 'tool',
      tool: 'set_levels',
      input: { role: 'light', levels: [25, 50, 75] },
    });
  });
  it('the inputs pass the tools own checks', () => {
    for (const s of SCRIPT.filter((r) => r.tool === 'set_count' || r.tool === 'set_levels')) {
      const spec = getToolSpec(s.tool);
      expect(spec?.input.safeParse(scriptInput(s.input, s.when)).success, s.tool).toBe(true);
    }
  });
});

describe('scripted fact index questions', () => {
  const user = (text: string) => [
    { role: 'user' as const, content: [{ type: 'text' as const, text }] },
  ];
  it('reads the words after a keyword, in the message case', () => {
    expect(wordsAfter('What happened to Stockpile SP1 over time?', 'what happened to')).toBe(
      'Stockpile SP1',
    );
    expect(wordsAfter('What happened to "Pile B"?', 'what happened to')).toBe('Pile B');
    expect(wordsAfter('Show me the history of Crack D012.', 'history of')).toBe('Crack D012');
    expect(wordsAfter('Search the project for concrete', 'search the project for')).toBe(
      'concrete',
    );
    expect(wordsAfter('nothing here', 'history of')).toBe('');
  });

  it('asks history_of about the subject the question names', () => {
    expect(scriptedTurn(user('What happened to Stockpile SP2 over time?'))).toEqual({
      kind: 'tool',
      tool: 'history_of',
      input: { subject: 'Stockpile SP2' },
    });
    expect(scriptedTurn(user('Give me the history of Crack D012'))).toEqual({
      kind: 'tool',
      tool: 'history_of',
      input: { subject: 'Crack D012' },
    });
  });

  it('searches for the words the question gives', () => {
    expect(scriptedTurn(user('Search the project for cracked concrete?'))).toEqual({
      kind: 'tool',
      tool: 'query_facts',
      input: { text: 'cracked concrete' },
    });
    expect(scriptedTurn(user('What do we know about Tank T1?'))).toEqual({
      kind: 'tool',
      tool: 'query_facts',
      input: { text: 'Tank T1' },
    });
  });

  it('sends inputs the fact tools accept', () => {
    const history = scriptedTurn(user('What happened to Stockpile SP1 over time?'));
    const search = scriptedTurn(user('Find everything about the north wall'));
    for (const t of [history, search]) {
      if (t.kind !== 'tool') throw new Error('expected a tool call');
      expect(getToolSpec(t.tool)?.input.safeParse(t.input).success, t.tool).toBe(true);
    }
  });
});

describe('scripted engineer replies', () => {
  it.each(['anthropic', 'openai'] as const)(
    '%s: the default reply is a valid chimney',
    async (p) => {
      const h = host(p);
      const r = await runEngineer(call('no marker'), h);
      expect(r).toMatchObject({ kind: 'proposal', proposal: { family: { value: 'chimney' } } });
      expect(h.requests()).toBe(1);
    },
  );

  it.each([
    ['#engineer flare', 'flare'],
    ['#engineer lattice', 'telecom-lattice'],
    ['#engineer monopole', 'telecom-monopole'],
    ['#engineer chimney', 'chimney'],
  ])('%s gives a valid %s proposal, the same for both providers', async (marker, family) => {
    const a = await runEngineer(call(marker), host('anthropic'));
    const o = await runEngineer(call(marker), host('openai'));
    expect(a).toMatchObject({ kind: 'proposal', proposal: { family: { value: family } } });
    expect(o.kind === 'proposal' && o.proposal).toEqual(a.kind === 'proposal' && a.proposal);
  });

  it('#engineer invalid answers invalid first, then valid on the repair', async () => {
    const h = host('anthropic');
    const r = await runEngineer(call('#engineer invalid'), h);
    expect(r).toMatchObject({ kind: 'proposal' });
    expect(h.requests()).toBe(2);
  });

  it('#engineer invalid-always fails as invalid after one repair', async () => {
    const h = host('openai');
    expect(await runEngineer(call('#engineer invalid-always'), h)).toMatchObject({
      kind: 'failed',
      code: 'invalid',
    });
    expect(h.requests()).toBe(2);
  });

  it('#engineer conflict flags two structures', async () => {
    const r = await runEngineer(call('#engineer conflict'), host('anthropic'));
    expect(r).toMatchObject({ kind: 'proposal', identityConflict: true });
  });

  it('#engineer rate-limit answers 429', async () => {
    const h = host('anthropic');
    expect(await runEngineer(call('#engineer rate-limit'), h)).toMatchObject({
      kind: 'failed',
      code: 'rate-limit',
    });
  });

  it('every fixture is a valid proposal once mapped', () => {
    for (const [name, wire] of Object.entries(SCRIPTED_ENGINEER)) {
      const w = wire as {
        components: {
          params: { name: string; value: unknown }[];
          levels: number[];
          description: string;
        }[];
      };
      const p = {
        ...wire,
        components: w.components.map((c) => ({
          ...c,
          params: Object.fromEntries(c.params.map((x) => [x.name, x.value])),
          levels: c.levels.length ? c.levels : undefined,
          description: c.description || undefined,
        })),
      };
      const clean = JSON.parse(JSON.stringify(p)) as unknown;
      // `invalid` is out of range on purpose (the first reply of `#engineer invalid`)
      expect(EngineerProposal.safeParse(clean).success, name).toBe(name !== 'invalid');
    }
  });
});

describe('scripted model corrections', () => {
  const data = JSON.stringify({
    requests: [{ id: 'fix-1', target: { kind: 'model' }, comment: 'remove the ladder' }],
    components: [{ id: 'ladder-1', kind: 'ladder' }],
  });
  const user = (text: string): LanguageModelV4Prompt => [
    { role: 'user', content: [{ type: 'text', text }] },
  ];
  it('lists the requests, then proposes removing the ladder', () => {
    const first = scriptedTurn(user(correctionPrompt(data)));
    expect(first).toEqual({ kind: 'tool', tool: 'list_model_corrections', input: {} });
    const prompt: LanguageModelV4Prompt = [
      ...user(correctionPrompt(data)),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'list_model_corrections', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'list_model_corrections',
            output: { type: 'json', value: {} },
          },
        ],
      },
    ];
    const second = scriptedTurn(prompt);
    expect(second.kind).toBe('tool');
    if (second.kind !== 'tool') return;
    expect(second.tool).toBe('propose_model_correction');
    expect(second.input.requestId).toBe('fix-1');
    const proposal = second.input.proposal as { patch: unknown };
    expect(proposal.patch).toEqual([{ op: 'remove', id: 'ladder-1' }]);
    expect(CorrectionProposalInput.safeParse(proposal).success).toBe(true);
  });
  it('answers nothing special without the lead', () => {
    expect(scriptedCorrectionTurn(user('hello'))).toBeNull();
  });
});

describe('several calls in one step (A3 batch approvals)', () => {
  const user = (text: string): LanguageModelV4Prompt => [
    { role: 'user', content: [{ type: 'text', text }] },
  ];
  const results = (names: string[]): LanguageModelV4Prompt => [
    {
      role: 'assistant',
      content: names.map((n, i) => ({
        type: 'tool-call' as const,
        toolCallId: `c${String(i)}`,
        toolName: n,
        input: {},
      })),
    },
    {
      role: 'tool',
      content: names.map((n, i) => ({
        type: 'tool-result' as const,
        toolCallId: `c${String(i)}`,
        toolName: n,
        output: { type: 'json' as const, value: { ok: true } },
      })),
    },
  ];
  const text =
    'Do these #batch\n#tool create_issue_draft {"title":"A"}\n#tool create_issue_draft {"title":"B"}';

  it('#batch makes all the directives of a message one step', () => {
    expect(scriptedTurn(user(text))).toEqual({
      kind: 'tools',
      calls: [
        { tool: 'create_issue_draft', input: { title: 'A' } },
        { tool: 'create_issue_draft', input: { title: 'B' } },
      ],
    });
    // after their results it reports, and makes no second step
    const after = scriptedTurn([
      ...user(text),
      ...results(['create_issue_draft', 'create_issue_draft']),
    ]);
    expect(after.kind).toBe('text');
    expect(after.kind === 'text' ? after.text : '').toMatch(/^Tool create_issue_draft returned/);
  });

  it('without #batch the directives stay one per step', () => {
    expect(scriptedTurn(user(text.replace(' #batch', '')))).toEqual({
      kind: 'tool',
      tool: 'create_issue_draft',
      input: { title: 'A' },
    });
  });

  it('"draft three issues" makes three drafts in one step, each passing its schema', () => {
    const turn = scriptedTurn(user('Please draft three issues on the north wall'));
    expect(turn.kind).toBe('tools');
    if (turn.kind !== 'tools') return;
    expect(turn.calls.map((c) => c.tool)).toEqual([
      'create_issue_draft',
      'create_issue_draft',
      'create_issue_draft',
    ]);
    for (const c of turn.calls) {
      expect(getToolSpec(c.tool)?.input.safeParse(c.input).success).toBe(true);
    }
  });

  it('"look at the view" asks for one capture', () => {
    expect(scriptedTurn(user('Look at the view and tell me what you see'))).toEqual({
      kind: 'tool',
      tool: 'capture_frame',
      input: {},
    });
  });

  it('streams every call of the step in one response', async () => {
    const model = createScriptedProvider('anthropic').languageModel('m', null) as LanguageModelV4;
    const { stream } = await model.doStream({ prompt: user(text) });
    const parts: { type: string }[] = [];
    const reader = stream.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
    }
    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(2);
  });
});
