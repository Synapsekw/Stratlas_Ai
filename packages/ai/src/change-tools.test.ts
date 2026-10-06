import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';
import { approvalFor, getToolSpec, riskOf } from './tools';

const set = {
  schema: 'aio.change/1',
  id: 'c1-c2-issues',
  from: 'c1',
  to: 'c2',
  producer: 'issues',
  createdAt: '2026-10-06T08:00:00Z',
  items: [
    { kind: 'issue', id: 'issue:D03', verdict: 'new', to: 'c', at: [1, 2, 3] },
    { kind: 'issue', id: 'issue:D01', verdict: 'grown', from: 'a', to: 'b' },
    {
      kind: 'issue',
      id: 'issue:D02',
      verdict: 'resolved',
      from: 'b',
      review: { status: 'confirmed', by: 'x', at: '2026-10-06T09:00:00Z' },
    },
    { kind: 'issue', id: 'issue:D04', verdict: 'unchanged', from: 'a', to: 'a' },
  ],
  layers: [],
  stats: {},
};

function workspace() {
  const ws = fixtureWorkspace();
  ws.getState().openProject(
    {
      id: 'p1',
      root: 'E:/x',
      manifest: {
        ...fixtureManifest(),
        captures: [
          { id: 'c1', label: 'Survey 1', date: '2026-01-01' },
          { id: 'c2', label: 'Survey 2', date: '2026-06-01' },
        ],
      },
    },
    [fixtureIssue({ id: 'c', code: 'D03' })],
  );
  return ws;
}

function ctx(ws = workspace()): RendererToolContext {
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-06T12:00:00Z'),
  };
}

function bridge(sets: unknown[] = [set]) {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'change:list')
      return Promise.resolve({
        ok: true,
        readOnly: false,
        problems: [],
        sets: sets.map((s) => {
          const x = s as typeof set;
          return {
            id: x.id,
            from: x.from,
            to: x.to,
            producer: x.producer,
            createdAt: x.createdAt,
            items: x.items.length,
            open: 3,
          };
        }),
      });
    if (channel === 'change:read')
      return Promise.resolve({ ok: true, set: sets[0], readOnly: false });
    if (channel === 'change:compute') return Promise.resolve({ ok: true, ids: ['c1-c2-issues'] });
    return Promise.reject(new Error(channel));
  });
  (globalThis as { aio?: unknown }).aio = { invoke, on: () => () => undefined };
  return invoke;
}

afterEach(() => {
  delete (globalThis as { aio?: unknown }).aio;
});

describe('change tools', () => {
  it('are in the catalogue with their risks', () => {
    expect(getToolSpec('list_changes')?.meta.risk).toBe('read');
    expect(riskOf('show_change')).toBe('navigate');
    expect(riskOf('run_change_detection')).toBe('write');
    expect(approvalFor('run_change_detection')).toBe(true);
  });

  it('compare_captures v2 reads the change sets of the pair', async () => {
    bridge();
    const r = await runRendererTool('compare_captures', {}, ctx());
    expect(r.result).toMatchObject({
      kind: 'changes',
      from: { captureId: 'c1' },
      to: { captureId: 'c2' },
      total: 4,
      toReview: 3,
      byKind: { issue: { new: 1, grown: 1, resolved: 1, unchanged: 1 } },
    });
    expect(r.summary).toBe('1 new, 1 grown, 1 resolved');
  });

  it('compare_captures falls back to issue counts without change sets', async () => {
    bridge([]);
    const r = await runRendererTool('compare_captures', {}, ctx());
    expect(r.result).toMatchObject({ kind: 'issues' });
  });

  it('lists changes with filters', async () => {
    bridge();
    const r = await runRendererTool('list_changes', { verdict: 'new' }, ctx());
    expect(r.result).toMatchObject({ total: 1, items: [{ id: 'issue:D03', review: 'open' }] });
    const confirmed = await runRendererTool('list_changes', { status: 'confirmed' }, ctx());
    expect(confirmed.result).toMatchObject({ total: 1, items: [{ id: 'issue:D02' }] });
  });

  it('shows a change: selects the later issue and flies there, with undo', async () => {
    bridge();
    const ws = workspace();
    const r = await runRendererTool('show_change', { id: 'issue:D03' }, ctx(ws));
    expect(ws.getState().selection).toEqual({ kind: 'issue', id: 'c' });
    expect(ws.getState().camera?.target).toEqual({ kind: 'point', p: [1, 2, 3], distance: 25 });
    r.undo?.();
    expect(ws.getState().selection).toBeNull();
    await expect(runRendererTool('show_change', { id: 'nope' }, ctx())).rejects.toThrow(
      /list_changes/,
    );
  });

  it('runs the in-app comparison of the pair', async () => {
    const invoke = bridge();
    const r = await runRendererTool('run_change_detection', { from: 'Survey 2', to: 'c1' }, ctx());
    expect(invoke).toHaveBeenCalledWith(
      'change:compute',
      expect.objectContaining({
        projectId: 'p1',
        from: 'c1',
        to: 'c2',
        kinds: ['issue', 'detection', 'vector'],
      }),
    );
    expect(r.result).toMatchObject({ written: ['c1-c2-issues'], total: 4 });
  });
});
