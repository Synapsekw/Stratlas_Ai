/**
 * Removing datasets, runs and survey dates (delete and start over, 13 Oct 2026): the four
 * `builder:` removal channels and `walks:remove`. The plan and the removal are
 * `@aio/project/builder`'s; main adds the package refusal, hands in this project's jobs (the
 * live-job refusal and the job folders of a removed run), and forgets the job records of removed
 * runs once the manifest is saved (they cannot come back from the trash; the job folders can).
 * A running drone panorama stitch (`pano.stitch`) of a removed layer is stopped first instead of
 * refusing the removal.
 * A project runs one removal or Empty project trash at a time: two in the same second could pick
 * the same trash entry name. The journal records the files the plan names (`journaledRemovals`,
 * used by `journal.ts`).
 */
import type * as Builder from '@aio/project/builder';
import type { PlanJob } from '@aio/project/builder';
import { isJournaledFile } from '@aio/journal';
import {
  CHANGE_DIR,
  PHOTO_RUN_FILES,
  TILESETS_FILE,
  emptyRemovalPlan,
  photoRunDir,
  type IpcRequest,
  type IpcResponse,
  type JobRecord,
  type RemovalPlan,
} from '@aio/schema';
import { resolve } from 'node:path';
import { samePath } from './libraryActions';

export type RemovalLib = Pick<
  typeof Builder,
  'planRemoval' | 'removeItems' | 'trashSize' | 'emptyTrash' | 'removeWalk'
>;

export interface RemovalDeps {
  root: (projectId: string) => string | undefined;
  isPackage: (projectId: string) => boolean;
  jobs: () => readonly JobRecord[];
  deleteJob: (id: string) => boolean;
  flushJobs: () => Promise<void>;
  log: (line: string) => void;
  /** Stop a running job (`jobs:cancel`); false when it is not running. */
  cancelJob?: (id: string) => boolean;
  /** How long a removal waits for the stitches it stopped (ms). */
  stopWaitMs?: number;
  lib?: () => Promise<RemovalLib>;
}

export const PACKAGE_REFUSAL =
  'This project is a read-only package. Nothing can be added or changed.';
/** The builder library loads on first use (a static import empties the main bundle, as in builder.ts). */
const load = (d: RemovalDeps): Promise<RemovalLib> =>
  (d.lib ?? (() => import('@aio/project/builder')))();
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notOpen = (id: string) => `Project "${id}" is not open. Open it, then try again.`;

/** The last queued removal of each project folder; it never rejects. */
const queues = new Map<string, Promise<void>>();
const queueKey = (root: string) =>
  process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);

/** Run `work` after every removal or Empty project trash already queued for this project. */
function oneAtATime<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = queueKey(root);
  const run = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export function planJobsFor(root: string, all: readonly JobRecord[]): PlanJob[] {
  return all
    .filter((j) => samePath(j.project, root))
    .map((j) => ({ id: j.id, pipeline: j.pipeline, status: j.status, params: j.params }));
}

/** A job that still runs (the plan's `LIVE`). */
const LIVE: ReadonlySet<string> = new Set(['starting', 'running', 'cancelling']);
const liveStitch = (j: PlanJob) => j.pipeline === 'pano.stitch' && LIVE.has(j.status);

/**
 * The jobs a plan weighs: a running drone panorama stitch does not refuse the removal of its
 * layer, the removal stops it first (`stopStitches`).
 */
function planJobs(root: string, d: RemovalDeps): PlanJob[] {
  return planJobsFor(root, d.jobs()).filter((j) => !liveStitch(j));
}

const STOP_WAIT_MS = 10_000;

/**
 * Stop the `pano.stitch` jobs of the panoramas layers a removal takes, and wait until they have
 * stopped (the runner kills a runtime that does not stop within its grace). Null when nothing
 * runs any more, else why the removal cannot go on.
 */
