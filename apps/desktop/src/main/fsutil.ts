import { createHash } from 'node:crypto';
import { copyFile, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

/** Read and parse a JSON file; `undefined` when the file does not exist. Throws on bad JSON. */
export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return parseJsonText(text);
}

const parseJsonText = (text: string): unknown =>
  JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;

/** Codes Windows gives a rename onto a file that another process has open at that moment. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Rename `from` over `to`. Windows refuses to replace a file while any other process holds it
 * open, even only to read it (a search indexer, antivirus, a backup or sync client, a test reading
 * the settings), so there a refused rename is tried again for about 2.5 s before it fails.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !LOCKED.has(code) || wait > 1280) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// ---------------------------------------------------------------- compare-before-write

/**
 * What a file looked like when it was last read or written: its modification time and size, and
 * the SHA-256 of its bytes when known. Two people with one project folder open on a shared drive
 * compare this before a write, so neither silently replaces the other's save.
 */
export interface DiskVersion {
  mtimeMs: number;
  size: number;
  hash?: string;
}

/** A remembered version, or null when the file did not exist when it was last read. */
export type ExpectedVersion = DiskVersion | null;

/** Stable phrase of the refusal; the renderer matches it to offer Reload (no IPC code exists). */
export const CHANGED_ON_DISK_PHRASE = 'was changed by someone else since you opened it.';

/** The sentence a refused write shows, naming the file (`issues.json`). */
export function changedOnDiskMessage(name: string): string {
  return `${name} ${CHANGED_ON_DISK_PHRASE} Reload to see their changes; your edit was not saved.`;
}

