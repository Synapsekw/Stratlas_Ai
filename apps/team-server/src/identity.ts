/**
 * The server's own Ed25519 key: it signs receipts and the device certificates it gives at
 * enrolment. Kept in a file only the server user can read (a Docker secret or the data volume),
 * never in the database, never in a log.
 */
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { base32, signerFromKey, type Signer } from '@aio/journal';

export interface ServerIdentity {
  /** `srv_` plus 26 base32 letters of the SHA-256 of the public key. */
  id: string;
  /** Raw public key, base64url (published in audit exports). */
  publicKey: string;
  signer: Signer;
}

export function serverIdentity(privateKey: KeyObject): ServerIdentity {
  const signer = signerFromKey(privateKey);
  const raw = Buffer.from(signer.publicKey, 'base64url');
  const id = `srv_${base32(createHash('sha256').update(raw).digest()).slice(0, 26)}`;
  return { id, publicKey: signer.publicKey, signer };
}

/** A fresh key in memory (tests, the in-process e2e server, `serve --memory`). */
export function ephemeralIdentity(): ServerIdentity {
  return serverIdentity(generateKeyPairSync('ed25519').privateKey);
}

/** Read the key file, or create it (mode 0600) on first start. */
export function loadOrCreateIdentity(file: string): ServerIdentity {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
  }
  return serverIdentity(createPrivateKey(readFileSync(file)));
}
