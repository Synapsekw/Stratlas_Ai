import { clearManagedSelection } from '../update/managedKits';
/**
 * Install and look after pipeline packs from inside the app (Settings, Processing tools).
 *
 * A pack reaches a computer as `pipeline-pack-<version>-<platform>.tar.gz` (built by
 * tools/pipeline-pack/build.mjs, archived in CI) beside the installer. `installPackArchive`
 * unpacks it into a temporary folder inside `<data folder>/runtime/` (same volume), checks it, and
 * only then renames it to `pipeline-pack-<version>`, so `findPack` never sees half a pack:
 *
 * - every entry path is checked before anything is written: no absolute path, no `..`, one
 *   `pipeline-pack-<version>` folder at the top, nothing written through a link, links only when
 *   they resolve inside the pack, no devices or pipes, a cap on entries and on unpacked bytes;
 * - the manifest must parse (`PipelinePackManifest`), name this computer's platform, include this
 *   app in its `appRange` (`packRangeRefusal`), and its Python must be there;
 * - every file the manifest lists must be there with its size and SHA-256 (hashed while it is
 *   written), which catches a damaged or cut-short archive;
 * - with a publisher key pinned in brand.json (`signing.pipelinePackKey`), `manifest.sig` must be a
 *   valid Ed25519 signature of `manifest.json` and every file must be one the manifest lists, so a
 *   forged pack is refused too. Without a key the pack is unsigned code: the person installing it
 *   from Settings confirms that in a main-side dialog (`confirmUnsigned`) before it is activated.
 *
 * A failure or a cancel removes the temporary folder and leaves `runtime` as it was. No network.
 *
 * The same installer takes the Analytics pack (`analytics-pack-<version>`, `ANALYTICS_PACK`):
 * a `PackKind` carries the folder prefix, the manifest, the file that must be there and the words
 * of its messages. Without a kind everything is the pipeline pack's, exactly as before.
 */
import {
  ANALYTICS_PACK_PREFIX,
  AnalyticsPackManifest,
  PIPELINES,
  PipelinePackManifest,
  packRangeRefusal,
  type InstalledPack,
  type IpcResponse,
  type PackArchive,
  type PackInstallProgress,
  type PipelinePackStatus,
} from '@aio/schema';
import { createHash, randomBytes } from 'node:crypto';
import { ed25519Valid } from '../ed25519';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { Parser, type ReadEntry } from 'tar';
import type { Handler } from '../ipc';
import { isWithin } from '../realDataGuard';
import { readJson } from '../fsutil';
import { compareVersions, findPack, PACK_DIR, readPack, type PackApp } from './pack';

// ---------------------------------------------------------------- limits and names

export interface PackLimits {
  /** Most entries an archive may hold (pack 0.5.0 has about 14,000). */
  maxEntries: number;
  /** Most bytes it may unpack to (the pack budget is 1,150 MB). */
  maxBytes: number;
  /** Largest manifest.json read back (pack 0.5.0's is about 2 MB). */
  maxManifestBytes: number;
}

export const PACK_LIMITS: PackLimits = {
  maxEntries: 250_000,
  maxBytes: 6 * 2 ** 30,
  maxManifestBytes: 64 * 2 ** 20,
};

/** The parts of a pack manifest the installer reads, whatever the kind. */
export interface PackManifestCore {
  version: string;
  platform: string;
  appRange?: string | undefined;
  files: Record<string, { size: number; sha256: string }>;
}

/**
 * One kind of pack the installer handles: the pipeline pack (the processing tools) or the
 * Analytics pack (llama-server and the vision model). Everything the installer says and checks
 * that differs between the two lives here.
 */
export interface PackKind {
  id: 'pipeline' | 'analytics';
  prefix: 'pipeline-pack' | 'analytics-pack';
  /** Words for messages: 'processing tools' | 'Analytics pack'. */
  label: string;
  /** The same words at the start of a sentence. */
  title: string;
  /** Whether `label` takes a plural verb ("the processing tools are"). */
  plural: boolean;
  /** The manifest's schema, named when a manifest cannot be read. */
  schema: string;
  /** What `required` names, for the person: 'Python' | 'llama-server'. */
  requiredName: string;
  /** A pack folder in `<data folder>/runtime/`: `<prefix>-<version>`. */
  dir: RegExp;
  parse(raw: unknown): { ok: true; m: PackManifestCore } | { ok: false; error: string };
  /** A file that must exist after unpacking (python executable | llama-server executable). */
  required(m: unknown): string;
  /** Does a manifest's `platform` name this computer (`win32-x64`)? */
  fitsPlatform(manifestPlatform: string, platform: string): boolean;
  /** Why this app may not use a pack with this `appRange`, or null. */
  rangeRefusal(appRange: string | undefined, app: PackApp): string | null;
  limits: PackLimits;
  /**
   * The archive is mostly incompressible (a model): a gzip trailer smaller than the archive has
   * wrapped at 4 GiB, so the unpacked size is the smallest `stated + n * 4 GiB` that is at least
   * the archive's size. Without it, such a trailer falls back to three times the archive.
   */
  trailerWraps?: true;
  /**
   * A tag in this kind's temporary folder names in `runtime/` (`.install-<tag>-<hex>.tmp`), so
   * each kind's cleanup of a killed install touches only its own folders and two kinds can
   * install at once. The pipeline pack has none: its names stay `.install-<hex>.tmp`, and since
   * a tag holds letters that are not hex digits the pipeline pattern never matches a tagged name.
   */
  tempTag?: string;
}

/** The pipeline pack, exactly as the installer has always handled it. */
export const PIPELINE_PACK: PackKind = {
  id: 'pipeline',
  prefix: 'pipeline-pack',
  label: 'processing tools',
  title: 'Processing tools',
  plural: true,
  schema: 'aio.pipeline-pack/1',
  requiredName: 'Python',
  dir: PACK_DIR,
  parse: (raw) => {
    const r = PipelinePackManifest.safeParse(raw);
    return r.success ? { ok: true, m: r.data } : { ok: false, error: r.error.message };
  },
  required: (m) => (m as PipelinePackManifest).python.executable,
  fitsPlatform: (manifestPlatform, platform) => manifestPlatform === platform,
  rangeRefusal: (appRange, app) => packRangeRefusal(appRange, app.version, app.name),
  limits: PACK_LIMITS,
};

/** Files up to this size are read whole before they are written. */
const SMALL_FILE = 2 ** 20;
/** How many of them are written at once (at most this many megabytes wait in memory). */
const WRITES_AT_ONCE = 16;

/** A version that is safe as part of a folder name. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
/** This kind's temporary folders in `runtime/`: `.install-[<tag>-]<hex>.tmp` and `.replaced-…`. */
const TEMP_DIR = /^\.(install|replaced)-[0-9a-f]+\.tmp$/;
const tempDirOf = (kind: PackKind) =>
  kind.tempTag
    ? new RegExp(String.raw`^\.(install|replaced)-${kind.tempTag}-[0-9a-f]+\.tmp$`)
    : TEMP_DIR;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** How CI and people name a pack archive for each platform a pack is built for. */
