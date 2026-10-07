import type { KeyObject } from 'node:crypto';
import { CHECKPOINT_SCHEMA, type Checkpoint } from '@aio/schema';
import { contentHash, sha256Hex } from './hash';
import type { Signer } from './sign';
import { verifySignature } from './sign';

/** The head of one chain: its last seq and op id. */
export interface ChainHead {
  seq: number;
  id: string;
}

/**
 * Merkle root over chain heads sorted by chain id: leaf SHA-256 of `<chain> <seq> <id>`, node
 * SHA-256 of the two child hex strings, an odd node carried up (data-conventions section 17).
 * This is also the "audit head" that reports print.
 */
export function merkleRoot(heads: Readonly<Record<string, ChainHead>>): string {
  let level = Object.keys(heads)
    .sort()
    .map((chain) => {
      const h = heads[chain];
      return sha256Hex(`${chain} ${String(h?.seq)} ${h?.id ?? ''}`);
    });
  if (level.length === 0) return sha256Hex('');
  while (level.length > 1) {
    const up: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i] ?? '';
      const r = level[i + 1];
      up.push(r === undefined ? l : sha256Hex(l + r));
    }
    level = up;
  }
  return level[0] ?? '';
}

const without = (obj: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/** Build and sign a checkpoint over every known head. */
export function sealCheckpoint(
  input: {
    chain: string;
    act: string;
    hlc: string;
    seq: number;
    heads: Record<string, ChainHead>;
    count: number;
  },
  signer?: Signer,
): Checkpoint {
  const heads = Object.fromEntries(
    Object.keys(input.heads)
      .sort()
      .map((k) => [k, { seq: input.heads[k]?.seq ?? 1, id: input.heads[k]?.id ?? '' }]),
  );
  const dev = input.chain.split('.')[0] ?? '';
  const cp = {
    schema: CHECKPOINT_SCHEMA,
    chain: input.chain,
    dev,
    act: input.act,
    hlc: input.hlc,
    seq: input.seq,
    heads,
    count: input.count,
    root: merkleRoot(heads),
  };
  const id = contentHash(cp);
  return {
    ...cp,
    id,
    ...(signer ? { sig: signer.sign('aio.checkpoint/1', id) } : {}),
  };
}

export interface CheckpointCheck {
  id: boolean;
  root: boolean;
  /** null when unsigned or no key. */
  signature: boolean | null;
}

/** Check a checkpoint from its raw JSON. */
export function checkCheckpoint(
  raw: Record<string, unknown>,
  publicKey?: string | KeyObject | null,
): CheckpointCheck {
  const id = typeof raw.id === 'string' && contentHash(without(raw, ['id', 'sig'])) === raw.id;
  const heads = raw.heads;
  let root = false;
  if (heads && typeof heads === 'object' && !Array.isArray(heads)) {
    try {
      root = merkleRoot(heads as Record<string, ChainHead>) === raw.root;
    } catch {
      root = false;
    }
  }
  const signature =
    typeof raw.sig === 'string' && publicKey && typeof raw.id === 'string'
      ? verifySignature(publicKey, 'aio.checkpoint/1', raw.id, raw.sig)
      : null;
  return { id, root, signature };
}

/** Check the self-signature of a device record (`aio.device/1` over the hash without `sig`). */
export function checkDeviceRecord(raw: Record<string, unknown>): boolean {
  if (typeof raw.key !== 'string' || typeof raw.sig !== 'string') return false;
  return verifySignature(raw.key, 'aio.device/1', contentHash(without(raw, ['sig'])), raw.sig);
}

/** Sign a device record (the public half of this device) for `journal/devices/<id>.json`. */
export function sealDeviceRecord<T extends Record<string, unknown>>(
  rec: T,
  signer: Signer,
): T & { sig: string } {
  return { ...rec, sig: signer.sign('aio.device/1', contentHash(rec)) };
}
