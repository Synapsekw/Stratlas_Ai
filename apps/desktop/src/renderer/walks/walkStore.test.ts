import { WALK_SCHEMA, type Layer, type WalkFile, type WalkLayer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createWalkStore, walkFilesMissing, walkFolderId, type WalkListCall } from './walkStore';

const record = (id: string): WalkFile => ({
  schema: WALK_SCHEMA,
  id,
  name: id,
  createdAt: '2026-10-11T08:00:00.000Z',
  source: {
    file: `${id}.insv`,
    layout: 'insv-dual-stream',
    streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }],
  },
  video: {
    src: `walks/${id}/playback.mp4`,
    width: 256,
    height: 128,
    durationS: 1,
    fps: 30,
    audio: false,
  },
});

const layer = (id: string): WalkLayer => ({
  kind: 'walk',
  id: `walk-${id}`,
  name: id,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/playback.mp4` },
  durationS: 12,
});

const other: Layer = {
  kind: 'vector',
  id: 'lines',
  name: 'Lines',
  visible: true,
  src: { path: 'lines.geojson' },
} as Layer;

const answers =
  (by: Record<string, WalkFile[]>): WalkListCall =>
  (projectId) =>
    Promise.resolve({ ok: true, value: { walks: by[projectId] ?? [] } });

describe('walk store', () => {
  it('lists the walk layers of the manifest in manifest order', async () => {
    const s = createWalkStore(answers({ p: [record('a'), record('b')] }));
    await s.getState().sync('p', [layer('b'), other, layer('a')]);
    expect(s.getState().walks.map((w) => w.id)).toEqual(['walk-b', 'walk-a']);
    expect(s.getState().records['walks/a/walk.json']?.id).toBe('a');
    await s.getState().sync(null, []);
    expect(s.getState()).toMatchObject({ projectId: null, walks: [], selected: null });
  });

  it('keeps the chosen walk across a manifest update, and drops it when it is gone', async () => {
    const s = createWalkStore(answers({ p: [record('a'), record('b')] }));
    await s.getState().sync('p', [layer('a'), layer('b')]);
    s.getState().select('walk-b');
    s.getState().select('nope');
    expect(s.getState().selected).toBe('walk-b');
    await s.getState().sync('p', [layer('a'), { ...layer('b'), name: 'Renamed' }]);
    expect(s.getState().selected).toBe('walk-b');
    await s.getState().sync('p', [layer('a')]);
    expect(s.getState().selected).toBeNull();
  });

  it('asks main for the records only when a walk layer is new to it', async () => {
    let calls = 0;
    const s = createWalkStore((projectId) => {
      calls += 1;
      return answers({ p: [record('a'), record('b')] })(projectId);
    });
    await s.getState().sync('p', [layer('a')]);
    await s.getState().sync('p', [{ ...layer('a'), name: 'Renamed' }]);
    expect(calls).toBe(1);
    await s.getState().sync('p', [layer('a'), layer('b')]);
    expect(calls).toBe(2);
  });

  it('says files are missing only for a walk main was asked about and did not list', async () => {
    const s = createWalkStore(answers({ p: [record('a')] }));
    expect(walkFilesMissing(s.getState(), layer('b'))).toBe(false);
    await s.getState().sync('p', [layer('a'), layer('b')]);
    expect(walkFilesMissing(s.getState(), layer('a'))).toBe(false);
    expect(walkFilesMissing(s.getState(), layer('b'))).toBe(true);
  });

  it('claims nothing missing when main cannot list the walks', async () => {
    const s = createWalkStore(() => Promise.resolve({ ok: false, error: 'not open' }));
    await s.getState().sync('p', [layer('a')]);
    expect(s.getState().walks).toHaveLength(1);
    expect(walkFilesMissing(s.getState(), layer('a'))).toBe(false);
  });

  it('drops an answer that arrives after the project changed', async () => {
    let release: (() => void) | undefined;
    const call: WalkListCall = async (projectId) => {
      if (projectId === 'slow')
        await new Promise<void>((r) => {
          release = r;
        });
      return { ok: true, value: { walks: [record(projectId)] } };
    };
    const s = createWalkStore(call);
    const slow = s.getState().sync('slow', [layer('slow')]);
    await s.getState().sync('fast', [layer('fast')]);
    release?.();
    await slow;
    expect(s.getState().projectId).toBe('fast');
    expect(Object.keys(s.getState().records)).toEqual(['walks/fast/walk.json']);
  });

  it('reads the walk folder id from the record path', () => {
    expect(walkFolderId(layer('site-tour'))).toBe('site-tour');
    expect(walkFolderId({ ...layer('x'), record: { path: 'odd.json' } })).toBe('walk-x');
  });
});
