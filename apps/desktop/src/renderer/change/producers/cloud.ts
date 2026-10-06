/**
 * Point cloud change (M8 stream C3) in the Changes panel: the `change.cloud` pipeline for a date
 * pair and the volume change of the same clouds (C2's `change.surface` with cloud inputs, shown
 * read only beside the cloud). Registered with the `@aio/change` producer registry at start
 * (`registerAppChangeProducers`); the panel never imports it. A finished run adds a derived layer,
 * which the manifest reload of `MANIFEST_WRITERS` (`jobs.ts`) brings in.
 */
import {
  registerChangeProducer,
  type ChangePairContext,
  type ChangeProducer,
  type ChangeRunResult,
} from '@aio/change';
import type { ChangeCloudParams, ChangeSurfaceParams } from '@aio/schema';
import {
  type ChangeSet,
  type ChangeThresholds,
  type JobRecord,
  type Layer,
  type PipelineName,
} from '@aio/schema';
import { meshChangeProducer } from './mesh';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

/** A job the producers ask the app to start (`jobs:start`). */
export interface ChangeJob {
  pipeline: PipelineName;
  project: string;
  params: Record<string, unknown>;
}

export interface ProducerDeps {
  /** The open project's folder; null for none (or a package, which never computes). */
  projectRoot: () => string | null;
  /** The person's change thresholds (Settings), else the founder defaults. */
  thresholds: () => ChangeThresholds;
  /** Start a pipeline job; the new job's id, or why it did not start. */
  start: (job: ChangeJob) => Promise<{ jobId?: string } | { error: string }>;
}

