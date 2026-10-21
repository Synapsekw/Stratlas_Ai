/**
 * Checking per-device request signatures (RFC 9421 HTTP Message Signatures, `aio.sync/1`).
 * The covered components are `SIGNED_REQUEST_COMPONENTS`, then any of
 * `SIGNED_REQUEST_OPTIONAL_COMPONENTS` the request carries (in that order); the signature is
 * Ed25519 over `aio.request/1\n<sha256 hex of the signature base>`. A request is refused when the
 * digest does not match the body, when it was created more than five minutes away from the server
 * clock, or when its nonce was seen before (replay; the server keeps nonces in its store, so a
 * restart does not forget them). This is the server's own copy of the format; the client
 * (`@aio/sync/http`) and this verifier are pinned to the same test vector.
 *
 * `precheckRequest` is the part that needs no body: the server runs it before it reads a body.
 */
import { createHash } from 'node:crypto';
import { verifySignature } from '@aio/journal';
import { SIGNED_REQUEST_COMPONENTS, SIGNED_REQUEST_OPTIONAL_COMPONENTS } from '@aio/schema';

/** How far a request's creation time may be from the server clock. */
export const SIGNATURE_WINDOW_S = 300;
/** How long a nonce is remembered: a request inside the window cannot be sent twice. */
export const NONCE_WINDOW_MS = SIGNATURE_WINDOW_S * 2 * 1000;

type Optional = (typeof SIGNED_REQUEST_OPTIONAL_COMPONENTS)[number];

export function contentDigest(body: Uint8Array): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

function componentList(optional: readonly Optional[] = []): string {
  return `(${[...SIGNED_REQUEST_COMPONENTS, ...optional].map((c) => `"${c}"`).join(' ')})`;
}

function params(device: string, created: number, optional: readonly Optional[] = []): string {
  return `${componentList(optional)};created=${created};keyid="${device}";alg="ed25519"`;
}

export function signatureBase(p: {
  method: string;
  url: string;
  digest: string;
  device: string;
  nonce: string;
  created: number;
  /** Optional components the signature covers, with their values. */
  extra?: readonly { name: Optional; value: string }[];
}): string {
  const values: Record<(typeof SIGNED_REQUEST_COMPONENTS)[number], string> = {
    '@method': p.method.toUpperCase(),
    '@target-uri': p.url,
    'content-digest': p.digest,
    'x-aio-device': p.device,
    'x-aio-nonce': p.nonce,
  };
  const extra = p.extra ?? [];
  return [
    ...SIGNED_REQUEST_COMPONENTS.map((c) => `"${c}": ${values[c]}`),
    ...extra.map((e) => `"${e.name}": ${e.value}`),
    `"@signature-params": ${params(
      p.device,
      p.created,
      extra.map((e) => e.name),
    )}`,
  ].join('\n');
}

/** Where nonces are remembered (the server's store; `NonceCache` in memory). */
export interface NonceStore {
  /** Record a nonce; false when it was already used inside the window. */
  use(device: string, nonce: string, nowMs: number): boolean | Promise<boolean>;
}

/** Nonces seen inside the window, per device, in memory (tests and the verifier's unit tests). */
export class NonceCache implements NonceStore {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs = NONCE_WINDOW_MS) {}

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

type Headers = Readonly<Record<string, string | string[] | undefined>>;

export interface SignedRequest {
  method: string;
  /** The target URI as the device saw it. */
  url: string;
  headers: Headers;
  body: Uint8Array;
}

export interface VerifyOptions {
  /**
   * Refuse a request that carries `content-type` or `content-range` without covering it. Off by
   * default: apps before 2026-10-21 sign only the required components.
   */
  requireCovered?: boolean;
}

const header = (h: Headers, name: string): string | null => {
  const v = h[name];
  return typeof v === 'string' ? v : null;
};

