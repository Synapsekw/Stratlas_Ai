import type { JobRecord, PanoRef } from '@aio/schema';
import { t } from '@aio/ui';
import { folderKey, isActive, sameFolder } from '../jobs';

export type PanoStatus =
  | { kind: 'ready' }
  | { kind: 'queued' }
  | { kind: 'stitching'; pct: number; jobId: string }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

/** How far Fly to stands back from a sphere, metres (spheres are shot 60 to 75 m up). */
export const PANO_FLY_DISTANCE_M = 120;

/** The newest `pano.stitch` job of a sphere in the project at `root` (jobs are newest first). */
export function jobForPano<T extends Pick<JobRecord, 'pipeline' | 'project' | 'params'>>(
  jobs: readonly T[],
  root: string,
  layer: string,
  pano: string,
): T | undefined {
  const key = folderKey(root);
  return jobs.find(
    (j) =>
      j.pipeline === 'pano.stitch' &&
      j.params.layer === layer &&
      j.params.pano === pano &&
      folderKey(j.project) === key,
  );
}

/** A sphere's state: its live job when there is one at least as new as its run, else the item. */
export function panoStatus(item: PanoRef, job: JobRecord | undefined): PanoStatus {
  const s = item.stitch;
  if (!s) return { kind: 'ready' };
  if (job && (s.run === undefined || job.id >= s.run)) {
    if (isActive(job))
      return {
        kind: 'stitching',
        pct: Math.min(99, Math.round(job.progress * 100)),
        jobId: job.id,
      };
    if (job.status === 'done') return { kind: 'done' };
    if (job.status === 'failed' || job.status === 'interrupted')
      return { kind: 'failed', message: job.error ?? t('pano.status.failedDefault') };
    if (job.status === 'cancelled') return { kind: 'queued' };
  }
  if (s.status === 'done') return { kind: 'done' };
  if (s.status === 'failed') return { kind: 'failed', message: s.error ?? '' };
  // queued, or running without a live job (the app closed while it ran)
  return { kind: 'queued' };
}

export function panoStatusText(s: PanoStatus): string {
  switch (s.kind) {
    case 'ready':
    case 'done':
      return t('pano.status.done');
    case 'queued':
      return t('pano.status.queued');
    case 'stitching':
      return t('pano.status.stitching', { pct: s.pct });
    case 'failed':
      return s.message
        ? t('pano.status.failed', { message: s.message })
        : t('pano.status.failedBare');
  }
}

const ENDED = new Set(['failed', 'interrupted', 'cancelled']);

/** A stitch of this project just failed, stopped or was cancelled: main filed it, reload. */
export function finishedPanoStitch(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean {
  return next.some(
    (j) =>
      j.pipeline === 'pano.stitch' &&
      ENDED.has(j.status) &&
      sameFolder(j.project, root) &&
      prev.find((p) => p.id === j.id)?.status !== j.status,
  );
}
