import type { ImportItem, JobRecord, ProjectManifest, Space } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { builder } from '../builder/state';
import { isActive, sameFolder } from '../jobs';
import { setActiveSpace } from '../spaces/activeSpace';
import { switcherShown } from '../spaces/spaceModel';

/*
 * Each Inspector import fills a space of its own, and the app shows one space at a time. Without
 * this the space on screen stayed the first one, so a second import looked as if it did nothing.
 * When an import of the open project finishes, the space it filled becomes the one on screen and a
 * notice names it. Chambers queued one after the other switch once, when none is left.
 *
 * The follow runs only because an Inspector import ended or its line changed: after the manifest
 * reload of a finished import (`App.tsx`), when an import job stops another way, and when main
 * says a waiting chamber left the line or its empty space was tidied (`queueWatch.ts`). A reload
 * for another pipeline's job never calls it.
 */

const PIPELINE = 'flyability.import';

type ImportJob = Pick<JobRecord, 'id' | 'pipeline' | 'project' | 'status' | 'params'>;

/** The inspections a job imports, in the order of its parameters. */
function inspectionsOf(job: Pick<JobRecord, 'params'>): string[] {
  const list = job.params.inspections;
  if (!Array.isArray(list)) return [];
  return list.flatMap((i) => {
    const id = (i as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * The space an import job filled: the one its last inspection was sent to (`params.spaces`), else
 * the one that came from that inspection (a job of several inspections shows the last, as a line
 * of chambers does). Null when the manifest has no such space.
 */
export function importedSpace(m: ProjectManifest, job: Pick<JobRecord, 'params'>): Space | null {
  const inspection = inspectionsOf(job).at(-1);
  if (inspection === undefined) return null;
  const spaces = m.spaces ?? [];
  const sent = (job.params.spaces as Record<string, unknown> | undefined)?.[inspection];
  return (
    spaces.find((s) => s.id === sent) ??
    spaces.find((s) => s.source?.inspectionId === inspection) ??
    null
  );
}

/**
 * Whether an Inspector import of the project at `root` is still to come. The waiting chambers have
 * no job yet, so the job list alone cannot tell; three signs are read:
 * - an import job of the project is at work;
 * - a row of the import card still waits: no job yet, or its job is at work (`rows`);
 * - a chamber space made ahead of its job is still empty and no job of its inspection has ended.
 */
export function importsLeft(
  m: ProjectManifest,
  jobs: readonly ImportJob[],
  root: string,
  rows: readonly ImportItem[] = [],
): boolean {
  const mine = jobs.filter((j) => j.pipeline === PIPELINE && sameFolder(j.project, root));
  if (mine.some(isActive)) return true;
  const waits = (i: ImportItem) =>
    i.kind === 'flyability' &&
    i.status === 'queued' &&
    (i.jobId === undefined || jobs.some((j) => j.id === i.jobId && isActive(j)));
  if (rows.some(waits)) return true;
  const ended = new Set(mine.flatMap(inspectionsOf));
  const used = new Set(m.layers.map((l) => l.space));
  return (m.spaces ?? []).some(
    (s) => s.source?.pending === true && !used.has(s.id) && !ended.has(s.source.inspectionId),
  );
}

/** True when an Inspector import of the project at `root` has just finished (it was at work). */
export function importFinished(
  prev: readonly ImportJob[],
  next: readonly ImportJob[],
  root: string,
): boolean {
  return next.some(
    (j) =>
      j.pipeline === PIPELINE &&
      j.status === 'done' &&
      sameFolder(j.project, root) &&
      prev.some((p) => p.id === j.id && isActive(p)),
  );
}

/** The last import that finished and is not on screen yet, and the project it is in. */
let finished: { projectId: string; job: ImportJob } | null = null;
/** The job list as last seen (`connectFollowImport`). */
let seen: readonly ImportJob[] = [];

/** Test seam: forget the import to show and the jobs seen. */
export function resetFollow(): void {
  finished = null;
  seen = [];
}

/**
 * A change of the job list: remember the Inspector import of the open project that has just
 * finished (a job already done when the list was first read is history, not news). Says when one
 * has just ended another way: no manifest is read again for it, so the follow runs at once.
 * `cancelled` also takes the project's waiting chambers out of the line (main, `inspectorLane`).
 */
function noteImports(
  prev: readonly ImportJob[],
  next: readonly ImportJob[],
  project: { id: string; root: string },
): 'stopped' | 'cancelled' | null {
  let stopped: 'stopped' | 'cancelled' | null = null;
  for (const j of next) {
    if (j.pipeline !== PIPELINE || isActive(j) || !sameFolder(j.project, project.root)) continue;
    const before = prev.find((p) => p.id === j.id);
    if (before === undefined || !isActive(before)) continue;
    if (j.status === 'done') finished = { projectId: project.id, job: j };
    else if (stopped !== 'cancelled') stopped = j.status === 'cancelled' ? 'cancelled' : 'stopped';
  }
  return stopped;
}

/**
 * Watch the job list for Inspector imports of the open project, and forget the import to show
 * when another project opens or this one closes, so nothing fires late after a reopen.
 */
export function connectFollowImport(jobs: StoreApi<{ jobs: ImportJob[] }>): () => void {
  seen = jobs.getState().jobs;
  const offJobs = jobs.subscribe((s, prev) => {
    seen = s.jobs;
    const project = workspace.getState().project;
    if (!project || s.jobs === prev.jobs) return;
    const ended = noteImports(prev.jobs, s.jobs, project);
    if (ended) followImport(ended === 'cancelled');
  });
  const offProject = workspace.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) finished = null;
  });
  return () => {
    offJobs();
    offProject();
  };
}

/**
 * Show the space of the last finished import of the open project, once no import of it is left
 * and its manifest has been read again. The notice is left out while the project has one space:
 * there is nothing to switch. `lineDropped`: an import was cancelled, so the chambers that waited
 * behind it will not run, though their empty spaces are in the manifest until main tidies them.
 */
export function followImport(lineDropped = false): void {
  const project = workspace.getState().project;
  if (!project || finished?.projectId !== project.id) return;
  const rows = builder.getState().importResult?.items ?? [];
  if (!lineDropped && importsLeft(project.manifest, seen, project.root, rows)) return;
  // not in the manifest yet: it is being read again, and that reload follows
  const space = importedSpace(project.manifest, finished.job);
  if (!space) return;
  finished = null;
  setActiveSpace(project.id, space.id);
  if (!switcherShown(project.manifest)) return;
  toast(t('fly.space.followed', { name: space.name }), {
    tone: 'ok',
    // an import takes minutes and ends while the person looks elsewhere: stay a little longer
    ttlMs: 8000,
    id: 'fly-import-space',
    testId: 'fly-import-space',
  });
}