const ARCHIVE_LABELS: Readonly<Record<string, readonly string[]>> = {
  'win32-x64': ['win-x64', 'win32-x64', 'windows-x64'],
  'darwin-arm64': ['macos-arm64', 'darwin-arm64', 'mac-arm64'],
  'darwin-x64': ['macos-x64', 'darwin-x64', 'mac-x64'],
};

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  'win32-x64': 'Windows (x64)',
  'win32-arm64': 'Windows (Arm)',
  'darwin-arm64': 'a Mac with Apple silicon',
  'darwin-x64': 'an Intel Mac',
  'linux-x64': 'Linux (x64)',
};
const platformName = (p: string) => PLATFORM_NAMES[p] ?? p;

/**
 * The Analytics pack (tools/analytics-pack/build.mjs): llama-server and a vision model of about
 * 5 GB in a few dozen files. Its manifest names the platform as the archive name does (`win-x64`).
 */
export const ANALYTICS_PACK: PackKind = {
  id: 'analytics',
  prefix: ANALYTICS_PACK_PREFIX,
  label: 'Analytics pack',
  title: 'Analytics pack',
  plural: false,
  schema: 'aio.analytics-pack/1',
  requiredName: 'llama-server',
  dir: new RegExp(`^${ANALYTICS_PACK_PREFIX}-(.+)$`),
  parse: (raw) => {
    const r = AnalyticsPackManifest.safeParse(raw);
    return r.success ? { ok: true, m: r.data } : { ok: false, error: r.error.message };
  },
  required: (m) => (m as AnalyticsPackManifest).runtime.executable,
  fitsPlatform: (manifestPlatform, platform) =>
    manifestPlatform === platform ||
    (ARCHIVE_LABELS[platform] ?? []).includes(manifestPlatform.toLowerCase()),
  rangeRefusal: (appRange, app) =>
    packRangeRefusal(appRange, app.version, app.name)?.replaceAll(
      'pipeline pack',
      'Analytics pack',
    ) ?? null,
  limits: { maxEntries: 10_000, maxBytes: 12 * 2 ** 30, maxManifestBytes: 4 * 2 ** 20 },
  trailerWraps: true,
  tempTag: 'analytics',
};

/** "a" or "an" before `word`. */
const an = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
/** The verbs that go with a kind's `label`. */
const be = (k: PackKind) => (k.plural ? 'are' : 'is');
const was = (k: PackKind) => (k.plural ? 'were' : 'was');
const verb = (k: PackKind, plural: string) => (k.plural ? plural : `${plural}s`);

