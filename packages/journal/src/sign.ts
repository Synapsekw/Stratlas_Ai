import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { SIGNING_DOMAINS } from '@aio/schema';
import { deviceIdFromKey } from './hash';

/** One of the signature domains (`aio.op/1`, `aio.checkpoint/1`, ...). */
export type SigningDomain = (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS];

/**
 * What signs for a device. Main builds it from the vault (`device-signing`); tests inject one.
 * The private key never leaves it, and renderer code never holds one.
 */
export interface Signer {
  device: string;
  /** Raw public key, base64url (43 characters). */
  publicKey: string;
  sign(domain: SigningDomain, hash: string): string;
}

/** The signed message: `<domain>\n<hash>`, UTF-8. */
export function signingMessage(domain: SigningDomain, hash: string): Buffer {
  return Buffer.from(`${domain}\n${hash}`, 'utf8');
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKey(key: KeyObject): Buffer {
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

/** A signer from a private key object (Ed25519, from the vault or `generateKeyPairSync`). */
export function signerFromKey(privateKey: KeyObject): Signer {
  const raw = rawPublicKey(privateKey);
  return {
    device: deviceIdFromKey(raw),
    publicKey: raw.toString('base64url'),
    sign: (domain, hash) =>
      sign(null, signingMessage(domain, hash), privateKey).toString('base64url'),
  };
}

/** A signer from a 32-byte seed in hex. TEST-ONLY: fixtures and tests, never real devices. */
export function signerFromSeed(seedHex: string): Signer {
  const der = Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]);
  return signerFromKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
}

/** A public key object from a raw base64url Ed25519 key (cache it when checking many ops). */
export function publicKeyObject(publicKey: string): KeyObject | null {
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Check an Ed25519 signature over `<domain>
<hash>` with a raw base64url public key. */
export function verifySignature(
  publicKey: string | KeyObject,
  domain: SigningDomain,
  hash: string,
  signature: string,
): boolean {
  try {
    const key = typeof publicKey === 'string' ? publicKeyObject(publicKey) : publicKey;
    if (!key) return false;
    return verify(null, signingMessage(domain, hash), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
