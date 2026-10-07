import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkOp, readSegment } from '@aio/journal';
import { ExchangeHeader, Op, type DeviceRecord, type ExchangePreview } from '@aio/schema';
import { decryptExchange, isEncryptedExchange } from './envelope';
import { ExchangeError } from './errors';
import { deviceRecordValid, verifyHeader } from './header';
import { exchangeMembers } from './names';
import { openExchangeZip, type ExchangeZip } from './zip';

export type SignatureState = ExchangePreview['signature'];

export interface OpenedExchange {
  readonly file: string;
  readonly header: ExchangeHeader;
  /** Ops as carried (raw JSON objects that passed the op schema and their own hashes). */
  readonly ops: readonly Op[];
  /** Device records carried in the file (each checked against its own key). */
  readonly devices: readonly DeviceRecord[];
  readonly signature: SignatureState;
  /** Things worth saying that do not stop an import. */
  readonly problems: readonly string[];
  /** Copy a carried blob to `dest` (temp name, then rename), checking its hash; false if absent. */
  copyBlob(sha256: string, dest: string): Promise<boolean>;
  /** Remove the decrypted temp copy, if any. */
  close(): Promise<void>;
}

export interface OpenExchangeOptions {
  passphrase?: string;
  /** Where an encrypted file is decrypted for reading (removed by `close`). */
  tmpDir: string;
  /** Device records this copy already holds (the sender may not include its own). */
  knownDevices?: (id: string) => DeviceRecord | undefined;
  /** Devices revoked in this project (T2's `device.revoke` ops). */
  revoked?: (id: string) => boolean;
}

const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const MAX_DEVICE_BYTES = 1024 * 1024;

/**
 * Open an exchange file and check everything in it before anything is applied: the archive
 * layout (no hostile members), the header against the contract, every member listed in the header
 * and nothing else, every device record against its key, every op against its schema, its
 * position in its run and its own hashes and signature, and the header signature.
 */
export async function openExchange(file: string, o: OpenExchangeOptions): Promise<OpenedExchange> {
  let plain = file;
  let temp: string | null = null;
  if (await isEncryptedExchange(file).catch(() => false)) {
    if (o.passphrase === undefined) {
      throw new ExchangeError(
        'needs-passphrase',
        'This exchange file is encrypted. Enter its passphrase.',
      );
    }
    temp = join(o.tmpDir, `aiosync-${randomBytes(6).toString('hex')}.zip`);
    await decryptExchange(file, temp, o.passphrase);
    plain = temp;
  }
  try {
    const zip = await openExchangeZip(plain);
    const opened = await check(file, zip, o, temp !== null);
    return {
      ...opened,
      close: async () => {
        if (temp) await rm(temp, { force: true });
      },
    };
  } catch (e) {
    if (temp) await rm(temp, { force: true });
    throw e;
  }
}

function parseJson(buf: Buffer, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ExchangeError('damaged', `The exchange file is damaged (${what} is not valid JSON).`);
}

