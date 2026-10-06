import { ChangeSet } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChangeStore, setsOfPair } from './store';

const set = ChangeSet.parse({
  schema: 'aio.change/1',
  id: 'd1-d2-issues',
  from: 'd1',
  to: 'd2',
  producer: 'issues',
  createdAt: '2026-10-06T08:00:00Z',
  items: [
    { kind: 'issue', id: 'issue:F01', verdict: 'new', at: [1, 2, 3] },
    { kind: 'issue', id: 'issue:F02', verdict: 'resolved' },
  ],
});

function fakeBridge(readOnly = false) {
  const written: unknown[] = [];
  const invoke = vi.fn((channel: string, req: { set?: unknown }) => {
    switch (channel) {
      case 'change:list':
        return Promise.resolve({
          ok: true,
          sets: [
            {
              id: set.id,
              from: 'd1',
              to: 'd2',
              producer: 'issues',
              createdAt: set.createdAt,
              items: 2,
              open: 2,
            },
          ],
          problems: [],
          readOnly,
        });
      case 'change:read':
        return Promise.resolve({ ok: true, set, readOnly });
      case 'change:write':
        written.push(req.set);
        return Promise.resolve({ ok: true });
      case 'change:compute':
        return Promise.resolve({ ok: true, ids: [set.id] });
      default:
        return Promise.resolve({ ok: false, error: 'no' });
    }
  });
  (globalThis as { aio?: unknown }).aio = { invoke, on: () => () => undefined };
  return { invoke, written };
}

afterEach(() => {
  delete (globalThis as { aio?: unknown }).aio;
});

describe('the Changes store', () => {
  it('loads the sets of a project and the pair shows them', async () => {
    fakeBridge();
    const s = createChangeStore();
    await s.getState().load('p');
    expect(Object.keys(s.getState().sets)).toEqual(['d1-d2-issues']);
    s.getState().setPair({ from: 'd1', to: 'd2' });
    expect(setsOfPair(s.getState().sets, s.getState().pair)).toHaveLength(1);
    expect(setsOfPair(s.getState().sets, { from: 'd2', to: 'd3' })).toHaveLength(0);
  });

  it('flies to an item when it is picked', async () => {
    fakeBridge();
    const s = createChangeStore();
    await s.getState().load('p');
    s.getState().select({ setId: 'd1-d2-issues', itemId: 'issue:F01' });
    expect(workspace.getState().camera?.target).toEqual({
      kind: 'point',
      p: [1, 2, 3],
      distance: 25,
    });
  });

  it('saves a review and refuses in a package', async () => {
    const { written } = fakeBridge();
    const s = createChangeStore();
    await s.getState().load('p');
    const review = { status: 'dismissed' as const, by: 'me', at: '2026-10-06T09:00:00Z' };
    expect(await s.getState().review({ setId: set.id, itemId: 'issue:F02' }, review)).toBe(true);
    expect(written).toHaveLength(1);
    expect(s.getState().sets[set.id]?.items[1]?.review).toEqual(review);

    fakeBridge(true);
    const ro = createChangeStore();
    await ro.getState().load('pkg');
    expect(await ro.getState().review({ setId: set.id, itemId: 'issue:F02' }, review)).toBe(false);
    expect(ro.getState().error).toMatch(/read-only/);
  });

  it('computes for the pair and reloads', async () => {
    const { invoke } = fakeBridge();
    const s = createChangeStore();
    await s.getState().load('p');
    s.getState().setPair({ from: 'd1', to: 'd2' });
    expect(await s.getState().compute(['issue'])).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'change:compute',
      expect.objectContaining({ projectId: 'p', from: 'd1', to: 'd2', kinds: ['issue'] }),
    );
    expect(s.getState().run).toBeNull();
  });
});