/** A layer name without its date, to pair the clouds of two dates (`Scan 10 Jan 2026`). */
export function undated(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\d+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/** The earlier and later of two layer lists that stand for the same thing (or one each). */
export function pairByName<T extends Layer>(
  a: readonly T[],
  b: readonly T[],
): { from: T; to: T } | null {
  const [onlyA] = a;
  const [onlyB] = b;
  if (a.length === 1 && b.length === 1 && onlyA && onlyB) return { from: onlyA, to: onlyB };
  for (const x of a) {
    const same = b.filter((y) => undated(y.name) === undated(x.name));
    const [y] = same;
    if (same.length === 1 && y) return { from: x, to: y };
  }
  return null;
}

const isCloud = (l: Layer): l is CloudLayer => l.kind === 'pointcloud' && !l.derived;

/** The COPC clouds of the two dates to compare, or what is missing. */
export function cloudPair(ctx: ChangePairContext): { from: CloudLayer; to: CloudLayer } | string {
  const a = ctx.layersFrom.filter(isCloud);
  const b = ctx.layersTo.filter(isCloud);
  if (!a.length || !b.length) return 'Each date needs a point cloud of its own.';
  const copcA = a.filter((l) => l.format === 'copc');
  const copcB = b.filter((l) => l.format === 'copc');
  if (!copcA.length || !copcB.length)
    return 'Cloud change reads COPC clouds: convert the point clouds of both dates first.';
  return (
    pairByName(copcA, copcB) ??
    'Several point clouds on a date: name them alike (with their dates) to compare them.'
  );
}

/** The `change.cloud` job for the pair, with the person's thresholds. */
export function cloudJob(
  ctx: ChangePairContext,
  project: string,
  t: ChangeThresholds,
): ChangeJob | string {
  const pair = cloudPair(ctx);
  if (typeof pair === 'string') return pair;
  const params: ChangeCloudParams = {
    layerFrom: pair.from.id,
    layerTo: pair.to.id,
    captures: { from: ctx.from, to: ctx.to },
    minDistM: t.cloud.significantM,
    maxDistM: t.cloud.farM,
  };
  return { pipeline: 'change.cloud', project, params };
}

/** The volume change of the same clouds: C2's `change.surface` with cloud inputs. */
export function volumeJob(ctx: ChangePairContext, project: string): ChangeJob | string {
  const pair = cloudPair(ctx);
  if (typeof pair === 'string') return pair;
  const params: ChangeSurfaceParams = {
    from: { layer: pair.from.id, kind: 'cloud' },
    to: { layer: pair.to.id, kind: 'cloud' },
    captures: { from: ctx.from, to: ctx.to },
  };
  return { pipeline: 'change.surface', project, params };
}

/** Run a job a producer built, as a registry result. */
export async function runJob(
  deps: ProducerDeps,
  build: (project: string) => ChangeJob | string,
): Promise<ChangeRunResult> {
  const project = deps.projectRoot();
  if (!project) return { ok: false, error: 'Open the project folder to compare its dates.' };
  const job = build(project);
  if (typeof job === 'string') return { ok: false, error: job };
  const r = await deps.start(job);
  if ('error' in r) return { ok: false, error: r.error };
  return r.jobId ? { ok: true, jobId: r.jobId } : { ok: true };
}

export function cloudChangeProducer(deps: ProducerDeps): ChangeProducer {
  return {
    id: 'cloud',
    label: 'Run cloud change',
    kinds: ['region'],
    available: (ctx) => {
      const pair = cloudPair(ctx);
      return typeof pair === 'string' ? pair : true;
    },
    run: (ctx) => runJob(deps, (project) => cloudJob(ctx, project, deps.thresholds())),
  };
}

let registered: (() => void) | null = null;

/**
 * Register the cloud and model change producers (once; a second call returns the same stop
 * function).
 */
export function registerCloudChangeProducers(deps: ProducerDeps): () => void {
  if (registered) return registered;
  const stops = [
    registerChangeProducer(cloudChangeProducer(deps)),
    registerChangeProducer(meshChangeProducer(deps)),
  ];
  const stop = () => {
    for (const s of stops) s();
    if (registered === stop) registered = null;
  };
  registered = stop;
  return stop;
}

// ---------------------------------------------------------------- after a run

/** Change clouds of the project: derived change layers with a scalar to colour by. */
export function changeCloudLayers(layers: readonly Layer[]): CloudLayer[] {
  return layers.filter(
    (l): l is CloudLayer =>
      l.kind === 'pointcloud' && l.derived?.kind === 'change' && l.scalar !== undefined,
  );
}

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** True when a `change.cloud` run of the project at `root` has just finished. */
export function cloudChangeFinished(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean {
  return next.some(
    (j) =>
      j.pipeline === 'change.cloud' &&
      j.status === 'done' &&
      folderKey(j.project) === folderKey(root) &&
      prev.find((p) => p.id === j.id)?.status !== 'done',
  );
}

// ---------------------------------------------------------------- volume change (C2, read only)

/** The id `change.surface` gives its change set (`change_set_id` in changeset.py). */
export function surfaceSetId(from: string, to: string): string {
  return `${from}-${to}-surface`.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export interface VolumeChange {
  id: string;
  fillM3: number;
  cutM3: number;
  netM3: number;
  regions: number;
  createdAt: string;
}

/** The site totals of a surface change set: its stats, else the sum of its regions. */
export function surfaceVolumes(set: ChangeSet): VolumeChange | null {
  if (set.producer !== 'change.surface') return null;
  let fill = 0;
  let cut = 0;
  let regions = 0;
  for (const item of set.items) {
    if (item.kind !== 'region' || !item.volume) continue;
    fill += item.volume.fillM3;
    cut += item.volume.cutM3;
    regions++;
  }
  const stat = (k: string) => {
    const v = set.stats[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const fillM3 = stat('fillM3') ?? fill;
  const cutM3 = stat('cutM3') ?? cut;
  return {
    id: set.id,
    fillM3,
    cutM3,
    netM3: stat('netM3') ?? fillM3 - cutM3,
    regions,
    createdAt: set.createdAt,
  };
}