const mb = (bytes: number) =>
  bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GB`
    : `${String(Math.ceil(bytes / 2 ** 20))} MB`;

/** A name from the archive, short enough and plain enough to show. */
const shown = (p: string) =>
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  (p.length > 120 ? `${p.slice(0, 117)}...` : p).replace(/[\u0000-\u001f]/g, '?');

/**
 * The version in a pack archive's file name when the name is for `platform`
 * (`pipeline-pack-0.5.0-win-x64.tar.gz`, a browser's ` (1)` copy included), else null.
 */
export function packArchiveName(
  name: string,
  platform: string,
  kind: PackKind = PIPELINE_PACK,
): { version: string } | null {
  const m = new RegExp(
    `^${kind.prefix}-(.+?)-([a-z0-9]+-[a-z0-9]+)(?: \\(\\d+\\))?\\.(?:tar\\.gz|tgz)$`,
    'i',
  ).exec(name);
  const version = m?.[1];
  const label = m?.[2]?.toLowerCase();
  if (version === undefined || label === undefined || !VERSION.test(version)) return null;
  return (ARCHIVE_LABELS[platform] ?? [platform]).includes(label) ? { version } : null;
}

// ---------------------------------------------------------------- refusals

type RefusalCode = 'exists' | 'cancelled' | 'busy';

/** Why a pack was not installed, in words for the person. Nothing was changed. */
export class PackRefused extends Error {
  readonly code: RefusalCode | undefined;
  readonly version: string | undefined;
  constructor(message: string, code?: RefusalCode, version?: string) {
    super(message);
    this.name = 'PackRefused';
    this.code = code;
    this.version = version;
  }
}

const refused = (message: string) => new PackRefused(message);
const cancelled = (k: PackKind) =>
  new PackRefused(`Installing the ${k.label} was cancelled. Nothing was changed.`, 'cancelled');

/** The answer for a failed install: the refusal's own words, or a sentence for a system error. */
export function installProblem(
  e: unknown,
  k: PackKind = PIPELINE_PACK,
): {
  error: string;
  code?: RefusalCode;
  version?: string;
} {
  if (e instanceof PackRefused) {
    return {
      error: e.message,
      ...(e.code ? { code: e.code } : {}),
      ...(e.version !== undefined ? { version: e.version } : {}),
    };
  }
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (err.name === 'RealDataWriteRefusedError') return { error: err.message };
  if (code === 'EEXIST') {
    return { error: 'The archive holds the same file or link twice. It was not installed.' };
  }
  if (code === 'ENOSPC') {
    return {
      error: `The disk filled up while the ${k.label} ${was(k)} being unpacked. Free some space and try again. Nothing was changed.`,
    };
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return {
      error: `The ${k.label} could not be written into the data folder (${err.message}). Check that the folder can be written to. Nothing was changed.`,
    };
  }
  if (
    'tarCode' in err ||
    code.startsWith('Z_') ||
    /zlib|unexpected end of file/i.test(err.message)
  ) {
    return {
      error: `This is not a complete ${k.label} file: it is damaged or was cut short. Copy or download it again. Nothing was changed.`,
    };
  }
  return {
    error: `The ${k.label} could not be installed: ${err.message} Nothing was changed.`,
  };
}

// ---------------------------------------------------------------- archive paths

/**
 * The folder and file names of a path from the archive, or why it is refused: an absolute path
 * (also a drive letter or a UNC path), a `..`, a control character, and on Windows the names it
 * cannot hold (reserved devices, `:` streams, a trailing dot or space that it would strip).
 * A backslash counts as a separator everywhere, so `..\..` cannot slip through.
 */
export function archiveSegments(
  raw: string,
  win32: boolean = process.platform === 'win32',
): { ok: true; segments: string[] } | { ok: false; why: string } {
  if (raw.length === 0) return { ok: false, why: 'an entry without a name' };
  if (raw.length > 4096) return { ok: false, why: 'a path that is too long' };
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { ok: false, why: 'an absolute path' };
  const segments: string[] = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') return { ok: false, why: 'a path that climbs out of the pack with ".."' };
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    if (/[\u0000-\u001f]/.test(s) || s.length > 255) {
      return { ok: false, why: 'a name a file cannot have' };
    }
    if (win32 && (/[<>:"|?*]/.test(s) || /[. ]$/.test(s) || WIN_RESERVED.test(s))) {
      return { ok: false, why: 'a name Windows cannot hold' };
    }
    segments.push(s);
  }
  if (segments.length === 0) return { ok: false, why: 'an entry without a name' };
  return { ok: true, segments };
}

/** Does a symbolic link at `rel` (inside the pack) to `linkpath` stay inside the pack, by name? */
export function linkStaysInside(rel: readonly string[], linkpath: string): boolean {
  const l = linkpath.replace(/\\/g, '/');
  if (l === '' || l.includes('\0') || l.startsWith('/') || /^[A-Za-z]:/.test(l)) return false;
  const to = posix.normalize(posix.join(rel.slice(0, -1).join('/') || '.', l));
  return to !== '..' && !to.startsWith('../');
}

// ---------------------------------------------------------------- unpack

interface FileSum {
  size: number;
  sha256: string;
}

interface Unpacked {
  /** The archive's one top folder, `pipeline-pack-<version>`. */
  top: string;
  /** Regular files written, by their path inside the pack (`/` separated). */
  files: Map<string, FileSum>;
  /** Symbolic links created, absolute. */
  links: string[];
  entries: number;
}

interface UnpackOptions {
  kind: PackKind;
  limits: PackLimits;
  win32: boolean;
  signal: AbortSignal | undefined;
  /** The first entry named the pack's folder: the place to refuse a version that is installed. */
  onTop: (top: string) => Promise<void>;
  onProgress: (bytesDone: number, entries: number) => void;
  makeLink: (target: string, path: string) => Promise<void>;
}

/**
 * Unpack `archive` (a tar, gzipped or not) into the empty folder `tmp`, without its top folder.
 * Rejects on the first entry that breaks a rule, on a damaged archive and on a cancel; the caller
 * removes `tmp`.
 */
async function unpack(archive: string, tmp: string, o: UnpackOptions): Promise<Unpacked> {
  const files = new Map<string, FileSum>();
  const links: string[] = [];
  const realDirs = new Set<string>([tmp]);
  // one object, so a value set inside a callback is read back with its declared type
  const s = {
    top: null as string | null,
    failure: null as Error | null,
    /** Lets go of the file entry being written, so a failure never waits for its end. */
    release: null as (() => void) | null,
  };
  let entries = 0;
  let declared = 0;
  let bytesDone = 0;

  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((r) => {
    stop = r;
  });
  const source = createReadStream(archive, { highWaterMark: 1 << 20 });
  // strict: a bad header checksum or a cut-short entry is an error, not a warning
  const parser = new Parser({ strict: true });

  const fail = (e: unknown) => {
    if (s.failure) return;
    s.failure = e instanceof Error ? e : new Error(String(e));
    source.destroy();
    s.release?.();
    try {
      // its own error object: the parser marks the one it is given as a tar error
      parser.abort(new Error('stopped'));
    } catch {
      // the parser reports the abort through its error event, which lands here again
    }
    stop();
  };

  /** Make the folders of `segs` under `tmp`; never through a link or over a file. */
  const ensureDir = async (segs: readonly string[]) => {
    let dir = tmp;
    for (const s of segs) {
      dir = join(dir, s);
      if (realDirs.has(dir)) continue;
      const st = await lstat(dir).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      });
      if (st === null) await mkdir(dir);
      else if (!st.isDirectory()) {
        throw refused(
          `The archive writes through ${shown(segs.join('/'))}, which is a link or a file, not a folder. It was not installed.`,
        );
      }
      realDirs.add(dir);
    }
  };

  // keep the executable bits (bin/python3 on macOS); always readable and writable by the owner
  const modeOf = (entry: ReadEntry) =>
    o.win32 ? {} : { mode: ((entry.mode ?? 0o644) & 0o777) | 0o600 };

  /** A large file entry: streamed to disk and hashed on the way. */
  const writeLarge = (entry: ReadEntry, dest: string) =>
    new Promise<FileSum>((done, reject) => {
      const hash = createHash('sha256');
      let size = 0;
      let err: Error | null = null;
      const out = createWriteStream(dest, { flags: 'wx', ...modeOf(entry) });
      s.release = () => {
        out.destroy();
      };
      out.on('error', (e) => {
        err ??= e;
      });
      out.on('close', () => {
        s.release = null;
        const why = err ?? s.failure;
        if (why) reject(why);
        else done({ size, sha256: hash.digest('hex') });
      });
      entry.on('data', (c: Buffer) => {
        if (out.destroyed) return;
        hash.update(c);
        size += c.length;
        if (!out.write(c)) {
          entry.pause();
          out.once('drain', () => {
            entry.resume();
          });
        }
      });
      entry.on('end', () => {
        out.end();
      });
      entry.resume();
    });

  /**
   * Small files (most of a pack's 14,000) are read whole and written a few at a time: a virus
   * scanner looks at every new file as it is closed, which costs tens of milliseconds a file one
   * after the other and almost nothing side by side (5 minutes against 20 seconds for a pack).
   */
  const writing = new Set<Promise<void>>();
  const settled = async () => {
    await Promise.all(writing);
  };
  const writeSmall = async (entry: ReadEntry, dest: string, name: string): Promise<void> => {
    const data = await new Promise<Buffer>((done, reject) => {
      const chunks: Buffer[] = [];
      s.release = () => {
        reject(s.failure ?? new Error('stopped'));
      };
      entry.on('data', (c: Buffer) => {
        chunks.push(c);
      });
      entry.on('end', () => {
        s.release = null;
        done(Buffer.concat(chunks));
      });
      entry.resume();
    });
    while (writing.size >= WRITES_AT_ONCE) await Promise.race(writing);
    if (s.failure) throw s.failure;
    const sum = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    // 'wx': never over something that is there, also when two entries name one file
    const write: Promise<void> = writeFile(dest, data, { flag: 'wx', ...modeOf(entry) })
      .then(() => {
        files.set(name, sum);
      }, fail)
      .finally(() => writing.delete(write));
    writing.add(write);
  };

  const count = (bytes: number) => {
    declared += bytes;
    if (declared > o.limits.maxBytes) {
      throw refused(
        `The archive unpacks to more than ${mb(o.limits.maxBytes)}, which no ${o.kind.label} file does. It was not installed.`,
      );
    }
  };

  const handle = async (entry: ReadEntry) => {
    entries += 1;
    if (entries > o.limits.maxEntries) {
      throw refused(
        `The archive holds more than ${o.limits.maxEntries.toLocaleString('en-US')} entries, which no ${o.kind.label} file does. It was not installed.`,
      );
    }
    const path = archiveSegments(entry.path, o.win32);
    if (!path.ok) {
      throw refused(`The archive holds ${path.why} (${shown(entry.path)}). It was not installed.`);
    }
    const [first = '', ...rel] = path.segments;
    if (s.top === null) {
      const version = o.kind.dir.exec(first)?.[1];
      if (version === undefined || !VERSION.test(version)) {
        const { label, prefix } = o.kind;
        throw refused(
          `This archive is not ${an(label)} ${label} file: it starts with ${shown(first)}, not ${an(prefix)} ${prefix}-<version> folder.`,
        );
      }
      s.top = first;
      await o.onTop(first);
    } else if (first !== s.top) {
      throw refused(
        `The archive holds ${shown(first)} beside ${s.top}; the ${o.kind.label} ${verb(o.kind, 'come')} as one folder. It was not installed.`,
      );
    }
    const dest = join(tmp, ...rel);
    const name = rel.join('/');
    switch (entry.type) {
      case 'Directory':
        await ensureDir(rel);
        entry.resume();
        return;
      case 'File':
      case 'OldFile':
      case 'ContiguousFile': {
        if (rel.length === 0) throw refused(`The archive holds ${first} as a file, not a folder.`);
        count(entry.size);
        await ensureDir(rel.slice(0, -1));
        if (entry.size > SMALL_FILE) files.set(name, await writeLarge(entry, dest));
        else await writeSmall(entry, dest, name);
        return;
      }
      case 'SymbolicLink': {
        const to = entry.linkpath ?? '';
        if (rel.length === 0 || !linkStaysInside(rel, to)) {
          throw refused(
            `The archive holds a link that leads out of the pack (${shown(entry.path)} to ${shown(to)}). It was not installed.`,
          );
        }
        await ensureDir(rel.slice(0, -1));
        await settled();
        try {
          await o.makeLink(to, dest);
        } catch (e) {
          // Windows lets only an administrator, or anyone with Developer Mode on, make links
          if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
          throw refused(
            `This file holds links (${shown(entry.path)}), and this computer may not create links in the data folder. On Windows that takes Developer Mode or an administrator. It was not installed.`,
          );
        }
        links.push(dest);
        entry.resume();
        return;
      }
      case 'Link': {
        // a hard link names another file of the archive by its whole path: written as a copy
        const to = archiveSegments(entry.linkpath ?? '', o.win32);
        const [toTop, ...toRel] = to.ok ? to.segments : [];
        await settled();
        const original = files.get(toRel.join('/'));
        if (rel.length === 0 || toTop !== first || original === undefined) {
          throw refused(
            `The archive holds a link that leads out of the pack (${shown(entry.path)} to ${shown(entry.linkpath ?? '')}). It was not installed.`,
          );
        }
        count(original.size);
        await ensureDir(rel.slice(0, -1));
        await copyFile(join(tmp, ...toRel), dest, constants.COPYFILE_EXCL);
        files.set(name, original);
        entry.resume();
        return;
      }
      default:
        throw refused(
          `The archive holds ${shown(entry.path)}, which is neither a file, a folder nor a link. It was not installed.`,
        );
    }
  };

  // The parser hands out one entry at a time: the next one comes when this one has been read.
  let chain: Promise<void> = Promise.resolve();
  parser.on('entry', (entry: ReadEntry) => {
    chain = chain
      .then(() => {
        if (s.failure) {
          entry.resume();
          return undefined;
        }
        return handle(entry);
      })
      .catch(fail);
  });
  // an entry type the parser does not know, or a path header too large to be a path
  parser.on('ignoredEntry', (entry: ReadEntry) => {
    fail(
      refused(
        `The archive holds ${shown(entry.path)}, which cannot be unpacked. It was not installed.`,
      ),
    );
  });
  parser.on('error', fail);
  const ended = new Promise<void>((r) => {
    parser.on('end', () => {
      r();
    });
  });
  const onAbort = () => {
    fail(cancelled(o.kind));
  };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        if (s.failure) break;
        bytesDone += chunk.length;
        o.onProgress(bytesDone, entries);
        if (!parser.write(chunk)) {
          await Promise.race([
            new Promise<void>((r) => {
              parser.once('drain', () => {
                r();
              });
            }),
            stopped,
          ]);
        }
      }
    } catch (e) {
      fail(e);
    }
    if (!s.failure) {
      parser.end();
      await Promise.race([ended, stopped]);
    }
    await chain;
    await settled();
    if (s.failure) throw s.failure;
    if (s.top === null) {
      const { label, prefix } = o.kind;
      throw refused(
        `This is not ${an(label)} ${label} file: it holds no ${prefix}-<version> folder.`,
      );
    }
    return { top: s.top, files, links, entries };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    source.destroy();
  }
}

// ---------------------------------------------------------------- check and activate

/** Check what `unpack` wrote into `tmp` before it may become a pack `findPack` can pick. */
async function checkUnpacked(
  tmp: string,
  u: Unpacked,
  o: { kind: PackKind; app: PackApp; platform: string; limits: PackLimits; win32: boolean },
): Promise<PackManifestCore> {
  const k = o.kind;
  const listed = u.files.get('manifest.json');
  if (!listed) {
    throw refused(
      `This archive is not ${an(k.label)} ${k.label} file: it has no manifest.json. It was not installed.`,
    );
  }
  let raw: unknown;
  try {
    if (listed.size > o.limits.maxManifestBytes) throw new Error('too large');
    const text = await readFile(join(tmp, 'manifest.json'), 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    throw refused("This file's manifest.json cannot be read. It was not installed.");
  }
  const parsed = k.parse(raw);
  if (!parsed.ok) {
    throw refused(
      `This file's manifest.json is not one this app can read (${k.schema}). It was not installed.`,
    );
  }
  const m = parsed.m;
  if (!VERSION.test(m.version) || u.top !== `${k.prefix}-${m.version}`) {
    throw refused(
      `This file's folder (${shown(u.top)}) and its manifest (version ${shown(m.version)}) disagree. It was not installed.`,
    );
  }
  if (!k.fitsPlatform(m.platform, o.platform)) {
    throw refused(
      `${k.plural ? 'These' : 'This'} ${k.label} ${be(k)} for ${platformName(m.platform)}, and this computer is ${platformName(o.platform)}. Pick the file made for this computer.`,
    );
  }
  const range = k.rangeRefusal(m.appRange, o.app);
  if (range) throw refused(range);

  // links may only lead to something inside the pack, wherever their chain ends
  const root = await realpath(tmp);
  for (const link of u.links) {
    const to = await realpath(link).catch(() => null);
    if (to === null || !isWithin(root, to)) {
      throw refused(
        `This file holds a link that does not lead to a file inside it (${shown(link.slice(tmp.length + 1))}). It was not installed.`,
      );
    }
  }

  const required = k.required(m);
  const exe = archiveSegments(required, o.win32);
  const found = exe.ok ? await stat(join(tmp, ...exe.segments)).catch(() => null) : null;
  if (!found?.isFile()) {
    throw refused(
      `This file has no ${k.requiredName} at ${shown(required)}: it is incomplete. It was not installed.`,
    );
  }

  for (const [name, want] of Object.entries(m.files)) {
    const got = u.files.get(name);
    if (!got) {
      throw refused(
        `This file is incomplete: ${shown(name)} is missing. Copy or download it again.`,
      );
    }
    if (got.size !== want.size || got.sha256 !== want.sha256) {
      throw refused(
        `This file is damaged: ${shown(name)} does not match its checksum. Copy or download it again.`,
      );
    }
  }
  return m;
}

