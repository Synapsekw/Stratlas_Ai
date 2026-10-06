/**
 * Imagery and surface change (M8 C2) as producers of the Changes panel (`@aio/change` registry):
 * **Run imagery change** starts `change.raster` on the pair's orthos, **Run surface change**
 * starts `change.surface` on their DSMs or point clouds. The thresholds come from Settings
 * (`Settings.change`, founder defaults otherwise). When the job finishes, the open project reloads
 * its manifest so the heat map and polygon layers appear.
 *
 * `registerImageryProducers()` is called once by the Changes panel (stream C1); it is idempotent.
 */
import {
  registerChangeProducer,
  type ChangePairContext,
  type ChangeProducer,
  type ChangeRunResult,
} from '@aio/change';
import {
  DEFAULT_CHANGE_THRESHOLDS,
  type ChangeRasterParams,
  type ChangeSurfaceParams,
  type ChangeThresholds,
  type JobRecord,
  type Layer,
  type PipelineName,
} from '@aio/schema';
import type { z } from 'zod';

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;
type RasterParams = z.input<typeof ChangeRasterParams>;
type SurfaceParams = z.input<typeof ChangeSurfaceParams>;
type SurfaceInput = SurfaceParams['from'];

/** The conservative, balanced and sensitive presets of `ChangeThresholds.raster`. */
export const RASTER_PRESETS: Record<
  ChangeThresholds['raster']['preset'],
  { threshold: number; minAreaM2: number }
> = {
  conservative: { threshold: 0.5, minAreaM2: 2 },
  balanced: { threshold: 0.4, minAreaM2: 1 },
  sensitive: { threshold: 0.3, minAreaM2: 0.5 },
};

const ORTHO_FORMATS: readonly string[] = ['kit-pyramid', 'image', 'cog'];
const CLOUD_FORMATS: readonly string[] = ['kit-packed', 'copc'];

/** Layers of one date only (a layer common to both dates is no comparison). */
function own(mine: readonly Layer[], other: readonly Layer[]): Layer[] {
  const theirs = new Set(other.map((l) => l.id));
  return mine.filter((l) => !theirs.has(l.id) && !l.derived);
}

const isOrtho = (l: Layer): l is RasterLayer =>
  l.kind === 'raster' && l.role === 'ortho' && ORTHO_FORMATS.includes(l.format);
const isDsm = (l: Layer): l is RasterLayer =>
  l.kind === 'raster' && l.role === 'dsm' && l.format === 'cog';
const isCloud = (l: Layer): l is CloudLayer =>
  l.kind === 'pointcloud' && CLOUD_FORMATS.includes(l.format) && !l.scalar;

/** The two orthos to compare: the first ortho of each date; a sentence when one is missing. */
export function orthoPair(ctx: ChangePairContext): { from: RasterLayer; to: RasterLayer } | string {
  const from = own(ctx.layersFrom, ctx.layersTo).find(isOrtho);
  const to = own(ctx.layersTo, ctx.layersFrom).find(isOrtho);
  if (!from || !to) return 'Imagery change needs an ortho on each date.';
  return { from, to };
}

function surfaceOf(layers: Layer[]): SurfaceInput | null {
  const dsm = layers.find(isDsm);
  if (dsm) return { layer: dsm.id, kind: 'dsm' };
  const cloud = layers.find(isCloud);
  return cloud ? { layer: cloud.id, kind: 'cloud' } : null;
}

/** The surfaces to compare: a DSM of each date, else a point cloud. */
export function surfacePair(
  ctx: ChangePairContext,
): { from: SurfaceInput; to: SurfaceInput } | string {
  const from = surfaceOf(own(ctx.layersFrom, ctx.layersTo));
  const to = surfaceOf(own(ctx.layersTo, ctx.layersFrom));
  if (!from || !to) return 'Surface change needs a DSM or a point cloud on each date.';
  return { from, to };
}

export function rasterParams(
  ctx: ChangePairContext,
  pair: { from: RasterLayer; to: RasterLayer },
  thresholds: ChangeThresholds = DEFAULT_CHANGE_THRESHOLDS,
): RasterParams {
  const preset = RASTER_PRESETS[thresholds.raster.preset];
  return {
    from: ctx.from,
    to: ctx.to,
    layerFrom: pair.from.id,
    layerTo: pair.to.id,
    method: 'gradient',
    threshold: preset.threshold,
    minAreaM2: preset.minAreaM2,
    maxShiftPx: thresholds.registration.maxShiftPx,
  };
}

