import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { AES_OVERHEAD, AES_SALT_BYTES, AesMemberEncryptor, deriveAesKeys } from './aes';
import {
  centralHeader,
  dosDateTime,
  endRecords,
  LOCAL_CRC_OFFSET,
  localHeader,
  type MemberRecord,
} from './format';

/** One member: a file on disk (streamed) or bytes in memory. */
export type ZipMember =
  | { name: string; file: string; size: number; mtimeMs?: number }
  | { name: string; data: Uint8Array; mtimeMs?: number };

export interface ZipProgress {
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  current?: string;
}

export interface WriteZipOptions {
  /** Encrypt every member with WinZip AES-256 (AE-2). */
  passphrase?: string;
  signal?: AbortSignal;
  onProgress?: (p: ZipProgress) => void;
  /** Write ZIP64 records even for a small archive (tests, tools that require them). */
  forceZip64?: boolean;
  /** Milliseconds between progress calls (default 100). */
  progressEveryMs?: number;
}

const CHUNK = 4 * 1024 * 1024;

function abortError(): Error {
  const e = new Error('Package export cancelled.');
  e.name = 'AbortError';
  return e;
}

const sizeOf = (m: ZipMember) => ('data' in m ? m.data.length : m.size);

/**
 * Stream members into a store-mode ZIP64 archive at `out` (no compression, so every member is
 * range-readable in place). Writes `<out>.partial` and renames it when complete; a cancelled or
 * failed run leaves nothing behind. Memory stays at one chunk whatever the archive size.
 */
export async function writeZip(
  out: string,
  members: readonly ZipMember[],
  opts: WriteZipOptions = {},
): Promise<{ bytes: number }> {
  const partial = `${out}.partial`;
  const force = opts.forceZip64 ?? false;
  const every = opts.progressEveryMs ?? 100;
  const bytesTotal = members.reduce((n, m) => n + sizeOf(m), 0);
  const progress: ZipProgress = {
    bytesDone: 0,
    bytesTotal,
    filesDone: 0,
    filesTotal: members.length,
  };
  let lastReport = 0;
  const report = (forceReport = false) => {
    const now = Date.now();
    if (!forceReport && now - lastReport < every) return;
    lastReport = now;
    opts.onProgress?.({ ...progress });
  };
  const check = () => {
    if (opts.signal?.aborted) throw abortError();
  };

  check();
  let fh: FileHandle | null = await open(partial, 'w');
  let pos = 0;
  const put = async (buf: Uint8Array) => {
    if (!fh) throw new Error('archive closed');
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await fh.write(buf, done, buf.length - done, pos + done);
      done += bytesWritten;
    }
    pos += buf.length;
  };

  try {
    const records: MemberRecord[] = [];
    for (const m of members) {
      check();
      const size = sizeOf(m);
      const encrypted = opts.passphrase !== undefined;
      const { dosDate, dosTime } = dosDateTime(m.mtimeMs ?? Date.now());
      const rec: MemberRecord = {
        name: Buffer.from(m.name, 'utf8'),
        size,
        compressedSize: size + (encrypted ? AES_OVERHEAD : 0),
        crc32: 0,
        encrypted,
        dosDate,
        dosTime,
        offset: pos,
      };
      progress.current = m.name;
      await put(localHeader(rec, force));

      let enc: AesMemberEncryptor | null = null;
      if (opts.passphrase !== undefined) {
        const salt = randomBytes(AES_SALT_BYTES);
        const keys = deriveAesKeys(opts.passphrase, salt);
        enc = new AesMemberEncryptor(keys);
        await put(Buffer.concat([salt, keys.check]));
      }

      let crc = 0;
      let written = 0;
      const emit = async (chunk: Uint8Array) => {
        check();
        if (enc) await put(enc.update(chunk));
        else {
          crc = crc32(chunk, crc);
          await put(chunk);
        }
        written += chunk.length;
        progress.bytesDone += chunk.length;
        report();
      };
      if ('data' in m) {
        for (let at = 0; at < m.data.length; at += CHUNK) {
          await emit(m.data.subarray(at, Math.min(at + CHUNK, m.data.length)));
        }
      } else {
        const stream = createReadStream(m.file, { highWaterMark: CHUNK });
        try {
          for await (const chunk of stream) await emit(chunk as Buffer);
        } finally {
          stream.destroy();
        }
      }
      if (written !== size) {
        throw new Error(
          `${m.name} changed while packaging (${String(written)} bytes, expected ${String(size)}). Close any program writing to the project and export again.`,
        );
      }
      if (enc) await put(enc.auth());
      else if (size > 0) {
        rec.crc32 = crc >>> 0;
        const b = Buffer.alloc(4);
        b.writeUInt32LE(rec.crc32, 0);
        await fh.write(b, 0, 4, rec.offset + LOCAL_CRC_OFFSET);
      }
      records.push(rec);
      progress.filesDone++;
      report();
    }

    check();
    const cdOffset = pos;
    for (const rec of records) await put(centralHeader(rec, force));
    const cdSize = pos - cdOffset;
    await put(endRecords({ entries: records.length, cdOffset, cdSize, forceZip64: force }));
    await fh.close();
    fh = null;
    await rename(partial, out);
    delete progress.current;
    report(true);
    return { bytes: pos };
  } catch (e) {
    if (fh) await fh.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw e;
  }
}
