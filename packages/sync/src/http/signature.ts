/**
 * Per-device request signatures for `aio.sync/1` (RFC 9421 HTTP Message Signatures). There are no
 * bearer tokens: every request carries the covered components of `SIGNED_REQUEST_COMPONENTS`, a
 * fresh nonce and a creation time, signed by the device key. The signature is Ed25519 over
 * `aio.request/1\n<sha256 hex of the RFC 9421 signature base>` (the journal's domain rule), so a
 * request signature can never be replayed as an op, a checkpoint or a certificate.
 *
 * The team server has its own copy of the verifier (`apps/team-server/src/auth/signatures.ts`);
 * both are pinned to the same test vector.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SIGNED_REQUEST_COMPONENTS } from '@aio/schema';
import type { Signer } from '@aio/journal';

/** The signature label in `Signature-Input` and `Signature`. */
export const SIGNATURE_LABEL = 'aio';

/** RFC 9530 `Content-Digest` of a body (an empty body has a digest too). */
export function contentDigest(body: Uint8Array | string = new Uint8Array()): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

export interface SignedParts {
  method: string;
  /** The full target URI, as the server sees it (`https://host:port/v1/...?...`). */
  url: string;
  digest: string;
  device: string;
  nonce: string;
  /** Unix seconds. */
  created: number;
}

/** The value of `@signature-params` (also the `Signature-Input` member after `aio=`). */
export function signatureParams(device: string, created: number): string {
  const list = SIGNED_REQUEST_COMPONENTS.map((c) => `"${c}"`).join(' ');
  return `(${list});created=${created};keyid="${device}";alg="ed25519"`;
}

/** The RFC 9421 signature base: one line per covered component, then `@signature-params`. */
export function signatureBase(p: SignedParts): string {
  const values: Record<(typeof SIGNED_REQUEST_COMPONENTS)[number], string> = {
    '@method': p.method.toUpperCase(),
    '@target-uri': p.url,
    'content-digest': p.digest,
    'x-aio-device': p.device,
    'x-aio-nonce': p.nonce,
  };
  const lines = SIGNED_REQUEST_COMPONENTS.map((c) => `"${c}": ${values[c]}`);
  lines.push(`"@signature-params": ${signatureParams(p.device, p.created)}`);
  return lines.join('\n');
}

/** SHA-256 hex of the signature base: what the device signs under `aio.request/1`. */
export function signatureBaseHash(p: SignedParts): string {
  return createHash('sha256').update(signatureBase(p), 'utf8').digest('hex');
}

/** A fresh request nonce: 128 random bits, base64url. */
export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export interface SignOptions {
  now?: number;
  nonce?: string;
}

/** The headers that sign one request. */
export function signRequest(
  signer: Signer,
  req: { method: string; url: string; body?: Uint8Array | string | undefined },
  { now = Date.now(), nonce = newNonce() }: SignOptions = {},
): Record<string, string> {
  const parts: SignedParts = {
    method: req.method,
    url: req.url,
    digest: contentDigest(req.body ?? new Uint8Array()),
    device: signer.device,
    nonce,
    created: Math.floor(now / 1000),
  };
  const sig = Buffer.from(signer.sign('aio.request/1', signatureBaseHash(parts)), 'base64url');
  return {
    'content-digest': parts.digest,
    'x-aio-device': parts.device,
    'x-aio-nonce': parts.nonce,
    'signature-input': `${SIGNATURE_LABEL}=${signatureParams(parts.device, parts.created)}`,
    signature: `${SIGNATURE_LABEL}=:${sig.toString('base64')}:`,
  };
}
