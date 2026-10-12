import type { WalkLayout } from '@aio/schema';
import {
  PIPELINES,
  type ImportItem,
  type JobRecord,
  type PipelinePackStatus,
  type WalkFile,
  type WalkProcessParams,
  type WalkProcessSummary,
} from '@aio/schema';
import { t } from '@aio/ui';
import {
  chooseSide,
  resolveSplit,
  sideOf,
  type PaneKind,
  type SplitPref,
} from '../workspace/splitModel';

/* The 360 video pane without the DOM: time text, the player keys and where the pane opens. */

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatWalkTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h > 0 ? `${String(h)}:${p2(m)}:${p2(s % 60)}` : `${String(m)}:${p2(s % 60)}`;
}

/** What a key does to the player: play or pause, a playback rate, a step in seconds. */
export interface WalkKeyAction {
  play?: boolean;
  rate?: number;
  seekBy?: number;
}

/**
 * The keys of the video window (`VideoWindow` in `@aio/video`) for the 360 player: K pauses, L
 * plays and then doubles the speed, J slows down or steps back a second, comma and period or the
 * arrow keys step one frame. Space plays and pauses. Null for any other key.
 */
export function walkKeyAction(
  key: string,
  s: { playing: boolean; rate: number; fps: number },
): WalkKeyAction | null {
  const k = key.toLowerCase();
  const frame = 1 / (s.fps > 0 ? s.fps : 30);
  if (k === ' ') return s.playing ? { play: false } : { play: true, rate: 1 };
  if (k === 'k') return { play: false, rate: 1 };
  if (k === 'l') return s.playing ? { rate: Math.min(8, s.rate * 2) } : { play: true, rate: 1 };
  if (k === 'j')
    return s.playing && s.rate > 1 ? { rate: s.rate / 2 } : { play: false, seekBy: -1 };
  if (k === ',' || k === 'arrowleft') return { play: false, seekBy: -frame };
  if (k === '.' || k === 'arrowright') return { play: false, seekBy: frame };
  return null;
}

/**
 * Main has just answered an import (the import store's `cancellable` went from true to false).
 * The walk list is asked for again then, not when the import panel is free: an import stays
 * busy while a drawing's page question is open, and a walk must not wait for that answer.
 */
export function importAnswered(
  prev: { cancellable: boolean },
  next: { cancellable: boolean },
): boolean {
  return prev.cancellable && !next.cancellable;
}

/** The walk the pane shows: the chosen one while the project has it, else the first. */
export function pickWalk<T extends { id: string }>(
  walks: readonly T[],
  selected: string | null,
): T | undefined {
  return walks.find((w) => w.id === selected) ?? walks[0];
}

/** The split with the 360 video in it: where it already is, else on the right. */
export function splitWithWalk(
  saved: SplitPref | undefined,
  options: readonly PaneKind[],
): SplitPref {
  const sides = resolveSplit(saved, options);
  return sideOf(sides, 'walk360') ? sides : chooseSide(sides, 'right', 'walk360');
}

/**
 * A walk stitched in the app from a camera file plays unstabilised: the camera's gyro data is not
 * read yet. A stitched MP4 (from Insta360 Studio with FlowState, say) is taken as it is.
 */
export function walkUnstabilised(walk: { source: { layout: WalkLayout } }): boolean {
  return walk.source.layout !== 'equirect';
}

// ---------------------------------------------------------------- walk.process

/** The little of a job record the status reads. */
export type JobLike = Pick<JobRecord, 'id' | 'status' | 'progress' | 'updatedAt'> & {
  error?: string | undefined;
};

/** Where a walk stands with `walk.process`. */
export type WalkStatus =
  | { kind: 'not-processed' }
  | { kind: 'processing'; pct: number; jobId: string }
  | { kind: 'processed'; source: WalkProcessSummary['source'] }
  | { kind: 'failed'; message: string };

const ACTIVE: ReadonlySet<JobRecord['status']> = new Set(['starting', 'running', 'cancelling']);

/**
 * The status of a walk from its run record (`process.json`, as `walks:list` sums it up) and its
 * newest `walk.process` job. A running job wins; a failed job says so unless a run record newer
 * than the failure exists (an older processing stays on disk and still plays).
 */
export function walkStatus(
  _walk: WalkFile,
  processed: WalkProcessSummary | undefined,
  job: JobLike | undefined,
): WalkStatus {
  if (job && ACTIVE.has(job.status)) {
    // never 100 % before the job is done
    const pct = Math.min(99, Math.max(0, Math.floor(job.progress * 100)));
    return { kind: 'processing', pct, jobId: job.id };
  }
  if (job?.status === 'failed' && (!processed || processed.createdAt < job.updatedAt))
    return { kind: 'failed', message: job.error ?? t('walk.status.failedUnknown') };
  if (processed) return { kind: 'processed', source: processed.source };
  return { kind: 'not-processed' };
}

