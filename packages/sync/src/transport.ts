import type { BlobRef, ByteRange, Heads, Op, PullPage, PushResult } from '@aio/schema';

/**
 * Moves ops and blobs between two copies of a team project. Three implementations share it:
 * exchange files (`exchange/`), hub folders (`hub/`) and the team server (`http/`); a hosted
 * service later speaks the same protocol. A transport stores and forwards: it never merges.
 */
export interface SyncTransport {
  readonly kind: 'exchange' | 'hub' | 'server' | 'memory';
  /** The heads of every chain the other side holds. */
  heads(): Promise<Heads>;
  /** Send ops; ops already there come back as duplicates (idempotent). */
  pushOps(ops: readonly Op[]): Promise<PushResult>;
  /** Ops after `since` (per chain), a page at a time; pass `cursor` back for the next page. */
  pullOps(since: Heads, cursor?: string | null): Promise<PullPage>;
  /** Which of these blobs the other side has. */
  hasBlobs(sha256s: readonly string[]): Promise<Set<string>>;
  /** Store a blob, or the part of it from `offset` (resumable). The other side checks the hash. */
  putBlob(ref: BlobRef, data: AsyncIterable<Uint8Array>, offset?: number): Promise<void>;
  /** Read a blob, or a byte range of it; null when the other side does not have it. */
  getBlob(sha256: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array> | null>;
}