/** The optional components a `Signature-Input` list covers; null when the list is not allowed. */
function coveredOptional(list: string): Optional[] | null {
  const m = /^\((.*)\)$/.exec(list);
  if (!m) return null;
  const names = (m[1] ?? '').split(' ').map((x) => /^"([a-z@-]+)"$/.exec(x)?.[1] ?? '');
  const required: readonly string[] = SIGNED_REQUEST_COMPONENTS;
  if (names.length < required.length || required.some((c, i) => names[i] !== c)) return null;
  const optional: Optional[] = [];
  let last = -1;
  for (const name of names.slice(required.length)) {
    const i = SIGNED_REQUEST_OPTIONAL_COMPONENTS.findIndex((c) => c === name);
    const component = SIGNED_REQUEST_OPTIONAL_COMPONENTS[i];
    if (component === undefined || i <= last) return null;
    last = i;
    optional.push(component);
  }
  return optional;
}

export type PreCheck =
  | {
      ok: true;
      device: string;
      nonce: string;
      digest: string;
      created: number;
      signature: string;
      extra: { name: Optional; value: string }[];
    }
  | { ok: false; why: SignatureFailure };

/** Everything about a signature that needs no body and no key: headers, components, time. */
export function precheckRequest(
  headers: Headers,
  nowMs: number,
  options: VerifyOptions = {},
): PreCheck {
  const input = header(headers, 'signature-input');
  const signature = header(headers, 'signature');
  const device = header(headers, 'x-aio-device');
  const nonce = header(headers, 'x-aio-nonce');
  const digest = header(headers, 'content-digest');
  if (!input || !signature || !device || !nonce || !digest) return { ok: false, why: 'missing' };

  const m = /^aio=(\([^)]*\));created=(\d{1,12});keyid="([^"]+)";alg="ed25519"$/.exec(input);
  const s = /^aio=:([A-Za-z0-9+/]+={0,2}):$/.exec(signature);
  if (!m?.[1] || !m[2] || !m[3] || !s?.[1] || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return { ok: false, why: 'malformed' };
  const optional = coveredOptional(m[1]);
  if (!optional) return { ok: false, why: 'components' };
  const extra: { name: Optional; value: string }[] = [];
  for (const name of optional) {
    const value = header(headers, name);
    if (value === null) return { ok: false, why: 'components' };
    extra.push({ name, value: value.trim() });
  }
  if (
    options.requireCovered &&
    SIGNED_REQUEST_OPTIONAL_COMPONENTS.some(
      (c) => header(headers, c) !== null && !optional.includes(c),
    )
  )
    return { ok: false, why: 'components' };
  if (m[3] !== device) return { ok: false, why: 'malformed' };
  const created = Number(m[2]);
  if (Math.abs(nowMs / 1000 - created) > SIGNATURE_WINDOW_S) return { ok: false, why: 'expired' };
  return { ok: true, device, nonce, digest, created, signature: s[1], extra };
}

/**
 * Verify a request. `keyFor` gives the public key of an enrolled, non-revoked device (or, for
 * enrolment, the key in the record being enrolled); null refuses the device.
 */
export async function verifyRequest(
  req: SignedRequest,
  keyFor: (device: string) => string | null,
  nonces: NonceStore,
  nowMs: number,
  options: VerifyOptions = {},
): Promise<{ ok: true; device: string } | { ok: false; why: SignatureFailure }> {
  const pre = precheckRequest(req.headers, nowMs, options);
  if (!pre.ok) return pre;
  const { device, nonce, digest, created, extra } = pre;
  if (contentDigest(req.body) !== digest) return { ok: false, why: 'digest' };

  const key = keyFor(device);
  if (!key) return { ok: false, why: 'unknown-device' };
  const hash = createHash('sha256')
    .update(
      signatureBase({ method: req.method, url: req.url, digest, device, nonce, created, extra }),
    )
    .digest('hex');
  const sig = Buffer.from(pre.signature, 'base64').toString('base64url');
  if (!verifySignature(key, 'aio.request/1', hash, sig)) return { ok: false, why: 'signature' };
  // the nonce counts only once the signature is good, so nobody can burn another device's nonces
  if (!(await nonces.use(device, nonce, nowMs))) return { ok: false, why: 'replay' };
  return { ok: true, device };
}
