import type { AioBridge, ImportItem, IpcEvent, JobRecord } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { builder } from '../builder/state';

type LaneNotice = IpcEvent<'builder:inspectorQueue'>;
type ChamberNotice = Exclude<LaneNotice, { state: 'tidied' }>;

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The import card's rows once a waiting chamber started, left the line or could not start: the
 * row still queued without a job that imports the same inspections is changed (two chambers in
 * folders of one name stay apart); null when no row is that chamber's.
 */
export function applyLaneNotice(
  items: readonly ImportItem[],
  n: ChamberNotice,
): ImportItem[] | null {
  const ids = new Set(n.inspections);
  const at = items.findIndex(
    (i) =>
      i.kind === 'flyability' &&
      i.status === 'queued' &&
      i.jobId === undefined &&
      (i.inspections ?? []).some((x) => ids.has(x)),
  );
  if (at < 0) return null;
  const row = items[at];
  if (!row) return null;
  const next: ImportItem =
    n.state === 'started'
      ? { ...row, jobId: n.jobId, message: t('fly.queue.started') }
      : n.state === 'dropped'
        ? {
            ...row,
            status: 'skipped',
            message: t(n.reason === 'cancelled' ? 'fly.queue.cancelled' : 'fly.queue.closed'),
          }
        : { ...row, status: 'error', message: t('fly.queue.failed', { error: n.error }) };
  return items.map((it, i) => (i === at ? next : it));
}

/** Chambers of each project that did not start, counted while their one notice shows. */
const failedCount = new Map<string, number>();

/** One notice per project however many of its chambers could not start (a pack gone mid-line). */
function sayFailed(n: Extract<LaneNotice, { state: 'failed' }>): void {
  const key = folderKey(n.project);
  const count = (failedCount.get(key) ?? 0) + 1;
  failedCount.set(key, count);
  toast(t('fly.queue.failedToast', { count }), {
    id: `inspector-queue-failed:${key}`,
    tone: 'error',
    detail: n.error,
    testId: 'inspector-queue-failed',
    onDismiss: () => {
      failedCount.delete(key);
    },
  });
}

/** Reads the open project's spaces again after main tidied its manifest (team/reload). */
let reloadSpaces: (projectId: string) => Promise<void> = async (projectId) => {
  const { reloadRecords } = await import('../team/reload');
  await reloadRecords(projectId, [{ rec: 'manifest', id: 'manifest' }]);
};

/** Test seam: what reads the spaces again. */
export function setSpacesReload(fn: (projectId: string) => Promise<void>): void {
  reloadSpaces = fn;
}

/** A notice from main: the open project's import card and spaces follow it. */
export function onLaneNotice(n: LaneNotice): void {
  if (n.state === 'failed') sayFailed(n);
  const project = workspace.getState().project;
  if (!project || folderKey(project.root) !== folderKey(n.project)) return;
  if (n.state === 'tidied') {
    void reloadSpaces(project.id).catch((e: unknown) => {
      console.warn('The spaces were not read again after a tidy', e);
    });
    return;
  }
  const result = builder.getState().importResult;
  if (!result) return;
  const items = applyLaneNotice(result.items, n);
  if (items) builder.setState({ importResult: { ...result, items } });
}

/** A chamber's row as its job goes: converting (with progress), then imported, failed, cancelled. */
function rowFor(
  row: ImportItem,
  job: Pick<JobRecord, 'status' | 'progress' | 'error'>,
): ImportItem {
  switch (job.status) {
    case 'starting':
    case 'running':
    case 'cancelling':
      return {
        ...row,
        status: 'queued',
        message:
          job.progress > 0
            ? t('fly.queue.progress', { pct: Math.round(job.progress * 100) })
            : t('fly.queue.started'),
      };
    case 'done':
      return { ...row, status: 'imported', message: t('fly.queue.done') };
    case 'cancelled':
      return { ...row, status: 'skipped', message: t('fly.queue.jobCancelled') };
    case 'interrupted':
      return { ...row, status: 'error', message: t('fly.queue.interrupted') };
    case 'failed':
      return { ...row, status: 'error', message: job.error ?? t('fly.queue.jobFailed') };
  }
}

/**
 * A job event: the import card row of that Inspector import follows it. Once every row of the
 * card is imported the card closes; a failed or skipped row keeps it open to be read.
 */
export function onJobUpdate(
  job: Pick<JobRecord, 'id' | 'pipeline' | 'status' | 'progress' | 'error'>,
): void {
  if (job.pipeline !== 'flyability.import') return;
  const result = builder.getState().importResult;
  if (!result) return;
  const at = result.items.findIndex((i) => i.kind === 'flyability' && i.jobId === job.id);
  const row = at < 0 ? undefined : result.items[at];
  if (!row) return;
  const next = rowFor(row, job);
  if (next.status === row.status && next.message === row.message) return;
  const items = result.items.map((it, i) => (i === at ? next : it));
  if (items.every((i) => i.status === 'imported')) builder.setState({ importResult: null });
  else builder.setState({ importResult: { ...result, items } });
}

/** Listen for the chambers' notices and jobs while the import layer is mounted. */
export function watchInspectorQueue(): () => void {
  const aio = (window as { aio?: AioBridge }).aio;
  if (!aio) return () => undefined;
  const offs = [
    aio.on('builder:inspectorQueue', onLaneNotice),
    aio.on('jobs:event', (e) => {
      if (e.type === 'update') onJobUpdate(e.job);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
