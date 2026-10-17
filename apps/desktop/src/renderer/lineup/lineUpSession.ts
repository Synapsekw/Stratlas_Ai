import { LineUpMeasure, type JobRecord, type PipelineName } from '@aio/schema';
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
  /** The job's record once it has ended (null when unknown). */
  finished: (jobId: string) => Promise<JobRecord | null>;
  /** A JSON file of the open project, by project-relative path (throws when it cannot be read). */
  readJson: (path: string) => Promise<unknown>;
  /** Each layer's box in the local frame, as placed now. */
  extents: () => Promise<Record<string, Box>>;
  /** The pipeline Python is installed. */
  hasPython: () => boolean;
  preview: LineUpPreview;
}

/**
 * Measure how far `move` sits from `keep`: start `change.lineup`, wait for it, read its answer.
 * Any failure (no project, a job that does not start or fails, an older pipeline pack without the
 * job, an unreadable answer) is `{ error }` with a sentence.
 */
export function measureWith(deps: LineUpSessionDeps): LineUpDeps['measure'] {
  return async (keep, move) => {
    const root = deps.root();
    if (!root) return { error: 'Open a project first.' };
    const started = await deps.start('change.lineup', root, { keep, move });
    if ('error' in started) return { error: started.error };
    const job = await deps.finished(started.jobId);
    if (!job) return { error: 'The job did not finish.' };
    if (job.status !== 'done') return { error: job.error ?? `The job ${job.status}.` };
    try {
      const parsed = LineUpMeasure.safeParse(
        await deps.readJson(`jobs/${started.jobId}/lineup.json`),
      );
      return parsed.success ? parsed.data : { error: 'The measurement could not be read.' };
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
