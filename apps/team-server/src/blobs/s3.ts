/**
 * Blobs in a customer's S3-compatible store (decision 15): the interface is fixed here; the
 * adapter itself is not in the preview.
 *
 * TODO(M9 T7 follow-up): implement with `@aws-sdk/client-s3` (Apache-2.0, cleared in the plan):
 * - `stat`: HeadObject on `blobs/<aa>/<sha256>`;
 * - `write`: a multipart upload per blob (UploadPart per 8 MB part, the part number from
 *   `start / 8 MB`), `received` from ListParts, CompleteMultipartUpload on the last part after a
 *   streaming SHA-256 check (or the store's `x-amz-checksum-sha256`), AbortMultipartUpload on a
 *   hash mismatch;
 * - `read`: GetObject with a Range header.
 * The client adds about 3 MB and a large dependency tree to the image, so it waits until a
 * customer asks for it; the file system store covers the preview.
 */
import type { BlobStore } from './blobStore';

export interface S3Options {
  endpoint: string;
  bucket: string;
  region?: string;
  /** Path-style addressing (most self-hosted S3-compatible stores need it). */
  forcePathStyle?: boolean;
}

export function createS3BlobStore(options: S3Options): BlobStore {
  throw new Error(
    `The S3-compatible blob store (${options.endpoint}, bucket ${options.bucket}) is not in this preview build. Use the file system store (AIO_BLOB_STORE=fs).`,
  );
}
