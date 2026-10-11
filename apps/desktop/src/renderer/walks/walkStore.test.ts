import { WALK_SCHEMA, type WalkFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createWalkStore, type WalkListCall } from './walkStore';

const walk = (id: string): WalkFile => ({
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

const answers =
  (by: Record<string, WalkFile[]>): WalkListCall =>
  (projectId) =>
    Promise.resolve({ ok: true, value: { walks: by[projectId] ?? [] } });

describe('walk store', () => {
  it('loads the walks of the open project and clears them when it closes', async () => {
    const s = createWalkStore(answers({ p: [walk('a'), walk('b')] }));
    await s.getState().load('p');
    expect(s.getState().walks.map((w) => w.id)).toEqual(['a', 'b']);
    await s.getState().load(null);
    expect(s.getState()).toMatchObject({ projectId: null, walks: [], selected: null });
  });

  it('keeps the chosen walk over a reload, and drops it when it is gone', async () => {
    const by = { p: [walk('a'), walk('b')] };
    const s = createWalkStore(answers(by));
    await s.getState().load('p');
    s.getState().select('b');
    s.getState().select('nope');
    expect(s.getState().selected).toBe('b');
    await s.getState().load('p');
    expect(s.getState().selected).toBe('b');
    by.p = [walk('a')];
    await s.getState().load('p');
    expect(s.getState().selected).toBeNull();
  });

  it('drops an answer that arrives after the project changed', async () => {
    let release: (() => void) | undefined;
    const call: WalkListCall = async (projectId) => {
      if (projectId === 'slow')
        await new Promise<void>((r) => {
          release = r;
        });
      return { ok: true, value: { walks: [walk(projectId)] } };
    };
    const s = createWalkStore(call);
    const slow = s.getState().load('slow');
    await s.getState().load('fast');
    release?.();
    await slow;
    expect(s.getState().projectId).toBe('fast');
    expect(s.getState().walks.map((w) => w.id)).toEqual(['fast']);
  });

  it('shows no walks when main cannot list them', async () => {
    const s = createWalkStore(() => Promise.resolve({ ok: false, error: 'not open' }));
    await s.getState().load('p');
    expect(s.getState().walks).toEqual([]);
  });
});
