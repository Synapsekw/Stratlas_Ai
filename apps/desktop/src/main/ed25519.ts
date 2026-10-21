import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Ed25519 checks against the public keys pinned in brand.json (`signing.updateFeedKey`,
 * `signing.pipelinePackKey`): base64 of the raw 32-byte key. Signatures are base64 of the
 * 64-byte signature over the exact bytes (tools/release/ed25519.mjs makes both).
 */

/** An Ed25519 public key from base64 of its raw 32 bytes, or null when it is not one. */
export function ed25519Key(publicKey: string): KeyObject | null {
  try {
    const raw = Buffer.from(publicKey.trim(), 'base64');
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/**
 * Whether `signature` (base64) is a valid Ed25519 signature of `data` under `publicKey`; null when
 * the key itself is not a valid public key.
 */
export function ed25519Valid(data: Buffer, signature: string, publicKey: string): boolean | null {
  const key = ed25519Key(publicKey);
  if (!key) return null;
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}