/** A write refused because the file changed on disk since it was last read. Nothing was written. */
export class ChangedOnDiskError extends Error {
  readonly code = 'changed-on-disk' as const;
  readonly file: string;
  constructor(file: string, name: string = basename(file)) {
    super(changedOnDiskMessage(name));
    this.name = 'ChangedOnDiskError';
    this.file = file;
  }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Size and modification time of a file; null when it does not exist. */
async function statOf(file: string): Promise<DiskVersion | null> {
  try {
    const s = await stat(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Is the file still as `expect` says? Cheap first: a different size is a change, the same size and
 * time is none. The hash decides when the time differs at the same size (a touch, a sync client
 * writing the same bytes) and when the time is in whole seconds (FAT and some network shares keep
 * 1 to 2 s, so two writes in one tick look alike).
 */
async function unchanged(file: string, expect: ExpectedVersion): Promise<boolean> {
  const now = await statOf(file);
  if (now === null || expect === null) return now === expect;
  if (now.size !== expect.size) return false;
  const coarse = now.mtimeMs % 1000 === 0;
  if (now.mtimeMs === expect.mtimeMs && !coarse) return true;
  if (expect.hash === undefined) return now.mtimeMs === expect.mtimeMs;
  try {
    return sha256(await readFile(file)) === expect.hash;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

const keyOf = (file: string) => {
  const r = resolve(file);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * What this process last read or wrote, per file, for the record writers that compare before
 * writing (issues, change sets, detections, models, boundaries, narrative). A reader the person
 * sees remembers; every `writeJsonAtomic` of a remembered file (any writer of this process, such
 * as a sync merge) updates it, so the app's own writes never refuse the next one.
 */
export class SeenFiles {
  private readonly map = new Map<string, ExpectedVersion>();
  /** The remembered version; undefined when the file was never read here (no check). */
  expect(file: string): ExpectedVersion | undefined {
    return this.map.get(keyOf(file));
  }
  remember(file: string, version: ExpectedVersion): void {
    this.map.set(keyOf(file), version);
  }
  has(file: string): boolean {
    return this.map.has(keyOf(file));
  }
  forget(file: string): void {
    this.map.delete(keyOf(file));
  }
}

/** The app's one registry (main process). */
export const seenFiles = new SeenFiles();

/**
 * Read a JSON file and remember its version in `seen`: `undefined` value and a null version when
 * the file does not exist. Throws on bad JSON (the version is remembered all the same).
 */
export async function readJsonSeen(file: string, seen: SeenFiles = seenFiles): Promise<unknown> {
  const buf = await readBytesSeen(file, seen);
  return buf === null ? undefined : parseJsonText(buf.toString('utf8'));
}

/** Read a file's bytes and remember their version in `seen`; null when it does not exist. */
export async function readBytesSeen(
  file: string,
  seen: SeenFiles = seenFiles,
): Promise<Buffer | null> {
  const fh = await open(file, 'r').catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (fh === null) {
    seen.remember(file, null);
    return null;
  }
  try {
    const s = await fh.stat();
    const buf = await fh.readFile();
    seen.remember(file, { mtimeMs: s.mtimeMs, size: buf.length, hash: sha256(buf) });
    return buf;
  } finally {
    await fh.close();
  }
}

/** Remember text this process read some other way (the bytes as read, with a fresh stat). */
export async function rememberText(
  file: string,
  text: string | null,
  seen: SeenFiles = seenFiles,
): Promise<void> {
  if (text === null) {
    seen.remember(file, null);
    return;
  }
  const s = await statOf(file);
  const bytes = Buffer.from(text, 'utf8');
  seen.remember(file, s && { mtimeMs: s.mtimeMs, size: bytes.length, hash: sha256(bytes) });
}

/** Refuse with `ChangedOnDiskError` unless the file is still as `expect` says. */
async function check(file: string, expect: ExpectedVersion | undefined, name?: string) {
  if (expect === undefined) return;
  if (!(await unchanged(file, expect))) throw new ChangedOnDiskError(file, name);
}

/**
 * The e2e real-data guard's check (`realDataGuard.ts` installs it when STRATLAS_E2E=1), reached
 * through a global so this module keeps importing only node: modules (tools/compat runs it bare).
 */
function guardWrite(file: string, op: string): void {
  (
    globalThis as { __stratlasAssertWritable?: (p: string, op: string) => void }
  ).__stratlasAssertWritable?.(file, op);
}

let writes = 0;
/** A temp name next to `file`, unique per write: two writes in one millisecond stay apart. */
const tempName = (file: string) => {
  writes += 1;
  return `${file}.${String(process.pid)}.${String(Date.now())}.${String(writes)}.tmp`;
};

/**
 * Write JSON atomically: write a temp file next to the target, then rename over it, so a crash
 * never leaves a half-written file. With `backup`, the previous version is kept as `<file>.bak`,
 * itself copied to a temp file and renamed, so a crash leaves either the old or the new `.bak`
 * whole. With `expect` (from `SeenFiles.expect`, or any version), the write is refused with
 * `ChangedOnDiskError` and nothing is touched when the file is no longer that version (null: the
 * file must not exist); `undefined` writes without a check. `name` is the file's name in the
 * refusal (default: its base name). `seenFiles` keeps the version written when it knew the file.
 */
export async function writeJsonAtomic(
  file: string,
  data: unknown,
  opts: WriteOptions = {},
): Promise<void> {
  await writeJsonVersion(file, data, opts);
}

interface WriteOptions {
  backup?: boolean;
  expect?: ExpectedVersion | undefined;
  name?: string;
}

/** `writeJsonAtomic`, answering the version written. */
export async function writeJsonVersion(
  file: string,
  data: unknown,
  opts: WriteOptions = {},
): Promise<DiskVersion> {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  // under the e2e guard, never into the founder's real data (realDataGuard.ts)
  guardWrite(file, 'writeJsonAtomic');
  // refuse before anything is touched (the .bak included)
  await check(file, opts.expect, opts.name);
  if (opts.backup) {
    // the backup goes first so a kill leaves at most one temp file next to the target
    const bak = tempName(`${file}.bak`);
    try {
      await copyFile(file, bak);
      await renameOver(bak, `${file}.bak`);
    } catch (e) {
      await rm(bak, { force: true });
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const tmp = tempName(file);
  let version: DiskVersion;
  try {
    await writeFile(tmp, text, 'utf8');
    const s = await stat(tmp);
    version = { mtimeMs: s.mtimeMs, size: s.size, hash: sha256(text) };
    // and again right before the rename: the window left is the rename itself
    await check(file, opts.expect, opts.name);
    await renameOver(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  if (seenFiles.has(file)) seenFiles.remember(file, version);
  return version;
}

/**
 * `writeJsonAtomic` for a record the person edits: compare with what `seen` remembers of the file
 * (no check when it was never read here), then remember what was written.
 */
export async function writeJsonSeen(
  file: string,
  data: unknown,
  opts: { backup?: boolean; name?: string } = {},
  seen: SeenFiles = seenFiles,
): Promise<DiskVersion> {
  const version = await writeJsonVersion(file, data, { ...opts, expect: seen.expect(file) });
  seen.remember(file, version);
  return version;
}

/** True for a `ChangedOnDiskError` (also across module copies, by its code). */
export function isChangedOnDisk(e: unknown): e is ChangedOnDiskError {
  return (
    e instanceof ChangedOnDiskError ||
    (e instanceof Error && (e as { code?: unknown }).code === 'changed-on-disk')
  );
}
