import { z } from 'zod';

export const Id = z.string().min(1).max(128);

export const Vec2 = z.tuple([z.number(), z.number()]);
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Mat4 = z.array(z.number()).length(16);
export const IsoTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #rrggbb');

/** A file in the project package (content hash) or a path relative to the package root / external.json. */
export const AssetRef = z.union([
  z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ path: z.string().min(1) }).strict(),
]);

// ---- M9 primitives shared by the journal, identity, collaboration, exchange and sync contracts ----

/** Lower-case hex SHA-256 (64 characters): op ids, payload and content hashes, blob ids. */
export const Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'A SHA-256 is 64 lower-case hex digits.');

/** RFC 4648 base32 alphabet, lower case, no padding: ids that are safe as Windows file names. */
export const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Unpadded base64url (RFC 4648 section 5): public keys (43 characters) and signatures (86). */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Expected unpadded base64url.');

/** A raw Ed25519 public key (32 bytes), base64url. */
export const PublicKeyB64 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'An Ed25519 key is 43 base64url characters.');

/** An Ed25519 signature (64 bytes), base64url. */
export const SignatureB64 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/, 'An Ed25519 signature is 86 base64url characters.');

/**
 * Hybrid logical clock (M9, data-conventions section 17): wall milliseconds (13 digits), a counter
 * (4 digits) and the device id as tiebreak, e.g. `1793520903120.0003.d_<52 base32>`. Compared as
 * strings it orders events; it never orders by wall time alone.
 */
export const Hlc = z
  .string()
  .regex(/^\d{13}\.\d{4}\.d_[a-z2-7]{52}$/, 'A clock reading is <ms>.<counter>.<device>.');

export type Sha256Hex = z.infer<typeof Sha256Hex>;
export type Hlc = z.infer<typeof Hlc>;

export type Vec2 = z.infer<typeof Vec2>;
export type Vec3 = z.infer<typeof Vec3>;
export type Quat = z.infer<typeof Quat>;
export type Mat4 = z.infer<typeof Mat4>;
export type AssetRef = z.infer<typeof AssetRef>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(error: string): Result<T> => ({ ok: false, error });

/** Refinement: every item in `key` has a unique `id`. */
export function uniqueIds<K extends string>(key: K) {
  return (value: Record<K, readonly { id: string }[]>, ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const item of value[key]) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate id "${item.id}" in ${key}`,
          path: [key],
        });
      }
      seen.add(item.id);
    }
  };
}
