import type { JobRecord, ProjectManifest, Space } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { folderKey, isActive, sameFolder } from '../jobs';
import { setActiveSpace } from '../spaces/activeSpace';
import { switcherShown } from '../spaces/spaceModel';

/*
 * Each Inspector import fills a space of its own, and the app shows one space at a time. Without
 * this the space on screen stayed the first one, so a second import looked as if it did nothing.
 * When an import of the open project finishes, the space it filled becomes the one on screen and a
 * notice names it. Chambers queued one after the other switch once, when none is left.
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
 * The space an import job filled: the one its first inspection was sent to (`params.spaces`), else
 * the one that came from that inspection. Null when the manifest has no such space.
 */
export function importedSpace(m: ProjectManifest, job: Pick<JobRecord, 'params'>): Space | null {
  const inspection = inspectionsOf(job)[0];
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
 * Whether an Inspector import of the project at `root` is still to come: one runs, or a chamber
 * space made ahead of its job is still empty and no job of its inspection has ended (the waiting
 * chambers have no job yet, so the job list alone cannot tell).
 */
export function importsLeft(m: ProjectManifest, jobs: readonly ImportJob[], root: string): boolean {
  const mine = jobs.filter((j) => j.pipeline === PIPELINE && sameFolder(j.project, root));
  if (mine.some(isActive)) return true;
  const ended = new Set(mine.flatMap(inspectionsOf));
  const used = new Set(m.layers.map((l) => l.space));
  return (m.spaces ?? []).some(
    (s) => s.source?.pending === true && !used.has(s.id) && !ended.has(s.source.inspectionId),
  );
}

/** The last import that finished and is not on screen yet, and the project folder it is in. */
let finished: { project: string; job: ImportJob } | null = null;

/** Test seam: forget the import to show. */
export function resetFollow(): void {
  finished = null;
}

/**
 * A change of the job list: remember the Inspector import of the project at `root` that has just
 * finished (a job already done when the list was first read is history, not news). Says when one
 * has just ended another way: no manifest is read again for it, so the caller follows at once.
 * `cancelled` also takes the project's waiting chambers out of the line (main, `inspectorLane`).
 */
export function noteImports(
  prev: readonly ImportJob[],
  next: readonly ImportJob[],
  root: string,
): 'stopped' | 'cancelled' | null {
  let stopped: 'stopped' | 'cancelled' | null = null;
  for (const j of next) {
    if (j.pipeline !== PIPELINE || isActive(j) || !sameFolder(j.project, root)) continue;
    const before = prev.find((p) => p.id === j.id);
    if (before === undefined || !isActive(before)) continue;
    if (j.status === 'done') finished = { project: folderKey(root), job: j };
    else if (stopped !== 'cancelled') stopped = j.status === 'cancelled' ? 'cancelled' : 'stopped';
  }
  return stopped;
}

/**
 * Show the space of the last finished import of the open project, once no import of it is left
 * and its manifest has been read again. The notice is left out while the project has one space:
 * there is nothing to switch. `lineDropped`: an import was cancelled, so the chambers that waited
 * behind it will not run, though their empty spaces are in the manifest until main tidies them.
 */
export function followImport(jobs: readonly ImportJob[], lineDropped = false): void {
  const project = workspace.getState().project;
  if (!finished || !project || finished.project !== folderKey(project.root)) return;
  if (!lineDropped && importsLeft(project.manifest, jobs, project.root)) return;
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
