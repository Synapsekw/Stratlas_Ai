import type { Op } from '@aio/schema';
import type { KeyObject } from 'node:crypto';
import { opId, payloadHash } from './hash';
import type { Signer } from './sign';
import { verifySignature } from './sign';

/** An op before sealing: everything but `id`, `ph` and `sig`. */
export type UnsealedOp = Omit<Op, 'id' | 'ph' | 'sig' | 'payload'>;

/** Compute `ph` and `id` and sign (no signer: an "unsigned" op, still hash-chained). */
export function sealOp(op: UnsealedOp, payload: unknown, signer?: Signer): Op {
  const withPh = { ...op, ph: payloadHash(payload) };
  const id = opId(withPh);
  const sealed = { ...withPh, id, payload } as Op;
  return signer ? { ...sealed, sig: signer.sign('aio.op/1', id) } : sealed;
}

/** What one op says about itself, from its raw JSON (never from a zod output). */
export interface OpCheck {
  /** The fields hash to `id`. */
  id: boolean;
  /** The payload hashes to `ph`; null when the payload is absent (redacted or stripped). */
  payload: boolean | null;
  /** The signature verifies with `publicKey`; null when unsigned or no key was given. */
  signature: boolean | null;
}

export function checkOp(
  raw: Record<string, unknown>,
  publicKey?: string | KeyObject | null,
): OpCheck {
  const id = typeof raw.id === 'string' && opId(raw) === raw.id;
  const payload = 'payload' in raw ? payloadHash(raw.payload) === raw.ph : null;
  const signature =
    typeof raw.sig === 'string' && publicKey && typeof raw.id === 'string'
      ? verifySignature(publicKey, 'aio.op/1', raw.id, raw.sig)
      : null;
  return { id, payload, signature };
}
