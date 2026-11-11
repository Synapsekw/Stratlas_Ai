import type { Fact, FactHistory } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSubjectId } from './fact-tools';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureManifest, fixtureWorkspace } from './test-fixtures';
import { approvalFor, getToolSpec, riskOf, toolsForWindow } from './tools';

const fact = (over: Partial<Fact> & Pick<Fact, 'id' | 'kind' | 'subject' | 'label'>): Fact => ({
  evidence: 'survey/measurements.json',
  ...over,
});

const sp1 = fact({
  id: 'f1',
  kind: 'measurement',
  subject: 'measurement:sp1',
  label: 'Stockpile SP1',
  source: 'human',
});
const sp1Volume = fact({
  id: 'f2',
  kind: 'volume',
  subject: 'measurement:sp1',
  label: 'Stockpile SP1',
  capture: 'c2',
  date: '2021-01-10',
  value: 1234.56789,
  unit: 'm3',
  status: 'pass',
});
const sp10 = fact({ id: 'f3', kind: 'measurement', subject: 'measurement:sp10', label: 'SP10' });
const crack = fact({
  id: 'f4',
  kind: 'issue',
  subject: 'issue:I1',
  label: 'Crack D012',
  evidence: 'issues.json',
});

function ctx(): RendererToolContext {
  const ws = fixtureWorkspace();
  ws.getState().openProject(
    {
      id: 'p1',
      root: 'E:/x',
      manifest: {
        ...fixtureManifest(),
        captures: [
          { id: 'c1', label: 'First', date: '2020-12-31' },
          { id: 'c2', label: 'Second', date: '2021-01-10' },
        ],
      },
    },
    [],
  );
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2021-02-01T12:00:00Z'),
  };
}

const emptyHistory = (subject: string): FactHistory => ({
  subject,
  facts: [],
  linked: [],
  events: [],
});

function bridge(opts: {
  hits?: Fact[];
  total?: number;
  history?: (subject: string) => FactHistory;
  fail?: string;
}) {
  const invoke = vi.fn((channel: string, arg: unknown) => {
    if (opts.fail) return Promise.resolve({ ok: false, error: opts.fail });
    if (channel === 'facts:query') {
      const hits = opts.hits ?? [];
      return Promise.resolve({ ok: true, facts: hits, total: opts.total ?? hits.length });
    }
    if (channel === 'facts:history') {
      const { subject } = arg as { subject: string };
      return Promise.resolve({ ok: true, history: (opts.history ?? emptyHistory)(subject) });
    }
    return Promise.reject(new Error(channel));
  });
  (globalThis as { aio?: unknown }).aio = { invoke, on: () => () => undefined };
  return invoke;
}

afterEach(() => {
  delete (globalThis as { aio?: unknown }).aio;
});

describe('fact index tool specs', () => {
  it('are read tools that never ask', () => {
    for (const n of ['query_facts', 'history_of']) {
      expect(getToolSpec(n)?.meta.scope, n).toBe('project');
      expect(riskOf(n), n).toBe('read');
      expect(approvalFor(n), n).toBe(false);
    }
  });

  it('fill the default limit and refuse a limit over 100 or unknown fields', () => {
    const q = getToolSpec('query_facts')?.input;
    expect(q?.parse({})).toEqual({ limit: 20 });
    expect(() => q?.parse({ limit: 101 })).toThrow();
    expect(() => q?.parse({ kinds: ['tank'] })).toThrow();
    expect(() => q?.parse({ from: '12 July' })).toThrow();
    expect(() => q?.parse({ near: { e: 0, n: 0, radiusM: 1 } })).toThrow();
    expect(() => getToolSpec('history_of')?.input.parse({})).toThrow();
  });

  it('stay out of the compact profile (it is full at 34 tools)', () => {
    const compact = toolsForWindow('scene3d', 'compact').map((s) => s.meta.name);
    expect(compact).not.toContain('query_facts');
    expect(compact).not.toContain('history_of');
  });

  it('tell a subject id from a name', () => {
    expect(isSubjectId('issue:I1')).toBe(true);
    expect(isSubjectId('measurement:m-3')).toBe(true);
    expect(isSubjectId('change-set:cs-1')).toBe(true);
    expect(isSubjectId('photo:l1/DJI_0001.JPG')).toBe(true);
    expect(isSubjectId('Stockpile SP1')).toBe(false);
    expect(isSubjectId('Note: crack')).toBe(false);
    expect(isSubjectId('tank:T1')).toBe(false);
  });
});