export function surfaceParams(
  ctx: ChangePairContext,
  pair: { from: SurfaceInput; to: SurfaceInput },
  thresholds: ChangeThresholds = DEFAULT_CHANGE_THRESHOLDS,
): SurfaceParams {
  return {
    from: pair.from,
    to: pair.to,
    captures: { from: ctx.from, to: ctx.to },
    minDepthM: thresholds.surface.minDepthM,
    minAreaM2: thresholds.surface.minAreaM2,
  };
}

/** What the producers need from the app (injected in tests). */
export interface ProducerDeps {
  /** The open project's folder, or null. */
  root(): string | null;
  thresholds(): ChangeThresholds | undefined;
  /** Start a pipeline job: its id, or an error sentence. */
  start(
    pipeline: PipelineName,
    project: string,
    params: Record<string, unknown>,
  ): Promise<{ jobId: string } | { error: string }>;
  /** Called once with a started job's id: reload the manifest when it is done. */
  follow(jobId: string): void;
}

async function runJob(
  deps: ProducerDeps,
  pipeline: PipelineName,
  params: Record<string, unknown>,
): Promise<ChangeRunResult> {
  const root = deps.root();
  if (!root) return { ok: false, error: 'Open a project first.' };
  const r = await deps.start(pipeline, root, params);
  if ('error' in r) return { ok: false, error: r.error };
  deps.follow(r.jobId);
  return { ok: true, jobId: r.jobId };
}

export function imageryProducers(deps: ProducerDeps): ChangeProducer[] {
  return [
    {
      id: 'raster',
      label: 'Run imagery change',
      kinds: ['region'],
      available: (ctx) => {
        const pair = orthoPair(ctx);
        return typeof pair === 'string' ? pair : true;
      },
      run: (ctx) => {
        const pair = orthoPair(ctx);
        if (typeof pair === 'string') return Promise.resolve({ ok: false, error: pair });
        return runJob(deps, 'change.raster', { ...rasterParams(ctx, pair, deps.thresholds()) });
      },
    },
    {
      id: 'surface',
      label: 'Run surface change',
      kinds: ['region'],
      available: (ctx) => {
        const pair = surfacePair(ctx);
        return typeof pair === 'string' ? pair : true;
      },
      run: (ctx) => {
        const pair = surfacePair(ctx);
        if (typeof pair === 'string') return Promise.resolve({ ok: false, error: pair });
        return runJob(deps, 'change.surface', { ...surfaceParams(ctx, pair, deps.thresholds()) });
      },
    },
  ];
}

/** True once `jobId` is done in `next` and was not in `prev`. */
export function jobDone(prev: readonly JobRecord[], next: readonly JobRecord[], jobId: string) {
  const now = next.find((j) => j.id === jobId);
  return now?.status === 'done' && prev.find((j) => j.id === jobId)?.status !== 'done';
}

/** The app's own wiring: the jobs store, Settings and the open project (loaded on first use). */
function appDeps(): ProducerDeps {
  const app = () => import('../../shell');
  const ws = () => import('@aio/workspace');
  let root: string | null = null;
  let thresholds: ChangeThresholds | undefined;
  // read synchronously by the producers: kept fresh from the stores
  void Promise.all([app(), ws()]).then(([{ shell }, { workspace }]) => {
    const sync = () => {
      root = workspace.getState().project?.root ?? null;
      thresholds = shell.getState().settings.change;
    };
    sync();
    workspace.subscribe(sync);
    shell.subscribe(sync);
  });
  return {
    root: () => root,
    thresholds: () => thresholds,
    start: async (pipeline, project, params) => {
      const { jobs } = await app();
      const error = await jobs.getState().start({ pipeline, project, params });
      if (error) return { error };
      const id = jobs.getState().selected;
      return id ? { jobId: id } : { error: 'The job did not start.' };
    },
    follow: (jobId) => {
      void Promise.all([app(), ws()]).then(([{ jobs, bridge }, { workspace }]) => {
        const stop = jobs.subscribe((s, prev) => {
          const job = s.jobs.find((j) => j.id === jobId);
          if (job && (job.status === 'failed' || job.status === 'cancelled')) stop();
          if (!jobDone(prev.jobs, s.jobs, jobId)) return;
          stop();
          const project = workspace.getState().project;
          if (!project) return;
          void bridge.call('project:open', { path: project.root }).then((r) => {
            const now = workspace.getState();
            if (r.ok && r.value.ok && now.project?.id === project.id)
              now.replaceManifest(r.value.manifest);
          });
        });
      });
    },
  };
}

let registered: (() => void) | null = null;

/** Offer imagery and surface change in the Changes panel (idempotent); returns the undo. */
export function registerImageryProducers(deps: ProducerDeps = appDeps()): () => void {
  if (registered) return registered;
  const offs = imageryProducers(deps).map((p) => registerChangeProducer(p));
  registered = () => {
    for (const off of offs) off();
    registered = null;
  };
  return registered;
}
