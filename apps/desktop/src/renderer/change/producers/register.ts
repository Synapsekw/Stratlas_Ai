/**
 * Every change producer of the app, registered once at start (M8 integration): imagery and
 * surface change (C2), cloud and model change (C3) and matched frames (C4). The Changes panel
 * lists them from the `@aio/change` registry and updates when it changes. A finished change run
 * reloads the manifest through `MANIFEST_WRITERS` (`jobs.ts`) and the change sets of the project.
 *
 * The agent's `run_change_detection` runs the same producers through `setChangeProducerRunner`.
 *
 * Player mode (a `.aio` package) never computes: the producers see no project folder there.
 */
import { setChangeProducerRunner, type ChangeProducerRun } from '@aio/ai';
import { changeProducers, layersOf, type ChangePairContext } from '@aio/change';
import { DEFAULT_CHANGE_THRESHOLDS } from '@aio/schema';
import { pointcloudSettings } from '@aio/pointcloud';
import { volumetric } from '@aio/volumetric';
import { captureIndex, workspace } from '@aio/workspace';
import { jobs, shell } from '../../shell';
import { volumeHints } from '../../workspace/compare';
import { cloudChangeFinished, registerCloudChangeProducers, type ChangeJob } from './cloud';
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

/** The pair context of the open project, as the Changes panel builds it. */
function pairContext(projectId: string, from: string, to: string): ChangePairContext | null {
  const project = workspace.getState().project;
  if (project?.id !== projectId) return null;
  const index = captureIndex(project.manifest, volumeHints(volumetric.getState()));
  return {
    projectId,
    manifest: project.manifest,
    from,
    to,
    layersFrom: layersOf(index, project.manifest.layers, from),
    layersTo: layersOf(index, project.manifest.layers, to),
  };
}

/** Run registered producers for a pair (the agent's hook); `all` skips those without data. */
export async function runChangeProducers(req: {
  projectId: string;
  from: string;
  to: string;
  ids: readonly string[] | 'all';
}): Promise<ChangeProducerRun[]> {
  const ctx = pairContext(req.projectId, req.from, req.to);
  if (!ctx) return [];
  const all = changeProducers();
  const chosen = req.ids === 'all' ? all : all.filter((p) => req.ids.includes(p.id));
  const out: ChangeProducerRun[] = [];
  for (const id of req.ids === 'all' ? [] : req.ids)
    if (!all.some((p) => p.id === id))
      out.push({ id, label: id, ok: false, error: 'Not available in this app.' });
  for (const p of chosen) {
    const ok = p.available(ctx);
    if (ok !== true) {
      if (req.ids !== 'all') out.push({ id: p.id, label: p.label, ok: false, error: ok });
      continue;
    }
    const r = await p.run(ctx);
    out.push(
      r.ok
        ? { id: p.id, label: p.label, ok: true, ...(r.jobId ? { jobId: r.jobId } : {}) }
        : { id: p.id, label: p.label, ok: false, error: r.error },
    );
  }
  return out;
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
  setChangeProducerRunner(runChangeProducers);
  // a finished cloud change colours the clouds by change at once (the layer comes with the reload)
  jobs.subscribe((s, prev) => {
    const root = projectRoot();
    if (root && cloudChangeFinished(prev.jobs, s.jobs, root))
      pointcloudSettings.getState().setColourMode('change');
  });
}
