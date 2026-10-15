/**
 * Remove noise and Save cleaned copy: `pointcloud.clean` jobs from the Clean up panel. A finished
 * noise run's record (beside its working copy) becomes one step of the layer's recipe, with class 7
 * hidden; a run that marked nothing changes nothing. A saved copy arrives as a new layer through the
 * manifest reload of MANIFEST_WRITERS (jobs.ts). Both need POINTCLOUD_CLEAN_MIN_PACK: main refuses
 * `jobs:start` on an older pack with the pack update wording, which comes back here as the error.
 */
import {
  NOISE_CLASS,
  emptyCleanup,
  type JobRecord,
  type Layer,
  type NoiseParams,
  type NoiseRun,
  type PointcloudCleanup,
} from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import type { Bridge } from '../bridge';
import { bridge, jobs } from '../shell';
import { cleanup as appCleanup, type Cleanup } from './cleanupStore';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

export function applyNoiseRun(
  r: PointcloudCleanup | null,
  layerId: string,
  run: NoiseRun,
): PointcloudCleanup {
  const base = r ?? emptyCleanup(layerId);
  const hidden = [...new Set([...base.hiddenClasses, NOISE_CLASS])].sort((a, b) => a - b);
  return { ...base, noise: run, hiddenClasses: hidden };
}

export function noiseShare(marked: number, total: number): string {
  if (!total || !marked) return '0 %';
  const pct = (100 * marked) / total;
  return `${pct.toFixed(pct < 0.1 ? 2 : 1)} %`;
}

export interface JobsDeps {
  call: Bridge['call'];
  cleanup: Cleanup;
  project(): { id: string; root: string } | null;
  waitForJob(id: string): Promise<JobRecord>;
}

const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export const defaultJobsDeps: JobsDeps = {
  call: (c, r) => bridge.call(c, r),
  cleanup: appCleanup,
  project: () => {
    const p = workspace.getState().project;
    return p ? { id: p.id, root: p.root } : null;
  },
  waitForJob: (id) =>
    new Promise((resolve) => {
      const finished = (s: { jobs: JobRecord[] }) =>
        s.jobs.find((x) => x.id === id && FINISHED.has(x.status));
      const now = finished(jobs.getState());
      if (now) {
        resolve(now);
        return;
      }
      const stop = jobs.subscribe((s) => {
        const j = finished(s);
        if (!j) return;
        stop();
        resolve(j);
      });
    }),
};

const srcOf = (layer: CloudLayer): string | null => ('path' in layer.src ? layer.src.path : null);

/** Why the cleanup cannot be changed here (a package, a look-only reviewer), or null. */
function refusal(d: JobsDeps): string | null {
  if (d.cleanup.canEdit()) return null;
  return d.cleanup.store.getState().readOnly ? t('cleanup.readOnly') : t('cleanup.lookOnly');
}

async function start(
  d: JobsDeps,
  params: Record<string, unknown>,
  onStarted?: () => void,
): Promise<{ job: JobRecord } | { error: string }> {
  const p = d.project();
  if (!p) return { error: 'No project is open.' };
  const r = await d.call('jobs:start', { pipeline: 'pointcloud.clean', project: p.root, params });
  if (!r.ok) return { error: r.error };
  if (!r.value.ok) return { error: r.value.error };
  onStarted?.();
  return { job: await d.waitForJob(r.value.job.id) };
}

export async function runNoise(
  d: JobsDeps,
  layer: CloudLayer,
  params: NoiseParams,
): Promise<string | null> {
  const src = srcOf(layer);
  const p = d.project();
  if (!p) return 'No project is open.';
  if (!src) return 'This cloud has no file in the project.';
  const refused = refusal(d);
  if (refused) return refused;
  // a project switched while the job ran: its result belongs to the other project, never here
  const here = () => d.cleanup.store.getState().projectId === p.id;
  d.cleanup.setBusy('noise');
  try {
    const started = await start(d, {
      mode: 'noise',
      layerId: layer.id,
      src,
      outlier: params.outlier,
      ...(params.elm ? { elm: params.elm } : {}),
    });
    if ('error' in started) return started.error;
    const { job } = started;
    if (!here()) return null;
    if (job.status !== 'done') return job.error ?? 'The noise run did not finish.';
    // the record the job wrote beside its working copy (marked, total)
    const r = await d.call('pointcloud:readCleanup', {
      projectId: p.id,
      noiseRun: { layerId: layer.id, runId: job.id },
    });
    if (!here()) return null;
    if (!r.ok) return r.error;
    if (!r.value.ok) return r.value.error;
    const run = r.value.noise ?? null;
    if (!run) return 'The noise run left no result.';
    if (run.marked === 0) {
      d.cleanup.notify({
        text: t('cleanup.noise.none'),
        undo: false,
        error: false,
        layerId: layer.id,
      });
      return null;
    }
    const next = applyNoiseRun(d.cleanup.recipeOf(layer.id), layer.id, run);
    await d.cleanup.commit(layer.id, next, { kind: 'noise', count: run.marked });
    return null;
  } finally {
    if (here()) d.cleanup.setBusy(null);
  }
}

export async function saveCleaned(
  d: JobsDeps,
  layer: CloudLayer,
  name: string,
): Promise<string | null> {
  const src = srcOf(layer);
  if (!src) return 'This cloud has no file in the project.';
  const refused = refusal(d);
  if (refused) return refused;
  const recipe = d.cleanup.recipeOf(layer.id) ?? emptyCleanup(layer.id);
  const projectId = d.cleanup.store.getState().projectId;
  const here = () => d.cleanup.store.getState().projectId === projectId;
  d.cleanup.setBusy('save');
  try {
    const started = await start(
      d,
      {
        mode: 'save',
        layerId: layer.id,
        src,
        recipe,
        name: name.trim() || layer.name,
      },
      () => {
        // only once the job is accepted: an old pack's refusal is the only message
        if (!here()) return;
        d.cleanup.notify({
          text: t('cleanup.save.started'),
          undo: false,
          error: false,
          layerId: layer.id,
        });
      },
    );
    if ('error' in started) return started.error;
    return started.job.status === 'done' ? null : (started.job.error ?? 'The save did not finish.');
  } finally {
    if (here()) d.cleanup.setBusy(null);
  }
}
