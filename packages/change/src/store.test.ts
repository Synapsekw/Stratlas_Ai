import { ChangeSet } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { areasOfPair, createChangeStore, setsOfPair, volumesNote } from './store';

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
    expect(await s.getState().compute(['issue'])).toBe('done');
    expect(invoke).toHaveBeenCalledWith(
      'change:compute',
      expect.objectContaining({ projectId: 'p', from: 'd1', to: 'd2', kinds: ['issue'] }),
    );
    expect(s.getState().run).toBeNull();
  });

  it('computes a given pair without moving the panel, and says how the run ended', async () => {
    const { invoke } = fakeBridge();
    const s = createChangeStore();
    await s.getState().load('p');
    s.getState().setPair({ from: 'd1', to: 'd2' });
    expect(await s.getState().compute(['issue'], { from: 'd2', to: 'd3' })).toBe('done');
    expect(invoke).toHaveBeenCalledWith(
      'change:compute',
      expect.objectContaining({ from: 'd2', to: 'd3' }),
    );
    expect(s.getState().pair).toEqual({ from: 'd1', to: 'd2' });

    // a run the person cancels ends `cancelled`, a refused one `failed`
    let release: (v: { ok: boolean; error?: string }) => void = () => undefined;
    invoke.mockImplementation((channel: string) =>
      channel === 'change:compute'
        ? new Promise<{ ok: boolean; error?: string }>((r) => {
            release = r;
          })
        : Promise.resolve({ ok: true }),
    );
    const running = s.getState().compute(['issue'], { from: 'd2', to: 'd3' });
    await Promise.resolve();
    // tagged with its pair, so the panel does not show it as its own
    expect(s.getState().run?.pair).toEqual({ from: 'd2', to: 'd3' });
    // the outcome race: a second compute while one runs does not start
    expect(await s.getState().compute(['issue'])).toBeNull();
    await s.getState().cancel();
    release({ ok: false, error: 'Cancelled.' });
    expect(await running).toBe('cancelled');
    invoke.mockImplementation(() => Promise.resolve({ ok: false, error: 'no' }));
    expect(await s.getState().compute(['issue'], { from: 'd2', to: 'd3' })).toBe('failed');
  });

  it("leaves the panel's refused run and error alone when it computes another pair", async () => {
    const { invoke } = fakeBridge();
    const s = createChangeStore();
    await s.getState().load('p');
    s.getState().setPair({ from: 'd1', to: 'd2' });
    const refused = { from: 'd1', to: 'd2', shiftM: 2.01, producer: 'imagery' };
    s.getState().setMisaligned(refused);
    s.getState().setError('The panel said this.');
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'change:compute' ? { ok: false, error: 'other pair' } : { ok: true },
      ),
    );
    expect(await s.getState().compute(['issue'], { from: 'd2', to: 'd3' })).toBe('failed');
    expect(s.getState().misaligned).toEqual(refused);
    expect(s.getState().error).toBe('The panel said this.');
    // the panel's own pair: its line shows the failure
    expect(await s.getState().compute(['issue'])).toBe('failed');
    expect(s.getState().misaligned).toBeNull();
    expect(s.getState().error).toBe('other pair');
  });

  it('keeps a refused run for the panel until a run starts or the project changes', async () => {
    fakeBridge();
    const s = createChangeStore();
    const refused = { from: 'd1', to: 'd2', shiftM: 2.01, producer: 'imagery' };
    await s.getState().load('p');
    expect(s.getState().misaligned).toBeNull();
    s.getState().setMisaligned(refused);
    expect(s.getState().misaligned).toEqual(refused);
    s.getState().setMisaligned(null);
    expect(s.getState().misaligned).toBeNull();
    s.getState().setMisaligned(refused);
    s.getState().setPair({ from: 'd1', to: 'd2' });
    await s.getState().compute(['issue']);
    expect(s.getState().misaligned).toBeNull();
    s.getState().setMisaligned(refused);
    await s.getState().load('other');
    expect(s.getState().misaligned).toBeNull();
  });
});

