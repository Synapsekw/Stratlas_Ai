import { z } from 'zod';
import { Id, Sha256Hex } from './common';

/**
 * Large binaries by content (M9 stream T6, data-conventions section 20). Every binary a writer
 * produces is registered with a `blob.add` op; a copy that lacks the file still opens, and the
 * layer says "Not on this computer".
 */

/** A file of the project known by its content. `path` stays the project-relative path layers use. */
export const BlobRef = z.object({
  sha256: Sha256Hex,
  size: z.number().int().nonnegative(),
  /** Project-relative, forward slashes (as `AssetRef.path` and layer `src`). */
  path: z.string().min(1).max(1024),
  /** `source`: imported data; `derived`: built by the app or a pipeline (can be rebuilt). */
  role: z.enum(['source', 'derived']),
  layer: Id.optional(),
});

/** `blob.add` op payload. */
export const BlobAddPayload = BlobRef;

/** Where a blob stands on this computer. */
export const BlobState = z.enum(['present', 'missing', 'partial', 'stale', 'streaming']);

/**
 * When this machine fetches a layer's blobs: `always` (thumbnails, posters, small rasters),
 * `on-open` (photo review copies), `on-demand` (large files), `stream` (read from the hub on a LAN).
 */
export const FetchPolicy = z.enum(['always', 'on-open', 'on-demand', 'stream']);

/** Files above this size default to `on-demand` (video, COPC, PMTiles, GLB). */
export const LARGE_BLOB_BYTES = 200 * 1024 * 1024;
/** Server transfers move blobs in parts of this size (HTTP Range, resumable). */
export const BLOB_PART_BYTES = 8 * 1024 * 1024;

/** `aio://` answers a 404 for a blob this computer lacks with `x-aio-blob: missing <sha256> <size>`. */
export const MISSING_BLOB_HEADER = 'x-aio-blob';

export function missingBlobHeader(sha256: string, size: number): string {
  return `missing ${sha256} ${size}`;
}

export function parseMissingBlobHeader(value: string): { sha256: string; size: number } | null {
  const m = /^missing ([a-f0-9]{64}) (\d+)$/.exec(value.trim());
  return m?.[1] && m[2] ? { sha256: m[1], size: Number(m[2]) } : null;
}

/** Where a blob lives in a hub folder, a server store or an exchange bundle: `blobs/<aa>/<sha256>`. */
export function blobPath(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

/** One layer's binaries on this computer (blobs:status). */
export const LayerBlobStatus = z.object({
  layer: Id,
  state: BlobState,
  policy: FetchPolicy,
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** Bytes present on this computer. */
  have: z.number().int().nonnegative(),
});

export type BlobRef = z.infer<typeof BlobRef>;
export type BlobState = z.infer<typeof BlobState>;
export type FetchPolicy = z.infer<typeof FetchPolicy>;
export type LayerBlobStatus = z.infer<typeof LayerBlobStatus>;