async function stopStitches(
  root: string,
  targets: IpcRequest<'builder:remove'>['targets'],
  lib: RemovalLib,
  d: RemovalDeps,
): Promise<string | null> {
  const live = planJobsFor(root, d.jobs()).filter(liveStitch);
  if (live.length === 0) return null;
  const plan = await lib.planRemoval(root, targets, { jobs: planJobs(root, d) });
  // a refused plan: the removal refuses with the same reason
  if (plan.refused !== undefined) return null;
  const layers = new Map(plan.layers.map((l) => [l.id, l.name]));
  const hit = live.filter((j) => typeof j.params.layer === 'string' && layers.has(j.params.layer));
  if (hit.length === 0) return null;
  for (const j of hit) {
    try {
      d.cancelJob?.(j.id);
    } catch (e) {
      d.log(`Removal: the stitch ${j.id} could not be stopped (${text(e)}).`);
    }
  }
  const deadline = Date.now() + (d.stopWaitMs ?? STOP_WAIT_MS);
  for (;;) {
    const now = new Map(d.jobs().map((j) => [j.id, j.status]));
    const still = hit.find((j) => LIVE.has(now.get(j.id) ?? ''));
    if (still === undefined) return null;
    if (Date.now() >= deadline) {
      const name = layers.get(String(still.params.layer)) ?? String(still.params.layer);
      return `Stitching drone panoramas in "${name}" did not stop. Try the removal again in a moment.`;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function removalPlanAnswer(
  req: IpcRequest<'builder:removePlan'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:removePlan'>> {
  if (d.isPackage(req.projectId))
    return { ok: true, plan: { ...emptyRemovalPlan(), refused: PACKAGE_REFUSAL } };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  try {
    const lib = await load(d);
    return {
      ok: true,
      plan: await lib.planRemoval(root, req.targets, { jobs: planJobs(root, d) }),
    };
  } catch (e) {
    return { ok: false, error: text(e) };
  }
}

export async function removeAnswer(
  req: IpcRequest<'builder:remove'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:remove'>> {
  if (d.isPackage(req.projectId)) return { ok: false, error: PACKAGE_REFUSAL };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  return oneAtATime(root, async () => {
    let done: Awaited<ReturnType<RemovalLib['removeItems']>>;
    try {
      const lib = await load(d);
      const stuck = await stopStitches(root, req.targets, lib, d);
      if (stuck !== null) return { ok: false as const, error: stuck };
      done = await lib.removeItems(root, req.targets, undefined, {
        jobs: planJobsFor(root, d.jobs()),
      });
    } catch (e) {
      return { ok: false as const, error: text(e) };
    }
    // after the save only: a record cannot come back from the trash
    const kept = (id: string, why: string) => {
      d.log(
        `Removal: the job record ${id} was not deleted (${why}); it shows as a job whose run no longer exists.`,
      );
    };
    for (const id of done.plan.jobs) {
      try {
        if (!d.deleteJob(id)) kept(id, 'the job index does not hold it or it is still running');
      } catch (e) {
        kept(id, text(e));
      }
    }
    await d.flushJobs().catch((e: unknown) => {
      d.log(`Removal: the job index was not written (${text(e)}).`);
    });
    return { ok: true as const, manifest: done.manifest, plan: done.plan };
  });
}

/** `walks:remove`: a walk alone, through the same queue and the same live-job refusal. */
export async function removeWalkAnswer(
  req: IpcRequest<'walks:remove'>,
  d: RemovalDeps,
): Promise<IpcResponse<'walks:remove'>> {
  if (d.isPackage(req.projectId)) return { ok: false, error: PACKAGE_REFUSAL };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  return oneAtATime(root, async () => {
    try {
      const lib = await load(d);
      const manifest = await lib.removeWalk(root, req.layerId, undefined, {
        jobs: planJobsFor(root, d.jobs()),
      });
      return { ok: true as const, manifest };
    } catch (e) {
      return { ok: false as const, error: text(e) };
    }
  });
}

export async function trashAnswer(
  req: IpcRequest<'builder:trash'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:trash'>> {
  const root = d.isPackage(req.projectId) ? undefined : d.root(req.projectId);
  if (root === undefined) return { bytes: 0, entries: 0 };
  try {
    return await (await load(d)).trashSize(root);
  } catch (e) {
    d.log(`Removal: the project trash could not be read (${text(e)}).`);
    return { bytes: 0, entries: 0 };
  }
}

export async function emptyTrashAnswer(
  req: IpcRequest<'builder:emptyTrash'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:emptyTrash'>> {
  if (d.isPackage(req.projectId)) return { ok: false, error: PACKAGE_REFUSAL };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  return oneAtATime(root, async () => {
    try {
      const r = await (await load(d)).emptyTrash(root);
      return { ok: true as const, freed: r.freed, held: r.held.length };
    } catch (e) {
      return { ok: false as const, error: text(e) };
    }
  });
}

/**
 * The journaled files a removal changed: the manifest, tilesets.json, change sets, detections,
 * each removed run's `run.json` and `gcp.json`, and any other journaled file the plan moves (a
 * `models/<id>.procmodel.json` only when a hand-edited layer names it), so the next whole-project
 * reconcile does not take their disappearance for a change made outside the app.
 */
export function journaledRemovals(plan: RemovalPlan): string[] {
  const out = [
    'manifest.json',
    ...(plan.tilesets.length > 0 ? [TILESETS_FILE] : []),
    ...plan.changes.map((c) => `${CHANGE_DIR}/${c.id}.json`),
    ...plan.detections,
    ...plan.runs.flatMap((r) => [
      `${photoRunDir(r.id)}/${PHOTO_RUN_FILES.run}`,
      `${photoRunDir(r.id)}/${PHOTO_RUN_FILES.gcp}`,
    ]),
    ...plan.files.filter(isJournaledFile),
  ];
  return [...new Set(out)];
}
