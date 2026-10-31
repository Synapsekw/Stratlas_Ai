/**
 * Find hot spots (thermal bench): one `thermal.hotspots` job over the open dataset, then how many
 * possible hot spots it wrote. The drafts land in the pass `detections/thermal-<layerId>.json`,
 * which Inspect lists like any other once the review is read again. No window and no singleton
 * at import, so it runs in a unit test with fake deps; `useHotspotFinder` is the app's instance.
 */
import type { JobRecord, ThermalHotspotsParams } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** The rule the bench runs: 4 °C or more above the surroundings. */
export const HOTSPOT_PARAMS = { rule: 'delta', thresholdC: 4 } as const satisfies Omit<
  ThermalHotspotsParams,
  'layerId'
>;

export interface HotspotFinderDeps {
  start: (params: ThermalHotspotsParams) => Promise<{ jobId: string } | { error: string }>;
  /** The job once it ended, or null when it went away. */
  wait: (jobId: string) => Promise<JobRecord | null>;
  /** The candidates the job wrote (its commit step's outputs), or null when they cannot be read. */
  readCandidates: (projectId: string, job: JobRecord) => Promise<number | null>;
  /** Read the review again, so Inspect lists the new drafts. */
  reload: (projectId: string) => Promise<void>;
}

export interface HotspotFind {
  layerId: string;
  phase: 'running' | 'done' | 'error';
  /** Possible hot spots written (done); null when the job's count could not be read. */
  count: number | null;
  error: string | null;
}

export interface HotspotFinderUi {
  /** The last run of this opening; the bench shows it for its layer only. */
  find: HotspotFind | null;
  run: (projectId: string, layerId: string) => Promise<void>;
}

export function createHotspotFinder(deps: HotspotFinderDeps): StoreApi<HotspotFinderUi> {
  return createStore<HotspotFinderUi>()((set, get) => ({
    find: null,
    run: async (projectId, layerId) => {
      if (get().find?.phase === 'running') return;
      const fail = (error: string) => {
        set({ find: { layerId, phase: 'error', count: null, error } });
      };
      set({ find: { layerId, phase: 'running', count: null, error: null } });
      try {
        const started = await deps.start({ layerId, ...HOTSPOT_PARAMS });
        if ('error' in started) {
          fail(started.error);
          return;
        }
        const done = await deps.wait(started.jobId);
        if (!done) {
          fail('The hot spot job disappeared before it finished.');
          return;
        }
        if (done.status !== 'done') {
          fail(done.error ?? `The hot spot job ${done.status}.`);
          return;
        }
        const count = await deps.readCandidates(projectId, done).catch(() => null);
        await deps.reload(projectId).catch(() => undefined);
        set({ find: { layerId, phase: 'done', count, error: null } });
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  }));
}

/**
 * The manifest the pipeline runtime writes for the job's commit step (`jobs/<id>/steps/NN-<step>.json`,
 * NN its place from 1): the step named `commit`, else the last. Null without steps.
 */
export function stepManifestPath(job: JobRecord): string | null {
  const at = job.steps.findIndex((s) => s.name === 'commit');
  const index = at >= 0 ? at : job.steps.length - 1;
  const step = job.steps[index];
  if (!step) return null;
  return `jobs/${job.id}/steps/${String(index + 1).padStart(2, '0')}-${step.name}.json`;
}

/** `outputs.candidates` of a step manifest, when it is a count. */
export function candidatesOf(manifest: unknown): number | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const outputs = (manifest as { outputs?: unknown }).outputs;
  if (typeof outputs !== 'object' || outputs === null) return null;
  const n = (outputs as { candidates?: unknown }).candidates;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** The real deps: the app's jobs, project files and review, imported on first use. */
const appDeps: HotspotFinderDeps = {
  start: async (params) => {
    const [{ jobs }, { workspace }] = await Promise.all([
      import('../shell'),
      import('@aio/workspace'),
    ]);
    const root = workspace.getState().project?.root;
    if (!root) return { error: 'No project is open.' };
    return jobs.getState().startQuiet({ pipeline: 'thermal.hotspots', project: root, params });
  },
  wait: async (jobId) => {
    const [{ jobs }, { waitForJob }] = await Promise.all([import('../shell'), import('../jobs')]);
    return waitForJob(jobs, jobId);
  },
  readCandidates: async (projectId, job) => {
    const path = stepManifestPath(job);
    if (!path) return null;
    const { assetUrl } = await import('@aio/workspace');
    const res = await fetch(assetUrl(projectId, { path }));
    if (!res.ok) return null;
    return candidatesOf(await res.json());
  },
  reload: async (projectId) => {
    const { detections, loadDetections } = await import('../detections/store');
    // a review that is not open reads the new pass when Inspect opens it
    if (detections.getState().projectId === projectId) await loadDetections(projectId, true);
  },
};

export const hotspotFinder = createHotspotFinder(appDeps);

/** The app's hot spot finder, as a hook. */
export function useHotspotFinder<T>(selector: (s: HotspotFinderUi) => T): T {
  return useStore(hotspotFinder, selector);
}
