import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * The file operations a hub needs, so tests can play a slow share or one that disappears. Paths
 * are absolute, in the platform's form.
 */
export interface HubFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Stream chunks into a new file (or append from `append`). */
  writeStream(path: string, data: AsyncIterable<Uint8Array>, append?: boolean): Promise<void>;
  readStream(path: string, range?: { start: number; end: number }): AsyncIterable<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** null when absent. */
  stat(path: string): Promise<{ size: number; mtimeMs: number; dir: boolean } | null>;
  rm(path: string): Promise<void>;
}

export const nodeHubFs: HubFs = {
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p),
  writeFile: (p, d) => writeFile(p, d),
  async writeStream(p, data, append = false) {
    await pipeline(Readable.from(data), createWriteStream(p, { flags: append ? 'a' : 'w' }));
  },
  readStream: (p, range) =>
    createReadStream(p, range ? { start: range.start, end: range.end - 1 } : {}),
  rename: (a, b) => rename(a, b),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  async stat(p) {
    try {
      const s = await stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, dir: s.isDirectory() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  rm: (p) => rm(p, { force: true }),
};

/** The hub folder cannot be reached (share offline, NAS asleep, network cable out). */
export class HubUnreachable extends Error {
  override name = 'HubUnreachable';
}

/**
 * Wrap every call with a time limit, so a share that hangs (SMB on a sleeping NAS can block for
 * a minute) makes the hub "not reachable" instead of freezing sync. A call that fails because the
 * share went away is reported the same way.
 */
export function withTimeouts(fs: HubFs, ms: number): HubFs {
  const gone = new Set([
    'ENOTCONN',
    'ENETUNREACH',
    'EHOSTDOWN',
    'ENETDOWN',
    'EIO',
    'EBADF',
    'UNKNOWN',
  ]);
  const limit = <T>(what: string, p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HubUnreachable(`The shared folder did not answer in time (${what}).`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          const code = (e as NodeJS.ErrnoException).code ?? '';
          reject(
            gone.has(code)
              ? new HubUnreachable(`The shared folder went away (${code}).`)
              : e instanceof Error
                ? e
                : new Error(String(e)),
          );
        },
      );
    });
  return {
    readdir: (p) => limit('list', fs.readdir(p)),
    readFile: (p) => limit('read', fs.readFile(p)),
    writeFile: (p, d) => limit('write', fs.writeFile(p, d)),
    writeStream: (p, d, a) => fs.writeStream(p, d, a),
    readStream: (p, r) => fs.readStream(p, r),
    rename: (a, b) => limit('rename', fs.rename(a, b)),
    mkdir: (p) => limit('create folder', fs.mkdir(p)),
    stat: (p) => limit('check', fs.stat(p)),
    rm: (p) => limit('remove', fs.rm(p)),
  };
}
