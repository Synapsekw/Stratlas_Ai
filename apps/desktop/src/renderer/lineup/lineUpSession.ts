import { LineUpMeasure, type CaptureLineUp, type JobRecord, type PipelineName } from '@aio/schema';
import { t } from '@aio/ui';
import type { StoreApi } from 'zustand/vanilla';
import type { Box } from '../shell/layerBounds';
import {
  createLineUpStore,
  lineUpApp,
  type LineUpDeps,
  type LineUpPreview,
  type LineUpStore,
} from './lineUpStore';
import { watchLineUps } from './lineUpWatch';

/**
 * The app's line-up step, built from what the app offers (`lineUpStart.ts` supplies the real
 * pieces): `measure` runs `change.lineup` through the jobs store, waits for it and reads its
 * `lineup.json`; the store and the background check are the ones of Task 20. Everything the app
 * owns comes in through `deps`, so this file runs in tests without the app.
 */

export interface LineUpSessionDeps extends Omit<LineUpDeps, 'measure'> {
  /** The open project's folder, or null (no project, or a package: nothing is measured). */
  root: () => string | null;
  /** Start a pipeline job: its id, or an error sentence. */
  start(
    pipeline: PipelineName,
    project: string,
    params: Record<string, unknown>,
  ): Promise<{ jobId: string } | { error: string }>;
  /** The job's record once it has ended; null when it is unknown or `signal` aborted first. */
  finished: (jobId: string, signal: AbortSignal) => Promise<JobRecord | null>;
  /** Ask a job to stop (a measurement given up on). */
  cancel: (jobId: string) => void;
  /** A JSON file of the open project, by project-relative path (throws when it cannot be read). */
  readJson: (path: string) => Promise<unknown>;
  /** Each layer's box in the local frame, as placed now. */
  extents: () => Promise<Record<string, Box>>;
  /** The pipeline Python is installed. */
  hasPython: () => boolean;
  /** Call `cb` when the pipeline Python turns up later; returns the stop. */
  onReady?: (cb: () => void) => () => void;
  preview: LineUpPreview;
}

/** The longest a measurement may take before it is given up on (10 minutes). */
export const MEASURE_LIMIT_MS = 10 * 60 * 1000;

const ENDED = {
  failed: 'lineUp.measure.failed',
  cancelled: 'lineUp.measure.cancelled',
  interrupted: 'lineUp.measure.interrupted',
} as const;

/**
 * Measure how far `move` sits from `keep`: start `change.lineup`, wait for it, read its answer.
 * Any failure (no project, a job that does not start or fails, an older pipeline pack without the
 * job, an unreadable answer) is `{ error }` with a sentence. The wait ends, and the job is
 * cancelled, when another project opens or after `MEASURE_LIMIT_MS`.
 */
export function measureWith(deps: LineUpSessionDeps): LineUpDeps['measure'] {
  const projectId = () => deps.workspace.getState().project?.id ?? null;
  return async (keep, move) => {
    const root = deps.root();
    const opened = projectId();
    if (!root) return { error: t('lineUp.measure.noProject') };
    const started = await deps.start('change.lineup', root, { keep, move });
    if ('error' in started) return { error: started.error };
    const ctl = new AbortController();
    const stopped: { why: 'lineUp.measure.switched' | 'lineUp.measure.timedOut' | null } = {
      why: null,
    };
    const stop = (reason: NonNullable<typeof stopped.why>) => {
      stopped.why ??= reason;
      ctl.abort();
    };
    const off = deps.workspace.subscribe(() => {
      if (projectId() !== opened) stop('lineUp.measure.switched');
    });
    const timer = setTimeout(() => {
      stop('lineUp.measure.timedOut');
    }, MEASURE_LIMIT_MS);
    let job: JobRecord | null;
    try {
      job = await deps.finished(started.jobId, ctl.signal);
    } finally {
      clearTimeout(timer);
      off();
    }
    if (stopped.why) {
      deps.cancel(started.jobId);
      return { error: t(stopped.why) };
    }
    if (!job) return { error: t('lineUp.measure.notFinished') };
    if (job.status !== 'done') {
      const key =
        job.status === 'cancelled' || job.status === 'interrupted'
          ? ENDED[job.status]
          : ENDED.failed;
      return { error: job.error ?? t(key) };
    }
    try {
      const parsed = LineUpMeasure.safeParse(
        await deps.readJson(`jobs/${started.jobId}/lineup.json`),
      );
      return parsed.success ? parsed.data : { error: t('lineUp.measure.unreadable') };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export interface LineUpSession {
  store: StoreApi<LineUpStore>;
  measure: LineUpDeps['measure'];
  /** Stop the background check. */
  stop: () => void;
}

/**
 * Make the step and its background check, and hand them to the dialog, the offer and the notice
 * (`lineUpApp`). Call once; `stop` ends the check.
 */
export function createLineUpSession(deps: LineUpSessionDeps): LineUpSession {
  const measure = measureWith(deps);
  const store = createLineUpStore({ ...deps, measure });
  lineUpApp.setState({ store, preview: deps.preview, extents: deps.extents });
  const stopWatch = watchLineUps({
    store,
    workspace: deps.workspace,
    extents: deps.extents,
    measure,
    memory: deps.memory,
    hasPython: deps.hasPython,
    ...(deps.onReady ? { onReady: deps.onReady } : {}),
  });
  return {
    store,
    measure,
    stop: () => {
      stopWatch();
      lineUpApp.setState({ store: null, preview: null, extents: null });
    },
  };
}

/** The two manifest writes the step needs, over the app's `builder:updateCapture` and layer save. */
export function writersFor(io: {
  updateCapture: (
    captureId: string,
    patch: { lineUp: CaptureLineUp | null },
  ) => Promise<string | null>;
  saveLayers: (
    layerIds: readonly string[],
    patch: { capture: string | null },
  ) => Promise<string | null>;
}): Pick<LineUpDeps, 'saveCapture' | 'pinCaptures'> {
  return {
    saveCapture: (captureId, lineUp) => io.updateCapture(captureId, { lineUp }),
    pinCaptures: (layerIds, captureId) => io.saveLayers(layerIds, { capture: captureId }),
  };
}

/** A store with a notice that may offer Undo or Redo (Align to, Drop to ground, this step). */
interface NoticeStore {
  notice: unknown;
  dismiss: () => void;
}

/**
 * One Ctrl+Z owner: a newer notice with Undo or Redo (`action`) in `ours` sends the `others`
 * away, and a newer one in any of the others sends `ours` away. Returns the stop.
 */
export function linkNotices(
  ours: StoreApi<NoticeStore>,
  others: readonly StoreApi<NoticeStore>[],
): () => void {
  const offers = (s: NoticeStore) =>
    typeof s.notice === 'object' && s.notice !== null && 'action' in s.notice && !!s.notice.action;
  const stops = [
    ours.subscribe((s, prev) => {
      if (offers(s) && s.notice !== prev.notice)
        for (const o of others) {
          o.getState().dismiss();
        }
    }),
    ...others.map((o) =>
      o.subscribe((s, prev) => {
        if (offers(s) && s.notice !== prev.notice) ours.getState().dismiss();
      }),
    ),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
