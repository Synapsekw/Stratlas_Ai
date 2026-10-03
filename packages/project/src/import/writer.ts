import { createHash } from 'node:crypto';
import { copyFile, mkdir, rename, stat, utimes } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type WriteResult = 'written' | 'skipped';

/**
 * Writes files into a project package so that a re-run skips everything that has not changed:
 * copies keep the source mtime and are skipped when size and mtime match; generated files are
 * skipped when their bytes are identical; derived files (ffmpeg) are skipped when newer than
 * every source.
 */
export class PackageWriter {
  readonly stats = { written: 0, skipped: 0 };
  /** Relative paths touched in this run (written or skipped). */
  readonly files = new Set<string>();

  constructor(readonly root: string) {}

  abs(rel: string): string {
    return join(this.root, rel);
  }

  private done(rel: string, r: WriteResult): WriteResult {
    this.files.add(rel.replace(/\\/g, '/'));
    this.stats[r]++;
    return r;
  }

  async copy(src: string, rel: string): Promise<WriteResult> {
    const dst = this.abs(rel);
    const s = await stat(src);
    if (existsSync(dst)) {
      const d = statSync(dst);
      if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2)
        return this.done(rel, 'skipped');
    }
    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.partial`;
    await copyFile(src, tmp);
    await utimes(tmp, s.atime, s.mtime);
    await rename(tmp, dst);
    return this.done(rel, 'written');
  }

  write(rel: string, data: Uint8Array | string): WriteResult {
    const dst = this.abs(rel);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (existsSync(dst)) {
      const old = readFileSync(dst);
      if (old.length === bytes.length && sha256(old) === sha256(bytes)) {
        return this.done(rel, 'skipped');
      }
    }
    mkdirSync(dirname(dst), { recursive: true });
    const tmp = `${dst}.partial`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dst);
    return this.done(rel, 'written');
  }

  writeJson(rel: string, value: unknown, pretty = true): WriteResult {
    return this.write(rel, JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');
  }

  /** Produce `rel` with `make(absPath)` unless it exists and is newer than all `sources`. */
  async derive(
    rel: string,
    sources: readonly string[],
    make: (absOut: string) => Promise<void>,
  ): Promise<WriteResult> {
    const dst = this.abs(rel);
    if (existsSync(dst)) {
      const d = statSync(dst);
      const newest = Math.max(0, ...sources.map((s) => statSync(s).mtimeMs));
      if (d.size > 0 && d.mtimeMs >= newest) return this.done(rel, 'skipped');
    }
    await mkdir(dirname(dst), { recursive: true });
    await make(dst);
    if (!existsSync(dst)) throw new Error(`Derive step did not produce ${rel}`);
    return this.done(rel, 'written');
  }
}

export function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
