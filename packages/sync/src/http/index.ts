/**
 * The team server client (`aio.sync/1` over HTTPS, M9 T7, preview): per-device signed requests
 * (RFC 9421, Ed25519), a pinned certificate fingerprint, no bearer tokens, and `HttpTransport`,
 * the server as a `SyncTransport`.
 */
import { SYNC_PROTOCOL, SYNC_ROUTES } from '@aio/schema';

export { SYNC_PROTOCOL, SYNC_ROUTES };
export { routePath } from './routes';
export {
  certFingerprint,
  createHttpClient,
  errorFor,
  isLoopbackHost,
  probeFingerprint,
  serverOrigin,
  TeamServerError,
  type HttpClient,
  type HttpClientOptions,
  type TeamServerErrorCode,
} from './client';
export {
  contentDigest,
  newNonce,
  signatureBase,
  signatureBaseHash,
  signatureParams,
  signRequest,
  SIGNATURE_LABEL,
  type SignedParts,
} from './signature';
export { chainKey, decodeSince, encodeSince, SINCE_MAX_LENGTH } from './since';
export { CLIENT_PROTOCOL, enrolDevice, serverHealth } from './server';
export {
  BLOB_PART_BYTES,
  createHttpTransport,
  PUSH_BATCH,
  type HttpTransport,
  type HttpTransportOptions,
} from './transport';
