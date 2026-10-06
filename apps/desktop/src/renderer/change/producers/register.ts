/**
 * Every change producer of the app, registered once at start (M8 integration): imagery and
 * surface change (C2), cloud and model change (C3) and matched frames (C4). The Changes panel
 * lists them from the `@aio/change` registry and updates when it changes. A finished change run
 * reloads the manifest through `MANIFEST_WRITERS` (`jobs.ts`) and the change sets of the project.
 *
 * Player mode (a `.aio` package) never computes: the producers see no project folder there.
 */
import { DEFAULT_CHANGE_THRESHOLDS } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { jobs, shell } from '../../shell';
import { registerCloudChangeProducers, type ChangeJob } from './cloud';
import { ensureFramesProducer } from './frames';
import { registerImageryProducers } from './raster';

/** The open project's folder; null without one, or for a package. */
function projectRoot(): string | null {
  return shell.getState().pkg ? null : (workspace.getState().project?.root ?? null);
}

/** Start a job through the Jobs store: its id, or why it did not start. */
export async function startChangeJob(
  job: ChangeJob,
): Promise<{ jobId?: string } | { error: string }> {
  const error = await jobs.getState().start(job);
  if (error) return { error };
  const id = jobs.getState().selected;
  return id ? { jobId: id } : {};
}

let registered = false;

/** Register the producers once (a second call does nothing). */
export function registerAppChangeProducers(): void {
  if (registered) return;
  registered = true;
  registerImageryProducers({
    root: projectRoot,
    thresholds: () => shell.getState().settings.change,
    start: async (pipeline, project, params) => {
      const r = await startChangeJob({ pipeline, project, params });
      if ('error' in r) return r;
      return r.jobId ? { jobId: r.jobId } : { error: 'The job did not start.' };
    },
  });
  registerCloudChangeProducers({
    projectRoot,
    thresholds: () => shell.getState().settings.change ?? DEFAULT_CHANGE_THRESHOLDS,
    start: startChangeJob,
  });
  ensureFramesProducer({
    root: (id) =>
      workspace.getState().project?.id === id ? (projectRoot() ?? undefined) : undefined,
    start: async (req) => {
      const r = await startChangeJob(req);
      if ('error' in r) return { ok: false, error: r.error };
      return r.jobId ? { ok: true, jobId: r.jobId } : { ok: true };
    },
  });
}
