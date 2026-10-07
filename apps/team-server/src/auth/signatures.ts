/**
 * Checking per-device request signatures (RFC 9421 HTTP Message Signatures, `aio.sync/1`).
 * The covered components are exactly `SIGNED_REQUEST_COMPONENTS`; the signature is Ed25519 over
 * `aio.request/1\n<sha256 hex of the signature base>`. A request is refused when the digest does
 * not match the body, when it was created more than five minutes away from the server clock, or
 * when its nonce was seen before (replay). This is the server's own copy of the format; the client
 * (`@aio/sync/http`) and this verifier are pinned to the same test vector.
 */
import { createHash } from 'node:crypto';
import { verifySignature } from '@aio/journal';
import { SIGNED_REQUEST_COMPONENTS } from '@aio/schema';

/** How far a request's creation time may be from the server clock. */
export const SIGNATURE_WINDOW_S = 300;

export function contentDigest(body: Uint8Array): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

function params(device: string, created: number): string {
  const list = SIGNED_REQUEST_COMPONENTS.map((c) => `"${c}"`).join(' ');
  return `(${list});created=${created};keyid="${device}";alg="ed25519"`;
}

export function signatureBase(p: {
  method: string;
  url: string;
  digest: string;
  device: string;
  nonce: string;
  created: number;
}): string {
  const values: Record<(typeof SIGNED_REQUEST_COMPONENTS)[number], string> = {
    '@method': p.method.toUpperCase(),
    '@target-uri': p.url,
    'content-digest': p.digest,
    'x-aio-device': p.device,
    'x-aio-nonce': p.nonce,
  };
  return [
    ...SIGNED_REQUEST_COMPONENTS.map((c) => `"${c}": ${values[c]}`),
    `"@signature-params": ${params(p.device, p.created)}`,
  ].join('\n');
}

/** Nonces seen inside the window, per device (replays are refused). */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs = SIGNATURE_WINDOW_S * 2 * 1000) {}

  /** Record a nonce; false when it was already used. */
  use(device: string, nonce: string, nowMs: number): boolean {
    if (this.seen.size > 10_000) this.sweep(nowMs);
    const key = `${device} ${nonce}`;
    const at = this.seen.get(key);
    if (at !== undefined && nowMs - at < this.windowMs) return false;
    this.seen.set(key, nowMs);
    return true;
  }

  private sweep(nowMs: number): void {
    for (const [k, at] of this.seen) if (nowMs - at >= this.windowMs) this.seen.delete(k);
  }
}

export type SignatureFailure =
  | 'missing'
  | 'malformed'
  | 'components'
  | 'digest'
  | 'expired'
  | 'replay'
  | 'unknown-device'
  | 'signature';

export interface SignedRequest {
  method: string;
  /** The target URI as the device saw it. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
}

const header = (h: SignedRequest['headers'], name: string): string | null => {
  const v = h[name];
  return typeof v === 'string' ? v : null;
};

/**
 * Verify a request. `keyFor` gives the public key of an enrolled, non-revoked device (or, for
 * enrolment, the key in the record being enrolled); null refuses the device.
 */
export function verifyRequest(
  req: SignedRequest,
  keyFor: (device: string) => string | null,
  nonces: NonceCache,
  nowMs: number,
): { ok: true; device: string } | { ok: false; why: SignatureFailure } {
  const input = header(req.headers, 'signature-input');
  const signature = header(req.headers, 'signature');
  const device = header(req.headers, 'x-aio-device');
  const nonce = header(req.headers, 'x-aio-nonce');
  const digest = header(req.headers, 'content-digest');
  if (!input || !signature || !device || !nonce || !digest) return { ok: false, why: 'missing' };

  const m = /^aio=(\([^)]*\));created=(\d{1,12});keyid="([^"]+)";alg="ed25519"$/.exec(input);
  const s = /^aio=:([A-Za-z0-9+/]+={0,2}):$/.exec(signature);
  if (!m?.[1] || !m[2] || !m[3] || !s?.[1] || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return { ok: false, why: 'malformed' };
  const created = Number(m[2]);
  if (m[1] !== params(device, created).split(';')[0]) return { ok: false, why: 'components' };
  if (m[3] !== device) return { ok: false, why: 'malformed' };
  if (contentDigest(req.body) !== digest) return { ok: false, why: 'digest' };
  if (Math.abs(nowMs / 1000 - created) > SIGNATURE_WINDOW_S) return { ok: false, why: 'expired' };

  const key = keyFor(device);
  if (!key) return { ok: false, why: 'unknown-device' };
  const hash = createHash('sha256')
    .update(signatureBase({ method: req.method, url: req.url, digest, device, nonce, created }))
    .digest('hex');
  const sig = Buffer.from(s[1], 'base64').toString('base64url');
  if (!verifySignature(key, 'aio.request/1', hash, sig)) return { ok: false, why: 'signature' };
  // the nonce counts only once the signature is good, so nobody can burn another device's nonces
  if (!nonces.use(device, nonce, nowMs)) return { ok: false, why: 'replay' };
  return { ok: true, device };
}
