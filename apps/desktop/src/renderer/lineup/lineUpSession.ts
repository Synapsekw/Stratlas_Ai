import {
  LineUpFit,
  LineUpMeasure,
  type CaptureLineUp,
  type CaptureLineUpTurn,
  type JobRecord,
  type PipelineName,
} from '@aio/schema';
import { t } from '@aio/ui';
import type { StoreApi } from 'zustand/vanilla';
import type { Box } from '../shell/layerBounds';
import { compareLineUpApp, createCompareLineUp } from './compareLineUpStore';
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
 * `lineup.json` and, beside it, `lineup-fit.json` (the turn and scale); the store and the background check are the ones of Task 20. Everything the app
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
 * Measure how far `move` sits from `keep`: start `change.lineup`, wait for it, read its answer
 * (`lineup.json`, with `fit` from `lineup-fit.json` when the job wrote one: an older pipeline pack
 * does not, and its answer stays a plain shift). Any failure (no project, a job that does not start or fails, an older pipeline pack without the
 * job, an unreadable answer) is `{ error }` with a sentence. The wait ends, and the job is
 * cancelled, when another project opens, when `signal` aborts, or after `MEASURE_LIMIT_MS`.
 */
export function measureWith(deps: LineUpSessionDeps): LineUpDeps['measure'] {
  const projectId = () => deps.workspace.getState().project?.id ?? null;
  return async (keep, move, signal) => {
    const root = deps.root();
    const opened = projectId();
    if (!root) return { error: t('lineUp.measure.noProject') };
    if (signal?.aborted) return { error: t('lineUp.measure.abandoned') };
    const started = await deps.start('change.lineup', root, { keep, move });
    if ('error' in started) return { error: started.error };
    const ctl = new AbortController();
    const stopped: {
      why:
        'lineUp.measure.switched' | 'lineUp.measure.timedOut' | 'lineUp.measure.abandoned' | null;
    } = { why: null };
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
    // the caller gave the measurement up (Compare moved to another pair of dates)
    const abandon = () => {
      stop('lineUp.measure.abandoned');
    };
    if (signal?.aborted) abandon();
    else signal?.addEventListener('abort', abandon, { once: true });
    let job: JobRecord | null;
    try {
      job = await deps.finished(started.jobId, ctl.signal);
    } finally {
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', abandon);
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
    let measured: LineUpMeasure;
    try {
      const parsed = LineUpMeasure.safeParse(
        await deps.readJson(`jobs/${started.jobId}/lineup.json`),
      );
      if (!parsed.success) return { error: t('lineUp.measure.unreadable') };
      measured = parsed.data;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    let raw: unknown;
    try {
      raw = await deps.readJson(`jobs/${started.jobId}/lineup-fit.json`);
    } catch {
      // no lineup-fit.json: an older pipeline pack, which measures a shift only
      return measured;
    }
    const fit = LineUpFit.safeParse(raw);
    return fit.success ? { ...measured, fit: fit.data } : { error: t('lineUp.measure.unreadable') };
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
 * (`lineUpApp`) and the Compare dates chip (`compareLineUpApp`). Call once; `stop` ends the check.
 */
export function createLineUpSession(deps: LineUpSessionDeps): LineUpSession {
  const measure = measureWith(deps);
  const store = createLineUpStore({ ...deps, measure });
  lineUpApp.setState({ store, preview: deps.preview, extents: deps.extents });
  // the Compare dates chip measures with the same job, one pair at a time
  const compare = createCompareLineUp({ measure, workspace: deps.workspace });
  compareLineUpApp.setState({ store: compare, workspace: deps.workspace });
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
      compare.getState().dispose();
      compareLineUpApp.setState({ store: null, workspace: null });
      lineUpApp.setState({ store: null, preview: null, extents: null });
    },
  };
}

/**
 * The two manifest writes the step needs, over the app's `builder:updateCapture` and layer save.
 * A line-up is always written with its turn: a `lineUp` sent alone would drop a stored turn.
 */
export function writersFor(io: {
  updateCapture: (
    captureId: string,
    patch: { lineUp: CaptureLineUp | null; lineUpTurn: CaptureLineUpTurn | null },
  ) => Promise<string | null>;
  saveLayers: (
    layerIds: readonly string[],
    patch: { capture: string | null },
  ) => Promise<string | null>;
}): Pick<LineUpDeps, 'saveCapture' | 'pinCaptures'> {
  return {
    saveCapture: (captureId, lineUp, lineUpTurn) =>
      io.updateCapture(captureId, { lineUp, lineUpTurn: lineUp ? lineUpTurn : null }),
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