async function check(
  file: string,
  zip: ExchangeZip,
  o: OpenExchangeOptions,
  wasEncrypted: boolean,
): Promise<Omit<OpenedExchange, 'close'>> {
  if (!zip.entries.has(exchangeMembers.header)) {
    throw new ExchangeError(
      'not-exchange',
      'This is not an exchange file (it has no aio-exchange.json). Choose a .aiosync file exported by Quadrion AI.',
    );
  }
  const rawHeader = parseJson(
    await zip.read(exchangeMembers.header, MAX_HEADER_BYTES),
    'the header',
  );
  const parsed = ExchangeHeader.safeParse(rawHeader);
  if (!parsed.success) {
    const schema = rawHeader.schema;
    if (
      typeof schema === 'string' &&
      /^aio\.exchange\/\d+$/.test(schema) &&
      schema !== 'aio.exchange/1'
    ) {
      throw new ExchangeError(
        'schema',
        'This exchange file was saved by a newer version of the app. Update the app to import it.',
      );
    }
    const issue = parsed.error.issues[0];
    throw new ExchangeError(
      'schema',
      `The exchange file header is not valid (${issue?.path.length ? issue.path.join('.') : 'header'}: ${issue?.message ?? 'unknown'}).`,
    );
  }
  const header = parsed.data;
  const problems: string[] = [];
  if (header.encrypted && !wasEncrypted) {
    problems.push('The file was sent encrypted but arrived without encryption.');
  }

  // every member is listed in the header, and every listed member is there
  const listed = new Set<string>([exchangeMembers.header]);
  for (const c of header.chains) {
    const expected = exchangeMembers.ops(c.chain, c.from, c.to);
    if (c.member !== expected || c.to < c.from) {
      throw new ExchangeError(
        'hostile',
        `The exchange file was refused: the run ${c.member} does not match its chain and range.`,
      );
    }
    if (listed.has(c.member))
      throw new ExchangeError(
        'hostile',
        `The exchange file was refused: the run ${c.member} is listed twice.`,
      );
    listed.add(c.member);
    if (!zip.entries.has(c.member))
      throw new ExchangeError('damaged', `The exchange file is damaged (${c.member} is missing).`);
  }
  for (const b of header.blobs) {
    const name = exchangeMembers.blob(b.sha256);
    listed.add(name);
    const e = zip.entries.get(name);
    if (!e)
      throw new ExchangeError(
        'damaged',
        `The exchange file is damaged (a file of ${b.size} bytes is missing).`,
      );
    if (e.size !== b.size)
      throw new ExchangeError(
        'hostile',
        `The exchange file was refused: ${name} is not the size its header says.`,
      );
  }
  const devices: DeviceRecord[] = [];
  for (const name of zip.entries.keys()) {
    const m = /^journal\/devices\/(d_[a-z2-7]{52})\.json$/.exec(name);
    if (m) {
      const raw = parseJson(await zip.read(name, MAX_DEVICE_BYTES), name);
      if (!deviceRecordValid(raw) || raw.id !== m[1]) {
        throw new ExchangeError(
          'signature',
          `The exchange file was refused: the device record ${m[1]?.slice(0, 10) ?? ''} is not signed by its own key.`,
        );
      }
      devices.push(raw);
      listed.add(name);
      continue;
    }
    if (!listed.has(name)) {
      throw new ExchangeError(
        'hostile',
        `The exchange file was refused: ${name} is not listed in its header.`,
      );
    }
  }
  const deviceOf = (id: string) => devices.find((d) => d.id === id) ?? o.knownDevices?.(id);

  // the header signature
  const sender = deviceOf(header.from.device);
  let signature: SignatureState;
  if (!sender) signature = 'unknown-device';
  else if (sender.actor !== header.from.actor || !verifyHeader(rawHeader, sender.key))
    signature = 'invalid';
  else if (o.revoked?.(sender.id)) signature = 'revoked-device';
  else signature = 'valid';

  // every op: schema, place in its run, own hashes, signature
  const ops: Op[] = [];
  for (const c of header.chains) {
    const text = (await zip.read(c.member)).toString('utf8');
    let expect = c.from;
    for (const line of readSegment(text)) {
      const where = `${c.member} line ${line.line}`;
      if (!line.ok)
        throw new ExchangeError(
          'damaged',
          `The exchange file is damaged (${where}: ${line.error}).`,
        );
      const op = Op.safeParse(line.raw);
      if (!op.success) {
        throw new ExchangeError(
          'schema',
          `The exchange file was refused: ${where} is not a valid change (${op.error.issues[0]?.message ?? 'unknown'}).`,
        );
      }
      if (op.data.chain !== c.chain || op.data.seq !== expect) {
        throw new ExchangeError(
          'hostile',
          `The exchange file was refused: ${where} is not change #${expect} of its chain.`,
        );
      }
      const key = deviceOf(op.data.dev)?.key;
      const verdict = checkOp(line.raw, key);
      if (!verdict.id || verdict.payload === false) {
        throw new ExchangeError(
          'signature',
          `The exchange file was refused: change #${op.data.seq} (${where}) was edited after it was made.`,
        );
      }
      if (verdict.signature === false) {
        throw new ExchangeError(
          'signature',
          `The exchange file was refused: change #${op.data.seq} (${where}) has a signature that does not verify.`,
        );
      }
      if (!key)
        problems.push(
          `Changes from device ${op.data.dev.slice(0, 10)} cannot be checked: its record is not in the file.`,
        );
      ops.push(line.raw as Op);
      expect++;
    }
    if (expect !== c.to + 1) {
      throw new ExchangeError(
        'damaged',
        `The exchange file is damaged (${c.member} holds ${expect - c.from} changes, its header says ${c.to - c.from + 1}).`,
      );
    }
  }
  if (ops.length !== header.counts.ops) {
    throw new ExchangeError(
      'damaged',
      `The exchange file is damaged (${ops.length} changes, its header says ${header.counts.ops}).`,
    );
  }

  return {
    file,
    header,
    ops,
    devices,
    signature,
    problems: [...new Set(problems)],
    copyBlob: async (sha256, dest) => {
      const name = exchangeMembers.blob(sha256);
      if (!zip.entries.has(name)) return false;
      const tmp = `${dest}.${randomBytes(4).toString('hex')}.partial`;
      const fh = await open(tmp, 'wx');
      let pos = 0;
      try {
        const got = await zip.pipe(name, async (chunk) => {
          await fh.write(chunk, 0, chunk.length, pos);
          pos += chunk.length;
        });
        await fh.close();
        if (got !== sha256) {
          throw new ExchangeError(
            'damaged',
            'The exchange file is damaged (a file does not match its hash).',
          );
        }
        await rename(tmp, dest);
        return true;
      } catch (e) {
        await fh.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw e;
      }
    },
  };
}
