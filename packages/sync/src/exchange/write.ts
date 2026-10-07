import { randomId, type Signer } from '@aio/journal';
import {
  EXCHANGE_SCHEMA,
  type DeviceRecord,
  type ExchangeHeader,
  type ExchangeKind,
  type Heads,
  type Op,
} from '@aio/schema';
import { rm } from 'node:fs/promises';
import { encryptExchange, type ScryptParams } from './envelope';
import { EXCHANGE_MAX_BYTES, ExchangeError, tooLarge } from './errors';
import { signHeader } from './header';
import { chainRuns } from './ingest';
import { exchangeMembers } from './names';
import { writeExchangeZip, type ZipMember } from './zip';

/** A blob a bundle carries: a project file known by its hash. */
export interface BundleBlob {
  sha256: string;
  size: number;
  /** Absolute path of the file on this computer. */
  file: string;
}

export interface WriteExchangeOptions {
  out: string;
  kind: ExchangeKind;
  teamProjectId: string;
  from: ExchangeHeader['from'];
  signer: Signer;
  since: ExchangeHeader['since'];
  /** The sender's heads after these ops. */
  heads: Heads;
  ops: readonly Op[];
  /** Device records of every device whose ops are carried (and the sender's). */
  devices: readonly DeviceRecord[];
  blobs?: readonly BundleBlob[];
  to?: ExchangeHeader['to'];
  package?: ExchangeHeader['package'];
  passphrase?: string;
  /** Tests: cheaper scrypt. */
  scrypt?: ScryptParams;
  now?: Date;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** What an exchange file would weigh, before writing it (exchange:plan, the 2 GB check). */
export function exchangeSize(ops: readonly Op[], blobs: readonly { size: number }[] = []): number {
  const opBytes = ops.reduce((n, op) => n + Buffer.byteLength(JSON.stringify(op)) + 1, 0);
  return opBytes + blobs.reduce((n, b) => n + b.size, 0) + 4096;
}

/**
 * Write a signed `.aiosync`: the header, the device records, the ops as `<from>-<to>.jsonl` runs
 * per chain and, for a bundle, the blobs. With a passphrase the whole file is then encrypted
 * (AES-256-GCM, scrypt). Refused before writing anything when it would pass 2 GB.
 */
export async function writeExchange(
  o: WriteExchangeOptions,
): Promise<{ header: ExchangeHeader; bytes: number }> {
  const blobs = o.blobs ?? [];
  const estimate = exchangeSize(o.ops, blobs);
  if (estimate > EXCHANGE_MAX_BYTES) throw tooLarge(estimate);

  const members: ZipMember[] = [];
  const chains: ExchangeHeader['chains'] = [];
  for (const run of chainRuns(o.ops)) {
    const member = exchangeMembers.ops(run.chain, run.from, run.to);
    chains.push({ chain: run.chain, from: run.from, to: run.to, member });
    const text = run.ops.map((op) => `${JSON.stringify(op)}\n`).join('');
    members.push({ name: member, data: Buffer.from(text, 'utf8') });
  }
  const deviceIds = new Set(o.devices.map((d) => d.id));
  for (const d of o.devices) {
    members.push({
      name: exchangeMembers.device(d.id),
      data: Buffer.from(`${JSON.stringify(d, null, 2)}\n`, 'utf8'),
    });
  }
  if (!deviceIds.has(o.from.device)) {
    throw new ExchangeError('signature', 'This device has no record to send with the file.');
  }
  const seenBlobs = new Set<string>();
  for (const b of blobs) {
    if (seenBlobs.has(b.sha256)) continue;
    seenBlobs.add(b.sha256);
    members.push({ name: exchangeMembers.blob(b.sha256), file: b.file, size: b.size });
  }
  const now = o.now ?? new Date();
  const bytes = members.reduce((n, m) => n + ('data' in m ? m.data.length : m.size), 0);
  const header = signHeader(
    {
      schema: EXCHANGE_SCHEMA,
      id: randomId('x_', 16),
      kind: o.kind,
      teamProjectId: o.teamProjectId,
      createdAt: now.toISOString(),
      from: o.from,
      ...(o.to ? { to: o.to } : {}),
      since: o.since,
      chains,
      heads: o.heads,
      blobs: [...seenBlobs].map((sha256) => ({
        sha256,
        size: blobs.find((b) => b.sha256 === sha256)?.size ?? 0,
      })),
      counts: { ops: o.ops.length, devices: o.devices.length, blobs: seenBlobs.size, bytes },
      ...(o.package ? { package: o.package } : {}),
      encrypted: o.passphrase !== undefined,
    },
    o.signer,
  );
  members.unshift({
    name: exchangeMembers.header,
    data: Buffer.from(`${JSON.stringify(header, null, 2)}\n`, 'utf8'),
  });

  const mismatched: string[] = [];
  const shaOf = new Map(blobs.map((b) => [exchangeMembers.blob(b.sha256), b.sha256]));
  const plain = o.passphrase === undefined ? o.out : `${o.out}.plain`;
  let wroteOut = false;
  try {
    const written = await writeExchangeZip(plain, members, {
      now,
      ...(o.signal ? { signal: o.signal } : {}),
      onProgress: (p) => o.onProgress?.(p.done, p.total),
      onHashed: (name, sha) => {
        if (shaOf.get(name) !== sha) mismatched.push(name);
      },
    });
    wroteOut = plain === o.out;
    if (mismatched.length > 0) {
      throw new ExchangeError(
        'damaged',
        `A project file changed after it was registered (${mismatched.length} file${mismatched.length === 1 ? '' : 's'}). Open the project again so its files are indexed, then export again.`,
      );
    }
    if (o.passphrase === undefined) return { header, bytes: written.bytes };
    const enc = await encryptExchange(
      plain,
      o.out,
      o.passphrase,
      o.scrypt ? { scrypt: o.scrypt } : {},
    );
    return { header, bytes: enc.bytes };
  } catch (e) {
    if (wroteOut) await rm(o.out, { force: true });
    throw e;
  } finally {
    if (plain !== o.out) await rm(plain, { force: true });
  }
}
