/**
 * Removing datasets, runs and survey dates (delete and start over, 13 Oct 2026): the four
 * `builder:` removal channels and `walks:remove`. The plan and the removal are
 * `@aio/project/builder`'s; main adds the package refusal, hands in this project's jobs (the
 * live-job refusal and the job folders of a removed run), and forgets the job records of removed
 * runs once the manifest is saved (they cannot come back from the trash; the job folders can).
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
      plan: await lib.planRemoval(root, req.targets, { jobs: planJobsFor(root, d.jobs()) }),
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
