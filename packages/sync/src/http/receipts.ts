/**
 * Checks of what the team server signs with its own key (2026-10-21): the device certificate it
 * gives at enrolment (`aio.cert/1`) and the receipts it gives for accepted ops (`aio.receipt/1`).
 * The app pins the server key at enrolment (or on first contact after an update), so a server that
 * accepted ops cannot later deny it, and a relay that answers in its place cannot forge receipts.
 */
import { createHash } from 'node:crypto';
import { base32, contentHash, verifySignature } from '@aio/journal';
import type { DeviceCert, DeviceRecord, PushResult, ServerKey } from '@aio/schema';

/** A server's id from its raw Ed25519 public key (base64url): `srv_` and 26 base32 letters. */
export function serverIdFromKey(publicKey: string): string {
  const raw = Buffer.from(publicKey, 'base64url');
  return `srv_${base32(createHash('sha256').update(raw).digest()).slice(0, 26)}`;
}

/** Why a device certificate is not this server's certificate for this device; null when it is. */
export function serverCertProblem(
  server: ServerKey,
  cert: DeviceCert,
  device: Pick<DeviceRecord, 'id' | 'actor'>,
): string | null {
  if (cert.level !== 'server' || cert.issuer.device !== server.id)
    return 'it was not issued by this server';
  if (cert.device !== device.id) return 'it is for another device';
  if (cert.actor !== device.actor) return 'it is for another person';
  const { sig, ...body } = cert;
  if (!verifySignature(server.publicKey, 'aio.cert/1', contentHash(body), sig))
    return 'it is not signed by the server key';
  return null;
}

/**
 * Why the receipts of one push answer do not verify against the pinned server key; null when they
 * do. One receipt per accepted op, in order, each signed by the server, linked to the one before
 * (within the answer), and only for ops this request sent.
 */
export function receiptProblem(
  server: ServerKey,
  sent: ReadonlySet<string>,
  result: Pick<PushResult, 'accepted' | 'receipts'>,
): string | null {
  const { accepted, receipts } = result;
  if (receipts.length !== accepted.length) return 'there is not one receipt per accepted change';
  if (new Set(accepted).size !== accepted.length) return 'a change is accepted twice';
  // the shape (schema `aio.receipt/1`, hex ids, signature length) is checked by the answer's parse
  for (const [i, r] of receipts.entries()) {
    const { id, sig, ...body } = r;
    if (contentHash(body) !== id) return 'its content does not match its id';
    if (!verifySignature(server.publicKey, 'aio.receipt/1', id, sig))
      return 'it is not signed by the server key';
    if (r.server !== server.id) return 'it names another server';
    const before = receipts[i - 1];
    if (before && (r.prev !== before.id || r.seq !== before.seq + 1))
      return 'it does not follow the receipt before it';
    if (r.op !== accepted[i]) return 'it is not for the change the server accepted';
    if (!sent.has(r.op)) return 'it is for a change this app did not send';
  }
  return null;
}
