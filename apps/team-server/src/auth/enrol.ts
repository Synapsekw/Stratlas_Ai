/**
 * Enrolment (M9: invite codes; M10 may plug in account tokens or OIDC through the same seam). An
 * admin makes a one-time code with a role (`invite --role reviewer`); a device sends the code with
 * its self-signed public record, signed by the same key; the server keeps the device and answers
 * with a device certificate (`level: 'server'`) signed by the server key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { contentHash, deviceIdFromKey, verifySignature } from '@aio/journal';
import { DeviceRecord, type DeviceCert, type Role } from '@aio/schema';
import type { ServerIdentity } from '../identity';
import type { EnrolledDevice, Invite } from '../store/store';

/** Crockford base32: no I, L, O or U, so a code read aloud or typed is hard to get wrong. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How long an invite code is valid by default. */
export const INVITE_DAYS = 7;

/** A new code: 16 characters (80 bits) in four groups, `7KQ2-M9XD-...`. */
export function newInviteCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += CODE_ALPHABET.charAt((bytes[i] ?? 0) % 32);
  return out.match(/.{4}/g)?.join('-') ?? out;
}

/** What is kept of a code: the SHA-256 of its normalised form (case and dashes ignored). */
export function inviteHash(code: string): string {
  const normal = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return createHash('sha256').update(`aio.invite/1\n${normal}`).digest('hex');
}

export function makeInvite(
  role: Role,
  project: string | null,
  now: Date,
  days = INVITE_DAYS,
): { code: string; invite: Invite } {
  const code = newInviteCode();
  return {
    code,
    invite: {
      codeHash: inviteHash(code),
      role,
      project,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
      usedAt: null,
      usedBy: null,
    },
  };
}

/** Check a device record: shape, key matches id, self-signature (`aio.device/1`). */
export function checkDeviceRecord(
  raw: unknown,
): { ok: true; record: DeviceRecord } | { ok: false; message: string } {
  const parsed = DeviceRecord.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'The device record is not valid.' };
  const record = parsed.data;
  if (deviceIdFromKey(Buffer.from(record.key, 'base64url')) !== record.id)
    return { ok: false, message: 'The device id does not belong to its key.' };
  // the signature covers the record as sent, without `sig`
  const signed: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete signed.sig;
  if (!verifySignature(record.key, 'aio.device/1', contentHash(signed), record.sig))
    return { ok: false, message: 'The device record is not signed by its key.' };
  return { ok: true, record };
}

/** The certificate a server gives an enrolled device. */
export function serverCert(server: ServerIdentity, device: EnrolledDevice, at: string): DeviceCert {
  const cert = {
    level: 'server' as const,
    issuer: { device: server.id },
    actor: device.actor,
    device: device.device,
    issuedAt: at,
  };
  return { ...cert, sig: server.signer.sign('aio.cert/1', contentHash(cert)) };
}
