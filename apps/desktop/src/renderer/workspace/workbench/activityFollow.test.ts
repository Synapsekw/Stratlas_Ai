// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { JobEntry } from '../../jobs';
import { followJobs, followPlayback } from './activityFollow';
import { personToolLive } from './tabsModel';
import { createWorkbenchStore, type WorkbenchState } from './workbenchStore';

vi.mock('../../issueCard/state', () => ({ isIssueEditing: () => false }));

const tab = (s: WorkbenchState, id: string) => s.tabs.find((t) => t.id === id);

const player = () => {
  const pause = vi.fn(() => {
    store.setState({ playing: false });
  });
  const store = createStore<{ playing: boolean; activeClip: string | null; pause: () => void }>()(
    () => ({ playing: false, activeClip: 'clip-1', pause }),
  );
  return { store, pause };
};

describe('followPlayback', () => {
  it('a playing clip makes Video live without taking the front, and its end lets it go', () => {
    const bench = createWorkbenchStore(null);
    const { store } = player();
    const off = followPlayback(store as never, bench);
    store.setState({ playing: true });
    expect(tab(bench.getState(), 'video')?.live).toBe(true);
    expect(bench.getState().front).toBe('selection');
    // not the person's tool: no drawer, no agent fold
    expect(bench.getState().toolSeq).toBe(0);
    expect(personToolLive(bench.getState().tabs)).toBe(false);
    store.setState({ playing: false });
    expect(tab(bench.getState(), 'video')).toBeUndefined();
    off();
  });

  it('closing the live Video tab with its X pauses the clip', () => {
    const bench = createWorkbenchStore(null);
    const { store, pause } = player();
    const off = followPlayback(store as never, bench);
    store.setState({ playing: true });
    bench.getState().close('video');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(tab(bench.getState(), 'video')).toBeUndefined();
    off();
  });

  it('lets the live tab go when it stops following', () => {
    const bench = createWorkbenchStore(null);
    const { store } = player();
    const off = followPlayback(store as never, bench);
    store.setState({ playing: true });
    off();
    expect(tab(bench.getState(), 'video')).toBeUndefined();
  });
});

const job = (over: Partial<JobEntry> = {}): JobEntry =>
  ({
    id: 'j1',
    pipeline: 'pointcloud.build',
    project: '/p',
    status: 'running',
    progress: 0.2,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }) as unknown as JobEntry;

describe('followJobs', () => {
  const stores = () => ({
    jobs: createStore<{ jobs: JobEntry[] }>()(() => ({ jobs: [] })),
    ws: createStore<{ project: { root: string } | null }>()(() => ({ project: { root: '/p' } })),
    sh: createStore<{ pkg: unknown }>()(() => ({ pkg: null })),
  });

  it('a running job makes Jobs live, and the last one ending lets it go', () => {
    const bench = createWorkbenchStore(null);
    const s = stores();
    const off = followJobs(s.jobs, s.ws as never, s.sh as never, bench);
    s.jobs.setState({ jobs: [job()] });
    expect(tab(bench.getState(), 'jobs')?.live).toBe(true);
    expect(bench.getState().front).toBe('selection');
    expect(bench.getState().toolSeq).toBe(0);
    s.jobs.setState({ jobs: [job(), job({ id: 'j2' })] });
    s.jobs.setState({ jobs: [job({ id: 'j2' })] });
    expect(tab(bench.getState(), 'jobs')?.live).toBe(true);
    s.jobs.setState({ jobs: [job({ id: 'j2', status: 'succeeded' } as never)] });
    expect(tab(bench.getState(), 'jobs')).toBeUndefined();
    off();
  });

  it("a quiet job, or another project's job, does not make Jobs live", () => {
    const bench = createWorkbenchStore(null);
    const s = stores();
    const off = followJobs(s.jobs, s.ws as never, s.sh as never, bench);
    s.jobs.setState({ jobs: [job({ quiet: true }), job({ id: 'j2', project: '/other' })] });
    expect(tab(bench.getState(), 'jobs')).toBeUndefined();
    off();
  });
});
