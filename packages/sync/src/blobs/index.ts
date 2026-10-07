/**
 * Binaries by content (M9 T6): registration, hashing, fetch policies, transfers and the local
 * cache. T0 holds the policy defaults; T6 implements the rest.
 */
import { LARGE_BLOB_BYTES, type FetchPolicy } from '@aio/schema';

/** Layer kinds whose files are small and always useful (posters, small rasters, vectors). */
const ALWAYS_KINDS = new Set(['raster', 'vector', 'basemap']);
/** Layer kinds a person opens to review (photo review copies). */
const ON_OPEN_KINDS = new Set(['photos', 'panoramas']);

/** The default fetch policy of a layer's files on this machine (a person can change it). */
export function defaultFetchPolicy(layerKind: string, bytes: number): FetchPolicy {
  if (bytes > LARGE_BLOB_BYTES) return 'on-demand';
  if (ALWAYS_KINDS.has(layerKind)) return 'always';
  if (ON_OPEN_KINDS.has(layerKind)) return 'on-open';
  return bytes > LARGE_BLOB_BYTES / 4 ? 'on-demand' : 'always';
}
