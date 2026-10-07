import type { Readable } from 'node:stream';

/** A blob upload part that does not continue where the last one stopped. */
export class BlobOffsetError extends Error {
  constructor(readonly received: number) {
    super(`The upload continues at byte ${received}.`);
    this.name = 'BlobOffsetError';
  }
}

/** The bytes of a finished upload do not hash to its name. */
export class BlobHashError extends Error {
  constructor() {
    super('The file does not match its hash; the upload was discarded.');
    this.name = 'BlobHashError';
  }
}

/**
 * Where blobs live, by SHA-256: the file system by default, or a customer's S3-compatible store.
 * Equal hashes are stored once (across projects). Uploads come in parts and resume; a blob
 * becomes visible only once its whole content hashes to its name.
 */
export interface BlobStore {
  readonly kind: 'fs' | 's3';
  /** Size of a complete blob; null when there is none. */
  stat(sha256: string): Promise<{ size: number } | null>;
  /** Bytes received so far of an unfinished upload (0 when none). */
  received(sha256: string): Promise<number>;
  /**
   * Write the part starting at `start` of a blob of `total` bytes. `start` must equal the bytes
   * received so far (`BlobOffsetError` otherwise). The last part checks the hash
   * (`BlobHashError`, the upload is discarded) and publishes the blob.
   */
  write(
    sha256: string,
    start: number,
    total: number,
    data: Buffer,
  ): Promise<{ received: number; complete: boolean }>;
  /** Read a complete blob, or bytes `[start, end)` of it; null when there is none. */
  read(sha256: string, range?: { start: number; end: number }): Promise<Readable | null>;
}
