/**
 * The activities that go live in the sidebar beside the person's tools (stage island D11, I-R62):
 * a playing clip makes the Video tab live ("Video ●"), and running jobs that are not quiet make
 * the Jobs tab live ("Jobs ●"). Each lets its tab go when it ends. They are not the person's tool:
 * they take no front, open no drawer and leave the agent as it is (I-R39, I-R43), so they go
 * through `activityStarted`, not `toolStarted`. They run for the whole app, not the Scene, so
 * leaving the Scene leaves nothing out of step.
 */
import { workspace, type Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import type { Jobs } from '../../jobs';
import { jobs, shell } from '../../shell';
import type { Shell } from '../../store';
import { liveJobs } from '../island/useIslandLive';
import type { TabId } from './tabsModel';
import { linkLiveTab, workbench, type WorkbenchState } from './workbenchStore';

type Subscribable<S> = Pick<StoreApi<S>, 'getState' | 'subscribe'>;

/** Keep `id` live exactly while `want()` holds, checked on every change of `sources`. */
function followActivity(
  id: TabId,
  want: () => boolean,
  sources: readonly Pick<StoreApi<unknown>, 'subscribe'>[],
  bench: StoreApi<WorkbenchState>,
): () => void {
  let live = false;
  const sync = () => {
    const now = want();
    if (now === live) return;
    live = now;
    if (now) bench.getState().activityStarted(id);
    else bench.getState().activityStopped(id);
  };
  sync();
  const offs = sources.map((s) =>
    s.subscribe(() => {
      sync();
    }),
  );
  return () => {
    for (const off of offs) off();
    if (live) bench.getState().activityStopped(id);
  };
}

/**
 * A playing clip makes the Video tab live; the clip paused or ended lets it go. Closing the live
 * tab with its X pauses the clip, as closing a live tool's tab stops the tool. Returns unsubscribe.
 */
export function followPlayback(
  ws: Subscribable<Workspace> & Pick<StoreApi<Workspace>, 'getState'> = workspace,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  const playing = () => {
    const s = ws.getState();
    return s.playing && s.activeClip !== null;
  };
  const offTab = linkLiveTab(
    'video',
    playing,
    () => {
      ws.getState().pause();
    },
    bench,
  );
  const off = followActivity('video', playing, [ws], bench);
  return () => {
    offTab();
    off();
  };
}

/**
 * The open project's running jobs that are not quiet (the island's live jobs) make the Jobs tab
 * live; the last one ending lets it go. Closing the tab cancels nothing: a job is stopped from its
 * row. Returns unsubscribe.
 */
export function followJobs(
  jobStore: Subscribable<Pick<Jobs, 'jobs'>> = jobs,
  ws: Subscribable<Workspace> = workspace,
  sh: Subscribable<Pick<Shell, 'pkg'>> = shell,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  const running = () =>
    liveJobs(
      jobStore.getState().jobs,
      ws.getState().project?.root ?? null,
      sh.getState().pkg !== null,
    ).length > 0;
  return followActivity('jobs', running, [jobStore, ws, sh], bench);
}

/** Both activity followers, for the app's lifetime. Returns unsubscribe. */
export function startActivityFollow(): () => void {
  const off = [followPlayback(), followJobs()];
  return () => {
    for (const o of off) o();
  };
}
