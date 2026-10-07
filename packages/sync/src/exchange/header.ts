import { contentHash, deviceIdFromKey, verifySignature, type Signer } from '@aio/journal';
import { DeviceRecord, ExchangeHeader, SIGNING_DOMAINS } from '@aio/schema';

/** The header fields the writer fills in; `sig` comes from signing. */
export type UnsignedHeader = Pick<
  ExchangeHeader,
  | 'schema'
  | 'id'
  | 'kind'
  | 'teamProjectId'
  | 'createdAt'
  | 'from'
  | 'since'
  | 'chains'
  | 'heads'
  | 'blobs'
  | 'counts'
  | 'encrypted'
> &
  Partial<Pick<ExchangeHeader, 'to' | 'package'>>;

const withoutSig = (raw: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'sig'));

/** The hash a header signature covers: the canonical header without `sig`. */
export function headerHash(raw: Record<string, unknown>): string {
  return contentHash(withoutSig(raw));
}

export function signHeader(header: UnsignedHeader, signer: Signer): ExchangeHeader {
  if (header.from.device !== signer.device) {
    throw new Error('The exchange header names another device than the one signing it.');
  }
  const sig = signer.sign(SIGNING_DOMAINS.exchange, headerHash(header));
  return ExchangeHeader.parse({ ...header, sig });
}

/** Does the raw header verify with this raw public key (base64url)? Works on the raw JSON. */
export function verifyHeader(raw: Record<string, unknown>, publicKey: string): boolean {
  return (
    typeof raw.sig === 'string' &&
    verifySignature(publicKey, SIGNING_DOMAINS.exchange, headerHash(raw), raw.sig)
  );
}

/**
 * Is a raw device record what it claims: its id is the hash of its key, and it is signed by that
 * key (domain `aio.device/1`, over the canonical record without `sig`).
 */
export function deviceRecordValid(raw: Record<string, unknown>): raw is DeviceRecord {
  const parsed = DeviceRecord.safeParse(raw);
  if (!parsed.success) return false;
  const key = parsed.data.key;
  if (deviceIdFromKey(Buffer.from(key, 'base64url')) !== parsed.data.id) return false;
  return verifySignature(
    key,
    SIGNING_DOMAINS.device,
    contentHash(withoutSig(raw)),
    parsed.data.sig,
  );
}