/** The detached signature of `manifest.json` in a signed pack. */
export const PACK_SIGNATURE = 'manifest.sig';

/**
 * A signed pack: `manifest.sig` is a valid Ed25519 signature of the exact `manifest.json` bytes
 * under the pinned key, and the archive holds no file the manifest does not list (an extra file,
 * a `.pth` or `sitecustomize.py`, would run with the pack's Python).
 */
async function checkSignature(
  tmp: string,
  u: Unpacked,
  m: PackManifestCore,
  packKey: string,
  k: PackKind,
): Promise<void> {
  const sig = u.files.get(PACK_SIGNATURE);
  if (!sig || sig.size > 4096) {
    throw refused(`This ${k.label} file is not signed by the publisher. It was not installed.`);
  }
  const [manifest, signature] = await Promise.all([
    readFile(join(tmp, 'manifest.json')),
    readFile(join(tmp, PACK_SIGNATURE), 'utf8'),
  ]);
  const valid = ed25519Valid(manifest, signature, packKey);
  if (valid === null) throw refused('The pinned pack key is not a valid Ed25519 public key.');
  if (!valid) {
    throw refused(
      `This ${k.label} file's signature does not match: it was changed or not signed by the publisher. It was not installed.`,
    );
  }
  for (const name of u.files.keys()) {
    if (name === 'manifest.json' || name === PACK_SIGNATURE) continue;
    if (!Object.hasOwn(m.files, name)) {
      throw refused(
        `This file holds ${shown(name)}, which its signed manifest does not list. It was not installed.`,
      );
    }
  }
}

