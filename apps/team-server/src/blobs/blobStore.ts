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

/** An upload that would take a device past its quota of unfinished uploads. */
export class BlobQuotaError extends Error {
  constructor(readonly quota: number) {
    super(
      `This upload would take this device past ${Math.round(quota / 1024 ** 3)} GB of unfinished uploads. Finish the others first, or ask your IT team.`,
    );
    this.name = 'BlobQuotaError';
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
  /** Bytes this device has sent so far of its unfinished upload (0 when none). */
  received(sha256: string, uploader: string): Promise<number>;
  /**
   * Write the part starting at `start` of a blob of `total` bytes, sent by `uploader` (a device
   * id). Each device has its own unfinished uploads, so nobody can add bytes to another device's
   * upload. `start` must equal the bytes this device sent so far (`BlobOffsetError` otherwise),
   * and its unfinished uploads stay under its quota (`BlobQuotaError`). The last part checks the
   * hash (`BlobHashError`, the upload is discarded) and publishes the blob; a blob the store
   * already holds is still sent in full (the device proves it has the bytes).
   */
  write(
    sha256: string,
    start: number,
    total: number,
    data: Buffer,
    uploader: string,
  ): Promise<{ received: number; complete: boolean }>;
  /** Read a complete blob, or bytes `[start, end)` of it; null when there is none. */
  read(sha256: string, range?: { start: number; end: number }): Promise<Readable | null>;
}
