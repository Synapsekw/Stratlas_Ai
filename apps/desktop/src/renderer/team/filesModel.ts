/**
 * What the Files panel and the layer placeholder say about one layer's files (M9 T6): pure, so
 * the wording and the action are tested without a window.
 */
import type { FetchPolicy, IpcEvent, LayerBlobStatus } from '@aio/schema';

export const POLICIES: readonly FetchPolicy[] = ['always', 'on-open', 'on-demand', 'stream'];

export type Progress = Pick<IpcEvent<'blobs:progress'>, 'done' | 'total' | 'state'>;

export interface RowView {
  /** Catalogue key of the state line. */
  text:
    | 'blobs.notHere'
    | 'blobs.downloading'
    | 'blobs.partial'
    | 'blobs.streaming'
    | 'blobs.stale'
    | 'blobs.present';
  /** Bytes for the line: the layer size, or done and total while downloading. */
  bytes: number;
  done: number;
  action: 'download' | 'resume' | 'cancel' | null;
  /** 0 to 1 while a download runs or is paused. */
  fraction: number | null;
}

/** The state line and action of one layer, from its status and any download in progress. */
export function rowView(s: LayerBlobStatus, p?: Progress | null): RowView {
  if (p?.state === 'running') {
    return {
      text: 'blobs.downloading',
      bytes: p.total,
      done: p.done,
      action: 'cancel',
      fraction: p.total > 0 ? Math.min(1, p.done / p.total) : 0,
    };
  }
  const base = { bytes: s.bytes, done: s.have };
  switch (s.state) {
    case 'present':
      return { ...base, text: 'blobs.present', action: null, fraction: null };
    case 'streaming':
      return { ...base, text: 'blobs.streaming', action: 'download', fraction: null };
    case 'partial':
      return {
        ...base,
        text: 'blobs.partial',
        action: 'resume',
        fraction: s.bytes > 0 ? Math.min(1, s.have / s.bytes) : 0,
      };
    case 'stale':
      return { ...base, text: 'blobs.stale', action: 'download', fraction: null };
    case 'missing':
      return { ...base, text: 'blobs.notHere', action: 'download', fraction: null };
  }
}

/**
 * Layers the placeholder lists: those not on this computer that can be fetched. A file that was
 * never registered (size unknown) is a broken layer as before M9, not a download, so it is left
 * out: a project that is never shared looks exactly as it did.
 */
export function needsAttention(layers: readonly LayerBlobStatus[]): LayerBlobStatus[] {
  return layers.filter((l) => l.state !== 'present' && l.bytes > 0);
}

/** A job id for `blobs:fetch` (at most 64 characters). */
export function newJobId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