const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/**
 * Rename a folder. Right after thousands of files were written into it, Windows (antivirus, the
 * search indexer) may hold one open for a moment and refuse, so a refusal is tried again for a
 * few seconds.
 */
async function renameDir(from: string, to: string, tries = 8): Promise<void> {
  for (let i = 0, wait = 50; ; i++, wait *= 2) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !LOCKED.has(code) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const removeDir = (dir: string) =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const tempName = (what: 'install' | 'replaced', kind: PackKind) =>
  `.${what}-${kind.tempTag ? `${kind.tempTag}-` : ''}${randomBytes(6).toString('hex')}.tmp`;

/** Free bytes on the volume of `dir` (of its nearest folder that exists); null when unknown. */
export async function freeBytesOf(dir: string): Promise<number | null> {
  for (let p = dir; ;) {
    try {
      const s = await statfs(p);
      return s.bavail * s.bsize;
    } catch (e) {
      const up = dirname(p);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || up === p) return null;
      p = up;
    }
  }
}

/**
 * About how large an archive of `size` bytes is unpacked, from the size its gzip trailer states
 * (modulo 4 GiB; null for a plain tar, which is its own size). A stated size below the archive's
 * falls back to three times the archive (pipeline pack 0.5.0 unpacks to 2.8 times its archive),
 * unless the kind's trailer wraps (`PackKind.trailerWraps`).
 */
export function estimateUnpacked(
  size: number,
  stated: number | null,
  kind: PackKind = PIPELINE_PACK,
): number {
  if (stated === null) return size;
  if (stated >= size) return stated;
  return kind.trailerWraps ? stated + Math.ceil((size - stated) / 2 ** 32) * 2 ** 32 : size * 3;
}

/** The free bytes an install of `need` unpacked bytes asks for: `need` and a margin. */
export const spaceNeeded = (need: number): number => need + Math.max(64 * 2 ** 20, need * 0.02);