describe('area entries', () => {
  const pair = { from: 'd1', to: 'd2' };
  const mk = (id: string, producer: string, extra: object = {}) =>
    ChangeSet.parse({ ...set, id, producer, ...extra });
  const area = { id: 'a', name: 'Area A' };
  const whole = mk('d1-d2-raster', 'change.raster');
  const aRaster = mk('d1-d2-raster-area-a', 'change.raster', { scope: area });
  const aSurface = mk('d1-d2-surface-area-a', 'change.surface', { scope: area });
  const sets = Object.fromEntries([whole, aRaster, aSurface].map((x) => [x.id, x]));

  it('the whole map and each area are separate entries', () => {
    expect(setsOfPair(sets, pair).map((x) => x.id)).toEqual(['d1-d2-raster']);
    expect(setsOfPair(sets, pair, 'a').map((x) => x.id)).toEqual([
      'd1-d2-raster-area-a',
      'd1-d2-surface-area-a',
    ]);
    expect(areasOfPair(sets, pair)).toEqual([area]);
  });

  it('another pair resets the area, the same pair keeps it', () => {
    const store = createChangeStore();
    store.getState().setPair(pair);
    store.getState().setArea('a');
    store.getState().setPair({ ...pair });
    expect(store.getState().area).toBe('a');
    store.getState().setPair({ from: 'd2', to: 'd3' });
    expect(store.getState().area).toBeNull();
    expect(store.getState().selected).toBeNull();
  });

  it('an area whose volumes were refused says why', () => {
    const why = { reason: 'No elevation model on one date.', at: '2026-10-19T08:00:00Z' };
    const refused = mk('d1-d2-raster-area-a', 'change.raster', {
      scope: area,
      volumesMissing: why,
    });
    expect(volumesNote([refused])).toBe(why.reason);
    expect(volumesNote([refused, { ...aSurface, createdAt: '2026-10-19T09:00:00Z' }])).toBeNull();
    expect(volumesNote([])).toBeNull();
    expect(volumesNote([refused, mk('d1-d2-issues-area-a', 'issues', { scope: area })])).toBe(
      why.reason,
    );
  });

  it('words a stored reason code in the person language', () => {
    const at = '2026-10-19T08:00:00Z';
    const note = (missing: object) =>
      volumesNote([
        mk('d1-d2-raster-area-a', 'change.raster', {
          scope: area,
          volumesMissing: { at, ...missing },
        }),
      ]);
    expect(note({ reason: 'misaligned', shiftM: 2.04 })).toBe(
      t('change.area.why.misaligned', { shift: '2.0' }),
    );
    expect(note({ reason: 'failed', detail: 'Out of memory.' })).toBe('Out of memory.');
    expect(note({ reason: 'failed' })).toBe(t('change.area.why.failed'));
    expect(note({ reason: 'cancelled' })).toBe(t('change.area.why.cancelled'));
    expect(note({ reason: 'notStarted' })).toBe(t('change.area.why.notStarted'));
    expect(note({ reason: 'packTooOld' })).toBe(t('change.area.why.packTooOld'));
    expect(note({ reason: 'unavailable', detail: 'No DSM on one date.' })).toBe(
      'No DSM on one date.',
    );
  });

  it('a volume run that failed after an older one still says why', () => {
    // the surface set is from a run before the note: the latest volume run did not come through
    const older = mk('d1-d2-surface-area-a', 'change.surface', {
      scope: area,
      createdAt: '2026-10-19T07:00:00Z',
    });
    const refused = mk('d1-d2-raster-area-a', 'change.raster', {
      scope: area,
      volumesMissing: { reason: 'cancelled', at: '2026-10-19T08:00:00Z' },
    });
    expect(volumesNote([refused, older])).toBe(t('change.area.why.cancelled'));
    const newer = { ...older, createdAt: '2026-10-19T09:00:00Z' };
    expect(volumesNote([refused, newer])).toBeNull();
  });

  it('groups a set an older build wrote back without its scope under its area', () => {
    const stripped = mk('d1-d2-raster-area-a', 'change.raster');
    const all = { whole, [stripped.id]: stripped };
    expect(setsOfPair(all, pair).map((x) => x.id)).toEqual(['d1-d2-raster']);
    expect(setsOfPair(all, pair, 'a').map((x) => x.id)).toEqual(['d1-d2-raster-area-a']);
    expect(areasOfPair(all, pair)).toEqual([{ id: 'a', name: 'a' }]);
  });
});