describe('query_facts', () => {
  it('maps the input onto facts:query and answers compact rows', async () => {
    const invoke = bridge({ hits: [sp1Volume], total: 1 });
    const r = await runRendererTool(
      'query_facts',
      {
        text: '  SP1 ',
        kinds: ['volume'],
        from: '2021-01-01',
        to: '2021-01-31',
        status: 'pass',
        limit: 5,
      },
      ctx(),
    );
    expect(invoke).toHaveBeenCalledWith('facts:query', {
      projectId: 'p1',
      query: {
        text: 'SP1',
        kinds: ['volume'],
        from: '2021-01-01',
        to: '2021-01-31',
        status: 'pass',
        limit: 5,
      },
    });
    expect(r.result).toEqual({
      total: 1,
      shown: 1,
      facts: [
        {
          kind: 'volume',
          subject: 'measurement:sp1',
          label: 'Stockpile SP1',
          date: '2021-01-10',
          value: 1234.568,
          unit: 'm3',
          status: 'pass',
          evidence: 'survey/measurements.json',
        },
      ],
    });
    expect(r.summary).toBe('1 fact');
  });

  it('resolves a survey date to its capture id', async () => {
    const invoke = bridge({ hits: [] });
    const r = await runRendererTool('query_facts', { date: 'Second' }, ctx());
    expect(invoke).toHaveBeenCalledWith('facts:query', {
      projectId: 'p1',
      query: { capture: 'c2', limit: 20 },
    });
    expect(r.result).toMatchObject({ survey: { captureId: 'c2', date: '2021-01-10' }, total: 0 });
    expect((r.result as { note?: string }).note).toMatch(/Nothing/);
    await runRendererTool('query_facts', { date: '2020-12-31' }, ctx());
    expect(invoke).toHaveBeenLastCalledWith('facts:query', {
      projectId: 'p1',
      query: { capture: 'c1', limit: 20 },
    });
  });

  it('refuses an unknown survey date, listing the dates', async () => {
    const invoke = bridge({ hits: [] });
    await expect(runRendererTool('query_facts', { date: 'June' }, ctx())).rejects.toThrow(
      /No survey date "June".*c1 \(2020-12-31, First\).*c2 \(2021-01-10, Second\)/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('says when more match than it shows, and passes main errors on', async () => {
    bridge({ hits: [sp1, sp10], total: 40 });
    const r = await runRendererTool('query_facts', { text: 'SP', limit: 2 }, ctx());
    expect(r.result).toMatchObject({ total: 40, shown: 2 });
    expect((r.result as { note?: string }).note).toMatch(/More facts/);
    expect(r.summary).toBe('40 facts');
    bridge({ fail: 'The fact index is still building.' });
    await expect(runRendererTool('query_facts', {}, ctx())).rejects.toThrow(/still building/);
  });

  it('needs the desktop app', async () => {
    await expect(runRendererTool('query_facts', {}, ctx())).rejects.toThrow(/desktop app/);
  });
});

describe('history_of', () => {
  const sp1History = (subject: string): FactHistory => ({
    subject,
    facts: [sp1, sp1Volume],
    linked: [
      {
        rel: 'inside',
        fact: { ...crack, date: '2021-01-10', status: 'open' },
      },
    ],
    events: [
      fact({
        id: 'e1',
        kind: 'event',
        subject,
        label: 'Measurement edited',
        at: '2021-01-11T09:00:00Z',
        source: 'human',
        op: 'op-1',
        evidence: 'journal/2021-01.jsonl',
      }),
    ],
  });

  it('reads a subject id straight away, oldest first and compact', async () => {
    const invoke = bridge({ history: sp1History });
    const r = await runRendererTool('history_of', { subject: 'measurement:sp1' }, ctx());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('facts:history', {
      projectId: 'p1',
      subject: 'measurement:sp1',
    });
    expect(r.result).toEqual({
      subject: 'measurement:sp1',
      label: 'Stockpile SP1',
      facts: [
        {
          kind: 'measurement',
          subject: 'measurement:sp1',
          label: 'Stockpile SP1',
          source: 'human',
          evidence: 'survey/measurements.json',
        },
        expect.objectContaining({ kind: 'volume', date: '2021-01-10', value: 1234.568 }),
      ],
      linked: [
        {
          rel: 'inside',
          kind: 'issue',
          subject: 'issue:I1',
          label: 'Crack D012',
          date: '2021-01-10',
          status: 'open',
          evidence: 'issues.json',
        },
      ],
      events: [{ label: 'Measurement edited', at: '2021-01-11T09:00:00Z', source: 'human' }],
    });
    expect(r.summary).toBe('Stockpile SP1: 4 entries');
  });

  it('resolves a name whose hits share one subject', async () => {
    const invoke = bridge({ hits: [sp1, sp1Volume], history: sp1History });
    await runRendererTool('history_of', { subject: 'Stockpile SP1' }, ctx());
    expect(invoke).toHaveBeenNthCalledWith(1, 'facts:query', {
      projectId: 'p1',
      query: { text: 'Stockpile SP1', limit: 10 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'facts:history', {
      projectId: 'p1',
      subject: 'measurement:sp1',
    });
  });

  it('takes the one subject named exactly when several match', async () => {
    const invoke = bridge({ hits: [sp10, sp1], history: sp1History });
    await runRendererTool('history_of', { subject: 'stockpile sp1' }, ctx());
    expect(invoke).toHaveBeenLastCalledWith('facts:history', {
      projectId: 'p1',
      subject: 'measurement:sp1',
    });
  });

  it('refuses a name that fits several things, listing them', async () => {
    const invoke = bridge({ hits: [sp1, sp10, crack] });
    await expect(runRendererTool('history_of', { subject: 'SP' }, ctx())).rejects.toThrow(
      /"SP" fits several things: measurement:sp1 \(measurement "Stockpile SP1"\), measurement:sp10 \(measurement "SP10"\), issue:I1 \(issue "Crack D012"\)/,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses a name nothing matches and a subject with no history', async () => {
    bridge({ hits: [] });
    await expect(runRendererTool('history_of', { subject: 'Tank T-999' }, ctx())).rejects.toThrow(
      /Nothing in the fact index is called "Tank T-999"/,
    );
    bridge({});
    await expect(runRendererTool('history_of', { subject: 'issue:I9' }, ctx())).rejects.toThrow(
      /nothing about "issue:I9"/,
    );
  });

  it('keeps the newest 60 of a long history and says so', async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      fact({
        id: `v${String(i)}`,
        kind: 'volume',
        subject: 'measurement:sp1',
        label: 'Stockpile SP1',
        value: i,
      }),
    );
    bridge({ history: (subject) => ({ ...emptyHistory(subject), facts: many }) });
    const r = await runRendererTool('history_of', { subject: 'measurement:sp1' }, ctx());
    const out = r.result as { facts: { value: number }[]; omitted: { facts: number } };
    expect(out.facts).toHaveLength(60);
    expect(out.facts[0]?.value).toBe(10);
    expect(out.omitted.facts).toBe(10);
  });
});