/** `estimateUnpacked` for the archive file at `archive`. */
async function unpackedEstimate(archive: string, size: number, kind: PackKind): Promise<number> {
  if (size < 18) return size;
  const fh = await open(archive, 'r');
  try {
    const head = Buffer.alloc(2);
    const tail = Buffer.alloc(4);
    await fh.read(head, 0, 2, 0);
    await fh.read(tail, 0, 4, size - 4);
    const gz = head[0] === 0x1f && head[1] === 0x8b;
    return estimateUnpacked(size, gz ? tail.readUInt32LE(0) : null, kind);
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- install

export interface InstallOptions {
  dataRoot: string;
  /** This app: a pack whose `appRange` leaves it out is refused. */
  app: PackApp;
  /** This computer as a manifest names it (`win32-x64`). */
  platform: string;
  /** Replace an installed pack of the same version (the person said yes). */
  replace?: boolean;
  signal?: AbortSignal;
  /** Optional exclusive activation lease, acquired after extraction and verification; always released. */
  beforeActivate?: () => Promise<() => void>;
  onProgress?: (p: PackInstallProgress) => void;
  /** Free bytes for `<data folder>/runtime` (tests); `freeBytesOf` by default. */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** The e2e real-data guard (`assertWritable` of realDataGuard.ts): throws to refuse the folder. */
  assertWritable?: (path: string, op: string) => void;
  limits?: Partial<PackLimits>;
  /** Apply the Windows file name rules (tests); this computer's by default. */
  win32?: boolean;
  /** Least time between two progress reports of one phase, 150 ms by default. */
  progressEveryMs?: number;
  /**
   * The publisher's Ed25519 public key (brand.json `signing.pipelinePackKey`, base64). Set, the
   * pack must carry a valid `manifest.sig` and nothing its manifest does not list.
   */
  packKey?: string | undefined;
  /**
   * Without `packKey`: asked, after every check and before activation, whether to install the
   * unsigned pack of `version`; false refuses it. Not given, an unsigned pack installs as before.
   */
  confirmUnsigned?: (version: string) => Promise<boolean>;
  /**
   * Make the symbolic link an archive entry asks for (tests: a junction where Windows allows no
   * links, or a link that is not what its name says); `fs.symlink` by default. Whatever it makes
   * is checked like any link: it must really lead to something inside the pack.
   */
  makeLink?: (target: string, path: string) => Promise<void>;
  /** Which pack the archive must be; the pipeline pack by default. */
  kind?: PackKind;
}

export type InstallResult =
  | { ok: true; version: string; dir: string; replaced: boolean }
  | { ok: false; error: string; code?: RefusalCode; version?: string };

/**
 * Install the pack archive at `archive` into `<data folder>/runtime/<prefix>-<version>`
 * (`pipeline-pack-<version>` unless `o.kind` names another kind).
 * See the top of this file for the rules. Never throws: a failure is an answer, and it leaves
 * `runtime` as it was.
 */
export async function installPackArchive(
  archive: string,
  o: InstallOptions,
): Promise<InstallResult> {
  const kind = o.kind ?? PIPELINE_PACK;
  const runtimeDir = join(o.dataRoot, 'runtime');
  const limits = { ...kind.limits, ...o.limits };
  const win32 = o.win32 ?? process.platform === 'win32';
  const last: PackInstallProgress = { phase: 'unpack', bytesDone: 0, bytesTotal: 0, entries: 0 };
  let sentAt = 0;
  const report = (patch: Partial<PackInstallProgress>, now = false) => {
    Object.assign(last, patch);
    const t = Date.now();
    if (!now && t - sentAt < (o.progressEveryMs ?? 150)) return;
    sentAt = t;
    o.onProgress?.({ ...last });
  };
  let tmp: string | null = null;
  let releaseActivation: (() => void) | undefined;
  try {
    o.assertWritable?.(runtimeDir, `${kind.id} pack install`);
    const st = await stat(archive).catch(() => null);
    if (!st?.isFile()) throw refused(`${archive} is not a file that can be read.`);
    if (o.signal?.aborted) throw cancelled(kind);
    report({ bytesTotal: st.size }, true);

    const need = await unpackedEstimate(archive, st.size, kind);
    const free = await (o.freeBytes ?? freeBytesOf)(runtimeDir);
    if (free !== null && free < spaceNeeded(need)) {
      throw refused(
        `Not enough free disk space: the ${kind.label} ${verb(kind, 'need')} about ${mb(spaceNeeded(need))} in ${runtimeDir}, and ${mb(free)} is free. Free some space and try again.`,
      );
    }

    await mkdir(runtimeDir, { recursive: true });
    // what an install of this kind that was killed left behind (one install of a kind runs at a
    // time; the other kind's folders may belong to an install that is running now)
    const tempDir = tempDirOf(kind);
    for (const n of await readdir(runtimeDir)) {
      if (tempDir.test(n)) await removeDir(join(runtimeDir, n)).catch(() => undefined);
    }
    tmp = join(runtimeDir, tempName('install', kind));
    await mkdir(tmp);

    const existing = async (top: string) =>
      (await lstat(join(runtimeDir, top)).catch(() => null)) !== null;
    const unpacked = await unpack(archive, tmp, {
      kind,
      limits,
      win32,
      signal: o.signal,
      makeLink: o.makeLink ?? ((target, path) => symlink(target, path)),
      onTop: async (top) => {
        if (o.replace !== true && (await existing(top))) {
          const version = kind.dir.exec(top)?.[1] ?? '';
          throw new PackRefused(
            `${kind.title} ${version} ${be(kind)} already installed.`,
            'exists',
            version,
          );
        }
      },
      onProgress: (bytesDone, entries) => {
        report({ bytesDone, entries });
      },
    });

    report({ phase: 'check', bytesDone: st.size, entries: unpacked.entries }, true);
    const manifest = await checkUnpacked(tmp, unpacked, {
      kind,
      app: o.app,
      platform: o.platform,
      limits,
      win32,
    });
    if (o.signal?.aborted) throw cancelled(kind);
    if (o.packKey) await checkSignature(tmp, unpacked, manifest, o.packKey, kind);
    else if (o.confirmUnsigned && !(await o.confirmUnsigned(manifest.version))) {
      throw new PackRefused(
        `${kind.title} ${manifest.version} ${was(kind)} not installed: ${kind.plural ? 'they are' : 'it is'} not signed by the publisher.`,
        'cancelled',
      );
    }
    if (o.signal?.aborted) throw cancelled(kind);

    releaseActivation = await o.beforeActivate?.();
    if (o.signal?.aborted) throw cancelled(kind);
    report({ phase: 'activate' }, true);
    const dest = join(runtimeDir, unpacked.top);
    const replaced = await existing(unpacked.top);
    if (replaced && o.replace !== true) {
      throw new PackRefused(
        `${kind.title} ${manifest.version} ${be(kind)} already installed.`,
        'exists',
        manifest.version,
      );
    }
    let aside: string | null = null;
    if (replaced) {
      aside = join(runtimeDir, tempName('replaced', kind));
      try {
        await renameDir(dest, aside, 3);
      } catch {
        throw refused(
          `${kind.title} ${manifest.version} ${be(kind)} in use and could not be replaced. Wait for running jobs to finish, then try again.`,
        );
      }
    }
    try {
      await renameDir(tmp, dest);
    } catch (e) {
      if (aside) await rename(aside, dest).catch(() => undefined);
      throw e;
    }
    tmp = null;
    if (aside) await removeDir(aside).catch(() => undefined);
    report({ phase: 'done' }, true);
    return { ok: true, version: manifest.version, dir: dest, replaced };
  } catch (e) {
    const problem = installProblem(e, kind);
    report({ phase: problem.code === 'cancelled' ? 'cancelled' : 'failed' }, true);
    return { ok: false, ...problem };
  } finally {
    releaseActivation?.();
    if (tmp) await removeDir(tmp).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- what is installed

/** Bytes of the files under `dir` (links are not followed); stops counting after `cap` entries. */
async function folderBytes(dir: string, cap = 300_000): Promise<number> {
  let bytes = 0;
  let seen = 0;
  const todo = [dir];
  for (let d = todo.pop(); d !== undefined && seen < cap; d = todo.pop()) {
    const list = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of list) {
      seen += 1;
      const p = join(d, e.name);
      if (e.isDirectory()) todo.push(p);
      else if (e.isFile()) bytes += (await lstat(p).catch(() => null))?.size ?? 0;
    }
  }
  return bytes;
}

/**
 * Read one installed pack folder of `kind`: its manifest must parse and its required file must be
 * there; null otherwise. The pipeline pack is read by `readPack`, as it always was.
 */
export async function readKindPack(
  dir: string,
  kind: PackKind,
): Promise<{ version: string; manifest?: PackManifestCore } | null> {
  if (kind.id === 'pipeline') {
    const pack = await readPack(dir);
    return pack && !('refused' in pack) ? pack : null;
  }
  const parsed = kind.parse(await readJson(join(dir, 'manifest.json')).catch(() => null));
  if (!parsed.ok) return null;
  const exe = archiveSegments(kind.required(parsed.m), false);
  const st = exe.ok ? await stat(join(dir, ...exe.segments)).catch(() => null) : null;
  return st?.isFile() ? { version: parsed.m.version, manifest: parsed.m } : null;
}

/** Every `<prefix>-<version>` folder of `kind` in `<data folder>/runtime/`, newest first. */
export async function listPacks(
  dataRoot: string,
  kind: PackKind = PIPELINE_PACK,
): Promise<InstalledPack[]> {
  const runtimeDir = join(dataRoot, 'runtime');
  const names = await readdir(runtimeDir, { withFileTypes: true }).catch(() => []);
  const out: InstalledPack[] = [];
  for (const e of names) {
    const named = kind.dir.exec(e.name)?.[1];
    if (named === undefined || !e.isDirectory()) continue;
    const dir = join(runtimeDir, e.name);
    const read = await readKindPack(dir, kind);
    const listed = Object.values(read?.manifest?.files ?? {});
    out.push({
      name: e.name,
      version: read?.version ?? named,
      dir,
      // the manifest lists every file with its size; a folder without one is measured
      bytes: listed.length > 0 ? listed.reduce((n, f) => n + f.size, 0) : await folderBytes(dir),
      valid: read !== null,
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** Something this app does that needs a pack of at least `minVersion` (`PHOTO_PACK`). */
export interface PackFeature {
  label: string;
  minVersion: string;
}

/**
 * What the pack in use lacks for this app, a sentence each: a feature whose first pack is newer,
 * and the pipelines this app can start (`PIPELINES`) that the pack's manifest does not list.
 */
export function packNeeds(
  version: string,
  manifest: PipelinePackManifest | undefined,
  features: readonly PackFeature[],
): string[] {
  const needs: string[] = [];
  if (version !== 'dev') {
    for (const f of features) {
      if (compareVersions(version, f.minVersion) < 0) {
        needs.push(`${f.label} needs version ${f.minVersion} or later.`);
      }
    }
  }
  if (manifest) {
    const have = new Set(manifest.pipelines.map((p) => p.name));
    const missing = PIPELINES.filter((p) => !have.has(p.name));
    const [a, b] = missing;
    if (a && !b) needs.push(`This version cannot run "${a.title}".`);
    else if (a && b) {
      needs.push(
        `This version cannot run ${String(missing.length)} kinds of job this app has, for example "${a.title}" and "${b.title}".`,
      );
    }
  }
  return needs;
}

export interface StatusOptions {
  dataRoot: string;
  env: Record<string, string | undefined>;
  app: PackApp;
  platform: string;
  features: readonly PackFeature[];
  installing?: boolean;
  notify?: boolean;
}

/** The pack as Settings, Processing tools and the start notice show it. */
export async function packStatus(o: StatusOptions): Promise<PipelinePackStatus> {
  const runtimeDir = join(o.dataRoot, 'runtime');
  const base = {
    runtimeDir,
    platform: o.platform,
    installing: o.installing === true,
    notify: o.notify !== false,
  };
  const { pack, runtime } = await findPack({ dataRoot: o.dataRoot, env: o.env, app: o.app });
  const packs = await listPacks(o.dataRoot);
  // a development interpreter or one pack folder named by the environment: not ours to manage
  if (o.env.QUADRION_PIPELINE_PYTHON || o.env.QUADRION_PIPELINE_PACK) {
    return {
      ...base,
      state: pack ? 'dev' : 'missing',
      ...(pack ? { version: pack.version, dir: pack.dir } : {}),
      ...(runtime.problem ? { problem: runtime.problem } : {}),
      needs: [],
      others: packs,
    };
  }
  if (!pack) {
    return {
      ...base,
      // packs are there and complete, but none is made for this app version
      state: packs.some((p) => p.valid) ? 'incompatible' : 'missing',
      ...(runtime.problem ? { problem: runtime.problem } : {}),
      needs: [],
      others: packs,
    };
  }
  const inUse = packs.find((p) => p.dir === pack.dir);
  const needs = packNeeds(pack.version, pack.manifest, o.features);
  return {
    ...base,
    state: needs.length > 0 ? 'too-old' : 'ok',
    version: pack.version,
    dir: pack.dir,
    ...(inUse ? { bytes: inUse.bytes } : {}),
    needs,
    others: packs.filter((p) => p.dir !== pack.dir),
  };
}

// ---------------------------------------------------------------- finding an archive

/** A place to look for pack archives: only the files directly in `dir` are read by name. */
export interface ArchivePlace {
  dir: string;
  where: PackArchive['where'];
}

/**
 * Where a pack archive is most likely to be, besides `<data folder>/runtime`: the folder the app
 * runs from and the one above it (a portable copy, an unpacked build), the folder a portable exe
 * was started in, the folder that holds a macOS app bundle, and last the Downloads folder.
 */
export function packArchivePlaces(o: {
  exe: string;
  portableDir?: string | undefined;
  downloads: string;
}): ArchivePlace[] {
  const exeDir = dirname(o.exe);
  const bundle = /^(.*)[\\/][^\\/]+\.app[\\/]Contents[\\/]MacOS$/.exec(exeDir)?.[1];
  const app = [o.portableDir, exeDir, dirname(exeDir), bundle].filter(
    (d): d is string => typeof d === 'string' && d !== '',
  );
  return [
    ...[...new Set(app)].map((dir) => ({ dir, where: 'app' as const })),
    { dir: o.downloads, where: 'downloads' as const },
  ];
}

/**
 * Read the manifest from the start of a pack archive without unpacking it: at most the first
 * `maxBytes` of the file and `maxEntries` entries. Null when it is not among them (the archive
 * may still be fine) or the file cannot be read.
 */
export async function peekPackManifest(
  archive: string,
  o: { maxBytes?: number; maxEntries?: number; maxManifestBytes?: number } = {},
  kind: PackKind = PIPELINE_PACK,
): Promise<unknown> {
  const maxBytes = o.maxBytes ?? 8 * 2 ** 20;
  const maxEntries = o.maxEntries ?? 32;
  const maxManifest = o.maxManifestBytes ?? 16 * 2 ** 20;
  return new Promise<unknown>((done) => {
    let settled = false;
    let seen = 0;
    const source = createReadStream(archive, { end: maxBytes - 1 });
    const parser = new Parser();
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      done(value);
    };
    parser.on('entry', (entry: ReadEntry) => {
      seen += 1;
      const p = archiveSegments(entry.path, false);
      const isManifest =
        p.ok &&
        p.segments.length === 2 &&
        kind.dir.test(p.segments[0] ?? '') &&
        p.segments[1] === 'manifest.json' &&
        entry.type === 'File' &&
        entry.size <= maxManifest;
      if (!isManifest) {
        if (seen >= maxEntries) finish(null);
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          finish(null);
        }
      });
      entry.resume();
    });
    // only the start of the file is read, so the parser always sees it cut short
    parser.on('error', () => {
      finish(null);
    });
    parser.on('end', () => {
      finish(null);
    });
    source.on('error', () => {
      finish(null);
    });
    source.on('data', (c) => {
      if (!settled) parser.write(c as Buffer);
    });
    source.on('end', () => {
      if (settled) return;
      try {
        parser.end();
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Pack archives for this computer in `places`, newest version first: file names only
 * (`packArchiveName`), then the manifest at the start of the few newest ones, which drops an
 * archive made for another platform or another app version. Nothing below the folders is read.
 */
export async function findPackArchives(o: {
  places: readonly ArchivePlace[];
  platform: string;
  app: PackApp;
  /** How many of the newest candidates have their manifest read. */
  check?: number;
  /** Which pack to look for; the pipeline pack by default. */
  kind?: PackKind;
}): Promise<PackArchive[]> {
  const kind = o.kind ?? PIPELINE_PACK;
  const found: (PackArchive & { mtimeMs: number })[] = [];
  const seen = new Set<string>();
  for (const place of o.places) {
    const names = await readdir(place.dir).catch(() => []);
    for (const name of names) {
      const named = packArchiveName(name, o.platform, kind);
      if (!named) continue;
      const path = join(place.dir, name);
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      const st = seen.has(key) ? null : await stat(path).catch(() => null);
      if (!st?.isFile() || st.size === 0) continue;
      seen.add(key);
      found.push({
        path,
        version: named.version,
        where: place.where,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version) || b.mtimeMs - a.mtimeMs);
  const out: PackArchive[] = [];
  let checked = 0;
  for (const c of found) {
    if (checked < (o.check ?? 3)) {
      checked += 1;
      const m = kind.parse(await peekPackManifest(c.path, {}, kind));
      if (m.ok) {
        const fits =
          m.m.version === c.version &&
          kind.fitsPlatform(m.m.platform, o.platform) &&
          kind.rangeRefusal(m.m.appRange, o.app) === null;
        if (!fits) continue;
      }
    }
    out.push({ path: c.path, version: c.version, where: c.where, bytes: c.bytes });
  }
  return out;
}

/** The archive worth offering: the newest one found that is newer than the pack in use. */
export function packOffer(
  status: Pick<PipelinePackStatus, 'state' | 'version'>,
  archives: readonly PackArchive[],
): PackArchive | null {
  if (status.state === 'dev') return null;
  const newest = archives[0];
  if (!newest) return null;
  const current = status.state === 'ok' || status.state === 'too-old' ? status.version : undefined;
  return current === undefined || compareVersions(newest.version, current) > 0 ? newest : null;
}

// ---------------------------------------------------------------- IPC

type Channel =
  | 'pipelinePack:status'
  | 'pipelinePack:find'
  | 'pipelinePack:choose'
  | 'pipelinePack:install'
  | 'pipelinePack:cancel'
  | 'pipelinePack:remove'
  // the Analytics pack's (analytics/packIpc.ts): one set of deps serves both
  | 'analyticsPack:status'
  | 'analyticsPack:find'
  | 'analyticsPack:choose'
  | 'analyticsPack:install'
  | 'analyticsPack:cancel'
  | 'analyticsPack:remove';

export interface PipelinePackIpcDeps {
  handle: <C extends Channel>(channel: C, handler: Handler<C>) => void;
  dataRoot: () => string;
  env: Record<string, string | undefined>;
  app: PackApp;
  platform: string;
  features: readonly PackFeature[];
  /** Where to look for archives besides `<data folder>/runtime`: beside the app, Downloads. */
  places: () => ArchivePlace[];
  /** The native file dialog, opened in `startDir`; null when the person closed it. */
  chooseFile: (startDir: string | null) => Promise<string | null>;
  /** Move a folder to the Recycle Bin or Trash. */
  trash: (dir: string) => Promise<void>;
  emit: (p: PackInstallProgress) => void;
  assertWritable?: (path: string, op: string) => void;
  freeBytes?: (dir: string) => Promise<number | null>;
  /** brand.json `signing.pipelinePackKey`: set, only signed packs install. */
  packKey?: string | undefined;
  /** Without a key: the main-side "this is unsigned code" question (`InstallOptions`). */
  confirmUnsigned?: (version: string) => Promise<boolean>;
}

/** Whether the start notice may show: not in an automated run, unless QUADRION_PACK_NOTICE=1. */
export function packNoticeAllowed(env: Record<string, string | undefined>): boolean {
  if (env.QUADRION_PACK_NOTICE === '1') return true;
  return env.QUADRION_PACK_NOTICE !== '0' && env.QUADRION_E2E !== '1';
}

/** A path as the install allowlist compares it (Windows paths ignore case). */
const pathKey = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

export function registerPipelinePackIpc(d: PipelinePackIpcDeps): void {
  let running: AbortController | null = null;
  /**
   * The archives main itself named (found in the known places, or picked in its own dialog): an
   * install request must name one of them, never a path the renderer made up.
   */
  const named = new Set<string>();
  const remember = (p: string | null | undefined) => {
    if (p) named.add(pathKey(p));
  };
  const status = () =>
    packStatus({
      dataRoot: d.dataRoot(),
      env: d.env,
      app: d.app,
      platform: d.platform,
      features: d.features,
      installing: running !== null,
      notify: packNoticeAllowed(d.env),
    });
  const places = (): ArchivePlace[] => [
    ...d.places(),
    { dir: join(d.dataRoot(), 'runtime'), where: 'runtime' },
  ];
  const find = async (): Promise<IpcResponse<'pipelinePack:find'>> => {
    const [s, archives] = await Promise.all([
      status(),
      findPackArchives({ places: places(), platform: d.platform, app: d.app }),
    ]);
    const offer = packOffer(s, archives);
    remember(offer?.path);
    const newest = archives[0];
    return {
      offer,
      startDir: newest ? dirname(newest.path) : (d.places().at(-1)?.dir ?? null),
    };
  };

  d.handle('pipelinePack:status', status);
  d.handle('pipelinePack:find', find);
  d.handle('pipelinePack:choose', async () => {
    const path = await d.chooseFile((await find()).startDir);
    remember(path);
    return { path };
  });
  d.handle('pipelinePack:install', async ({ path, replace }) => {
    if (!named.has(pathKey(path))) {
      return {
        ok: false,
        error: 'Choose the processing tools file with Install from a file.',
      };
    }
    if (running) {
      return {
        ok: false,
        error: 'The processing tools are being installed already.',
        code: 'busy',
      };
    }
    running = new AbortController();
    const installRoot = d.dataRoot();
    try {
      const r = await installPackArchive(path, {
        dataRoot: installRoot,
        app: d.app,
        platform: d.platform,
        ...(replace === true ? { replace } : {}),
        signal: running.signal,
        onProgress: d.emit,
        ...(d.assertWritable ? { assertWritable: d.assertWritable } : {}),
        ...(d.freeBytes ? { freeBytes: d.freeBytes } : {}),
        ...(d.packKey ? { packKey: d.packKey } : {}),
        ...(d.confirmUnsigned ? { confirmUnsigned: d.confirmUnsigned } : {}),
      });
      running = null;
      if (!r.ok) return r;
      await clearManagedSelection(installRoot, d.app.version);
      return { ok: true, version: r.version, status: await status() };
    } finally {
      running = null;
    }
  });
  d.handle('pipelinePack:cancel', () => {
    running?.abort();
    return { ok: running !== null };
  });
  d.handle('pipelinePack:remove', async ({ name }) => {
    const s = await status();
    const pack = s.others.find((p) => p.name === name);
    if (!pack) {
      return {
        ok: false,
        error:
          s.dir !== undefined && s.dir === join(s.runtimeDir, name)
            ? 'This version is the one in use. Install a newer one first.'
            : `There is no ${name} in ${s.runtimeDir}.`,
      };
    }
    try {
      d.assertWritable?.(pack.dir, 'pipeline pack remove');
      // a real folder of runtime, never what a link there points at
      if (!(await lstat(pack.dir)).isDirectory()) throw new Error('it is not a folder');
      await d.trash(pack.dir);
    } catch (e) {
      return {
        ok: false,
        error: `${name} could not be moved to the bin: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true, status: await status() };
  });
}