/** The status line under a walk in the 360 video list. */
export function walkStatusText(s: WalkStatus): string {
  switch (s.kind) {
    case 'not-processed':
      return t('walk.status.none');
    case 'processing':
      return t('walk.status.processing', { pct: s.pct });
    case 'processed':
      return t(s.source === 'pins-only' ? 'walk.status.pinsOnly' : 'walk.status.done');
    case 'failed':
      return t('walk.status.failed', { message: s.message });
  }
}

/** The video the pane plays: the levelled copy when there is one and Level horizon is on. */
export function playbackSrc(
  walk: WalkFile,
  processed: WalkProcessSummary | undefined,
  level: boolean,
): string {
  return level && processed?.stabilized ? processed.stabilized : walk.video.src;
}

/** Level horizon for a walk: on unless the person turned it off. */
export function levelOn(level: Readonly<Record<string, boolean>>, id: string): boolean {
  return level[id] ?? true;
}

/** One row of an import's answer as far as a walk goes, with the path the renderer passed. */
export interface ImportRow {
  file: string;
  status: ImportItem['status'];
  path?: string | undefined;
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** A file's name, lower case: how an import row (a name) finds the path it came from. */
export function pathKey(path: string): string {
  return fileName(path).toLowerCase();
}

/**
 * The rows of an import's answer that may have added a walk (imported video), each with the
 * absolute path it came from among the `paths` the import was given (rows name a file only).
 */
export function importedWalkRows(
  items: readonly Pick<ImportItem, 'file' | 'kind' | 'status'>[],
  paths: readonly string[],
): ImportRow[] {
  const byName = new Map(paths.map((p) => [pathKey(p), p]));
  return items
    .filter((i) => i.kind === 'video' && i.status === 'imported')
    .map((i) => {
      const path = byName.get(pathKey(i.file));
      return { file: i.file, status: i.status, ...(path ? { path } : {}) };
    });
}

/** The walk an import row added: the newest walk (the list is newest first) of that file. */
export function walkForRow<T extends Pick<WalkFile, 'source'>>(
  walks: readonly T[],
  row: Pick<ImportRow, 'file'>,
): T | undefined {
  return walks.find((w) => w.source.file === row.file);
}

/**
 * What `walk.process` starts with after an import added `walk`: the walk and the original the
 * import was given (without it, the job works from the playback copy). Null for a row that added
 * nothing, a camera's low resolution copy (`.lrv`), a row of another walk, or when the pipeline
 * pack has no `walk.process` (`offered`).
 */
export function autoStartParams(
  row: ImportRow,
  walk: WalkFile,
  offered: boolean,
): WalkProcessParams | null {
  if (!offered || row.status !== 'imported') return null;
  if (/\.lrv$/i.test(row.file) || walk.source.file !== row.file) return null;
  return { walk: walk.id, ...(row.path ? { src: [row.path] } : {}) };
}

const WALK_TITLE = PIPELINES.find((p) => p.name === 'walk.process')?.title ?? 'Process 360 walk';

/**
 * Whether the pipeline pack in use runs `walk.process`. The status names what a too old pack
 * cannot run: by title when one or two kinds of job are missing; a pack missing more is older
 * than this pipeline (each pack has every pipeline before its newest).
 */
export function packOffersWalkProcess(status: PipelinePackStatus | null): boolean {
  if (!status) return false;
  if (status.state === 'ok' || status.state === 'dev') return true;
  if (status.state !== 'too-old') return false;
  return !status.needs.some(
    (n) => n.includes(`"${WALK_TITLE}"`) || /cannot run \d+ kinds of job/.test(n),
  );
}

const folderKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The newest `walk.process` job of a walk in the project at `root` (the list is newest first). */
export function jobForWalk<T extends Pick<JobRecord, 'pipeline' | 'project' | 'params'>>(
  jobs: readonly T[],
  root: string,
  walkId: string,
): T | undefined {
  const key = folderKey(root);
  return jobs.find(
    (j) =>
      j.pipeline === 'walk.process' && j.params.walk === walkId && folderKey(j.project) === key,
  );
}

/**
 * Whether a file picked for **Locate...** is the walk's original, by name (the job checks the
 * size too): null when it is, else a sentence that says which file was picked.
 */
export function originalCheck(picked: string, original: string): string | null {
  const name = fileName(picked);
  return name.toLowerCase() === original.toLowerCase()
    ? null
    : t('walk.locate.wrong', { picked: name, file: original });
}
