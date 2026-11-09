import type { AioBridge, ImportItem, IpcEvent } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { builder } from '../builder/state';

type LaneNotice = IpcEvent<'builder:inspectorQueue'>;

const lastPart = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;
const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The import card's rows once a waiting chamber started, left the line or could not start: the
 * chamber's row (its export folder's name, still queued without a job) is changed; null when no
 * row is that chamber's.
 */
export function applyLaneNotice(items: readonly ImportItem[], n: LaneNotice): ImportItem[] | null {
  const name = lastPart(n.src);
  const at = items.findIndex(
    (i) =>
      i.kind === 'flyability' && i.status === 'queued' && i.jobId === undefined && i.file === name,
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

/** A notice from main: the open project's import card follows it; a failure is always said. */
export function onLaneNotice(n: LaneNotice): void {
  if (n.state === 'failed')
    toast(t('fly.queue.failedToast', { name: lastPart(n.src) }), {
      tone: 'error',
      detail: n.error,
      testId: 'inspector-queue-failed',
    });
  const root = workspace.getState().project?.root;
  if (root === undefined || folderKey(root) !== folderKey(n.project)) return;
  const result = builder.getState().importResult;
  if (!result) return;
  const items = applyLaneNotice(result.items, n);
  if (items) builder.setState({ importResult: { ...result, items } });
}

/** Listen for the chambers' notices while the import layer is mounted; returns the unsubscribe. */
export function watchInspectorQueue(): () => void {
  const aio = (window as { aio?: AioBridge }).aio;
  return aio?.on('builder:inspectorQueue', onLaneNotice) ?? (() => undefined);
}
