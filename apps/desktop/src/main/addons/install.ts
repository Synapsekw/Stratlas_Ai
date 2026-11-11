/**
 * Installing, finding and removing add-on model packs (`addons.ts` in `@aio/schema`).
 *
 * An add-on archive (`<id>-<version>.aioaddon`, a gzipped tar) holds `addon.json` and the files it
 * lists, at its root. It is unpacked into a staging folder `<dataRoot>/runtime/addons/.install-
 * <hex>.tmp` and refused, with one sentence, for an absolute path, a `..`, a link, an entry that
 * is neither a file nor a folder, too many files or bytes, a file the manifest does not list or
 * lacks, a size or SHA-256 that does not match, and the kind's own files missing or wrong. Only
 * then does it replace `<dataRoot>/runtime/addons/<id>/` (the old folder renamed aside first, so a
 * failure leaves the old version in place).
 */
import {
  ADDON_MANIFEST_FILE,
  ADDONS_DIR,
  AddonFile,
  AddonManifest,
  type AddonInstallResult,
  type AddonKind,
  type AddonProgress,
  KNOWN_ADDONS,
  MAX_ADDON_BYTES,
  MAX_ADDON_FILES,
  PointClassifier,
} from '@aio/schema';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Parser, type ReadEntry } from 'tar';
import { parseCard } from '../inference/models';
import { licenceProblem } from '../inference/licence';
import { compareVersions } from '../jobs/pack';
import { archiveSegments, freeBytesOf, renameDir } from '../jobs/packInstall';
import { onnxExternalData } from './onnxExternal';

/** `<dataRoot>/runtime/addons`: every installed add-on, the staging folders and downloads. */
export const addonsRoot = (dataRoot: string): string => join(dataRoot, 'runtime', ADDONS_DIR);
/** The folder of an installed add-on. */
export const addonDir = (dataRoot: string, id: string): string => join(addonsRoot(dataRoot), id);
/** Where `addons:install` downloads an archive (kept as `.partial` to resume). */
export const downloadPath = (dataRoot: string, id: string, version: string): string =>
  join(addonsRoot(dataRoot), '.download', `${id}-${version}.aioaddon`);

const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Left free on the disk beyond the add-on itself. */
const SPARE_BYTES = 64 * 1024 * 1024;
const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What each kind needs among its files (beside the manifest). */
export const KIND_FILES: Record<AddonKind, readonly string[]> = {
  detector: ['model.onnx', 'model.json'],
  segmenter: ['encoder.onnx', 'decoder.onnx', 'model.json'],
  'point-classifier': ['classifier.json'],
};

const KIND_LABEL: Record<AddonKind, string> = {
  detector: 'detector',
  segmenter: 'segmentation',
  'point-classifier': 'point classifier',
};

export class AddonRefused extends Error {
  constructor(
    message: string,
    readonly code: 'refused' | 'cancelled' = 'refused',
  ) {
    super(message);
  }
}
const refused = (m: string) => new AddonRefused(m);
const CANCELLED = 'Installing the add-on was cancelled. Nothing was changed.';

const mb = (bytes: number) =>
  bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GB`
    : `${String(Math.max(1, Math.ceil(bytes / 2 ** 20)))} MB`;
const shown = (p: string) =>
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  (p.length > 120 ? `${p.slice(0, 117)}...` : p).replace(/[\u0000-\u001f]/g, '?');
const tempName = (what: string) => `.${what}-${randomBytes(6).toString('hex')}.tmp`;
/** A sentence with another one after it, without a doubled full stop. */
const sentences = (a: string, b: string) => `${a.replace(/[.\s]+$/, '')}. ${b}`;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** The manifest's first problem as one sentence, or the manifest. */
export function parseAddonManifest(
  raw: unknown,
): { ok: true; manifest: AddonManifest } | { ok: false; error: string } {
  const r = AddonManifest.safeParse(raw);
  if (r.success) return { ok: true, manifest: r.data };
  const first = r.error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')})` : '';
  return {
    ok: false,
    error: `The add-on's addon.json is not valid${where}: ${first?.message ?? 'unknown problem'}`,
  };
}

// ---------------------------------------------------------------- installed add-ons

export interface InstalledAddon {
  manifest: AddonManifest;
  dir: string;
}

/**
 * The installed add-on `id`: its manifest read back and checked again, and every listed file there
 * at its size (the SHA-256 was checked at install). `damaged` says why an add-on folder is not
 * usable; null when there is none.
 */
export async function inspectInstalledAddon(
  dataRoot: string,
  id: string,
): Promise<{ addon: InstalledAddon } | { damaged: string } | null> {
  const dir = addonDir(dataRoot, id);
  let text: string;
  try {
    text = await readFile(join(dir, ADDON_MANIFEST_FILE), 'utf8');
  } catch {
    const there = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    return there ? { damaged: 'The installed add-on has no addon.json. Install it again.' } : null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      damaged: 'The installed add-on has an addon.json that is not JSON. Install it again.',
    };
  }
  const m = parseAddonManifest(raw);
  if (!m.ok) return { damaged: sentences(m.error, 'Install it again.') };
  if (m.manifest.id !== id)
    return {
      damaged: `The installed add-on in ${id} says it is "${m.manifest.id}". Install it again.`,
    };
  for (const f of m.manifest.files) {
    const s = await stat(join(dir, ...f.path.split('/'))).catch(() => null);
    if (!s?.isFile() || s.size !== f.sizeBytes)
      return {
        damaged: `The installed add-on lacks ${f.path}, or it has changed. Install it again.`,
      };
  }
  return { addon: { manifest: m.manifest, dir } };
}

export async function readInstalledAddon(
  dataRoot: string,
  id: string,
): Promise<InstalledAddon | null> {
  const r = await inspectInstalledAddon(dataRoot, id);
  return r && 'addon' in r ? r.addon : null;
}

/** The folder names under `runtime/addons` that may hold an add-on (no staging or downloads). */
export async function addonFolders(dataRoot: string): Promise<string[]> {
  try {
    return (await readdir(addonsRoot(dataRoot), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every usable installed add-on, the known ones first. */
export async function listInstalledAddons(dataRoot: string): Promise<InstalledAddon[]> {
  const known = KNOWN_ADDONS.map((k) => k.id);
  const ids = await addonFolders(dataRoot);
  ids.sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    return (ia < 0 ? known.length : ia) - (ib < 0 ? known.length : ib) || a.localeCompare(b);
  });
  const out: InstalledAddon[] = [];
  for (const id of ids) {
    const a = await readInstalledAddon(dataRoot, id);
    if (a) out.push(a);
  }
  return out;
}

/** The installed add-on of a kind (the known one first), or null: the switch for its features. */
export async function installedAddon(
  dataRoot: string,
  kind: AddonKind,
): Promise<InstalledAddon | null> {
  return (await listInstalledAddons(dataRoot)).find((a) => a.manifest.kind === kind) ?? null;
}

/** The folders of every installed add-on of a kind. */
export async function installedAddonDirs(dataRoot: string, kind: AddonKind): Promise<string[]> {
  return (await listInstalledAddons(dataRoot))
    .filter((a) => a.manifest.kind === kind)
    .map((a) => a.dir);
}

/** The Ground classifier add-on's settings, or null when no point classifier is installed. */
export async function readPointClassifier(dataRoot: string): Promise<PointClassifier | null> {
  return (await readGroundAddon(dataRoot))?.classifier ?? null;
}

/** The installed point classifier: its settings and its manifest (`gates.ts` `GroundAddon`). */
export async function readGroundAddon(
  dataRoot: string,
): Promise<{ classifier: PointClassifier; manifest: AddonManifest } | null> {
  const a = await installedAddon(dataRoot, 'point-classifier');
  if (!a) return null;
  try {
    const r = PointClassifier.safeParse(
      JSON.parse(await readFile(join(a.dir, 'classifier.json'), 'utf8')),
    );
    return r.success ? { classifier: r.data, manifest: a.manifest } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- unpack

interface FileSum {
  size: number;
  sha256: string;
}

interface Unpacked {
  files: Map<string, FileSum>;
  manifest: Buffer | null;
  archiveSha256: string;
}

/** Unpack `archive` into the empty folder `tmp`; rejects on the first broken rule. */
async function unpack(
  archive: string,
  tmp: string,
  o: {
    signal?: AbortSignal | undefined;
    onBytes: (done: number) => void;
    /** Bytes the files may take on the disk (its free space less a margin); null: unknown. */
    budget: number | null;
  },
): Promise<Unpacked> {
  const files = new Map<string, FileSum>();
  const lower = new Set<string>();
  const writes: Promise<void>[] = [];
  const outs = new Set<WriteStream>();
  const archiveHash = createHash('sha256');
  const s = { failure: null as Error | null, manifest: null as Buffer | null };
  let fileCount = 0;
  let dirCount = 0;
  let declared = 0;
  let bytesDone = 0;

  const source = createReadStream(archive, { highWaterMark: 1 << 20 });
  const parser = new Parser({ strict: true });
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((r) => {
    stop = r;
  });
  const fail = (e: unknown) => {
    if (s.failure) return;
    s.failure = e instanceof Error ? e : new Error(String(e));
    source.destroy();
    for (const out of outs) out.destroy();
    try {
      parser.abort(new Error('stopped'));
    } catch {
      // reported through the parser's error event, which lands here again
    }
    stop();
  };

  const writeEntry = (entry: ReadEntry, dest: string, name: string) =>
    new Promise<void>((done) => {
      const hash = createHash('sha256');
      let size = 0;
      const out = createWriteStream(dest, { flags: 'wx' });
      outs.add(out);
      out.on('error', fail);
      out.on('close', () => {
        outs.delete(out);
        files.set(name, { size, sha256: hash.digest('hex') });
        done();
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
    });

  const readManifest = (entry: ReadEntry) =>
    new Promise<void>((done) => {
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        s.manifest = Buffer.concat(chunks);
        done();
      });
    });

  const handle = (entry: ReadEntry) => {
    const p = archiveSegments(entry.path, true);
    if (!p.ok)
      throw refused(`The add-on file holds ${p.why} (${shown(entry.path)}). It was not installed.`);
    const segs = p.segments;
    const name = segs.join('/');
    if (segs.some((x) => !NAME_PART.test(x)))
      throw refused(
        `The add-on file holds a name an add-on file cannot have (${shown(entry.path)}). It was not installed.`,
      );
    switch (entry.type) {
      case 'Directory':
        if (++dirCount > MAX_ADDON_FILES)
          throw refused('The add-on file holds too many folders. It was not installed.');
        mkdirSync(join(tmp, ...segs), { recursive: true });
        entry.resume();
        return;
      case 'File':
      case 'OldFile':
      case 'ContiguousFile': {
        if (lower.has(name.toLowerCase()))
          throw refused(`The add-on file holds ${shown(name)} twice. It was not installed.`);
        lower.add(name.toLowerCase());
        if (name === ADDON_MANIFEST_FILE) {
          if (entry.size > MAX_MANIFEST_BYTES)
            throw refused(
              'The add-on has an addon.json too large to be one. It was not installed.',
            );
          writes.push(readManifest(entry));
          return;
        }
        if (!AddonFile.shape.path.safeParse(name).success)
          throw refused(
            `The add-on file holds ${shown(name)}, which is not a name an add-on file can have. It was not installed.`,
          );
        if (++fileCount > MAX_ADDON_FILES)
          throw refused(
            `The add-on file holds more than ${String(MAX_ADDON_FILES)} files, which no add-on does. It was not installed.`,
          );
        declared += entry.size;
        if (declared > MAX_ADDON_BYTES)
          throw refused(
            `The add-on file unpacks to more than ${mb(MAX_ADDON_BYTES)}, which no add-on does. It was not installed.`,
          );
        if (o.budget !== null && declared > o.budget)
          throw refused(
            `The add-on unpacks to more than the ${mb(o.budget)} free on this disk. Free some space, then try again.`,
          );
        const dest = join(tmp, ...segs);
        mkdirSync(dirname(dest), { recursive: true });
        writes.push(writeEntry(entry, dest, name));
        return;
      }
      case 'SymbolicLink':
      case 'Link':
        throw refused(
          `The add-on file holds a link (${shown(entry.path)}), which an add-on never has. It was not installed.`,
        );
      default:
        throw refused(
          `The add-on file holds ${shown(entry.path)}, which is neither a file nor a folder. It was not installed.`,
        );
    }
  };

  parser.on('entry', (entry: ReadEntry) => {
    if (s.failure) {
      entry.resume();
      return;
    }
    try {
      handle(entry);
    } catch (e) {
      entry.resume();
      fail(e);
    }
  });
  parser.on('ignoredEntry', (entry: ReadEntry) => {
    fail(
      refused(
        `The add-on file holds ${shown(entry.path)}, which cannot be unpacked. It was not installed.`,
      ),
    );
  });
  parser.on('error', (e: unknown) => {
    fail(
      s.failure ??
        refused(`This is not an add-on file, or it is damaged (${why(e)}). It was not installed.`),
    );
  });
  const ended = new Promise<void>((r) => {
    parser.on('end', () => {
      r();
    });
  });
  const onAbort = () => {
    fail(new AddonRefused(CANCELLED, 'cancelled'));
  };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        if (s.failure) break;
        archiveHash.update(chunk);
        bytesDone += chunk.length;
        o.onBytes(bytesDone);
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
    await Promise.race([Promise.all(writes), stopped]);
    if (s.failure) throw s.failure;
    return { files, manifest: s.manifest, archiveSha256: archiveHash.digest('hex') };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    source.destroy();
  }
}

// ---------------------------------------------------------------- checks

/** Every listed file there with its size and SHA-256, and nothing more. */
function checkFiles(manifest: AddonManifest, files: Map<string, FileSum>): void {
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const name of files.keys()) {
    if (!listed.has(name))
      throw refused(
        `The add-on file holds ${shown(name)}, which its addon.json does not list. It was not installed.`,
      );
  }
  for (const f of manifest.files) {
    const got = files.get(f.path);
    if (!got)
      throw refused(
        `The add-on file lacks ${shown(f.path)}, which its addon.json lists. It was not installed.`,
      );
    if (got.size !== f.sizeBytes)
      throw refused(
        `${shown(f.path)} in the add-on is ${String(got.size)} bytes, its addon.json says ${String(f.sizeBytes)}. The file may be damaged or replaced. It was not installed.`,
      );
    if (got.sha256 !== f.sha256)
      throw refused(
        `${shown(f.path)} in the add-on does not match its addon.json (SHA-256). The file may be damaged or replaced. It was not installed.`,
      );
  }
}

async function readJsonIn(dir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf8'));
  } catch {
    throw refused(`${name} in the add-on is not JSON. It was not installed.`);
  }
}

/** The files a kind of add-on needs, and that they are what they say. */
async function checkKind(
  manifest: AddonManifest,
  dir: string,
  files: Map<string, FileSum>,
): Promise<void> {
  const label = KIND_LABEL[manifest.kind];
  for (const need of KIND_FILES[manifest.kind]) {
    if (!files.has(need))
      throw refused(
        `A ${label} add-on holds ${KIND_FILES[manifest.kind].join(', ')}; this one lacks ${need}. It was not installed.`,
      );
  }
  // every model runs from its own file: no tensor may name another file (ONNX external data)
  for (const f of manifest.files) {
    if (!f.path.toLowerCase().endsWith('.onnx')) continue;
    const external = await onnxExternalData(join(dir, ...f.path.split('/')));
    if (external === 'external')
      throw refused(
        `${f.path} in the add-on keeps weights in separate files (ONNX external data), which an add-on may not do. It was not installed.`,
      );
    if (external === 'not-onnx')
      throw refused(`${f.path} in the add-on is not an ONNX model. It was not installed.`);
  }
  switch (manifest.kind) {
    case 'detector': {
      const card = parseCard(await readJsonIn(dir, 'model.json'));
      if (!card.ok) throw refused(sentences(card.error, 'It was not installed.'));
      const problem = licenceProblem(card.card.licence);
      if (problem) throw refused(problem);
      if (card.card.sha256 !== files.get('model.onnx')?.sha256)
        throw refused(
          'model.onnx in the add-on does not match its model card (SHA-256). It was not installed.',
        );
      return;
    }
    case 'segmenter': {
      const raw = await readJsonIn(dir, 'model.json');
      const r = raw as { licence?: unknown; license?: unknown } | null;
      const licence = r && typeof r === 'object' ? (r.licence ?? r.license) : undefined;
      const problem = licenceProblem(typeof licence === 'string' ? licence : '');
      if (problem) throw refused(problem);
      return;
    }
    case 'point-classifier': {
      const r = PointClassifier.safeParse(await readJsonIn(dir, 'classifier.json'));
      if (!r.success) {
        const first = r.error.issues[0];
        const where = first?.path.length ? ` (${first.path.join('.')})` : '';
        throw refused(
          sentences(
            `classifier.json in the add-on is not valid${where}: ${first?.message ?? 'unknown problem'}`,
            'It was not installed.',
          ),
        );
      }
      return;
    }
  }
}

// ---------------------------------------------------------------- install, remove

export interface InstallArchiveOptions {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (p: Omit<AddonProgress, 'id'>) => void;
  /** Free bytes for `runtime/addons`; `freeBytesOf` by default. */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** The space the add-on takes once installed, when known before the unpack (the catalogue). */
  needBytes?: number;
  /** The add-on this archive must be (a catalogue download). */
  expect?: { id: string; version: string };
  /** The catalogue's archive SHA-256 of an id and version, when it lists them (Choose file). */
  catalogueSha256?: (id: string, version: string) => string | null;
  /** The add-on `id` is being written: refuse a second install of it (the IPC's own lock). */
  onId?: (id: string) => void;
  /** Why this add-on cannot be used here (its `minPipelinePack`), or null. */
  usable?: (m: AddonManifest) => string | null;
  /**
   * An archive no catalogue vouches for (Choose file, the catalogue does not list it): the
   * "carries no publisher signature" question. False refuses it and nothing is installed.
   */
  confirmUnlisted?: (m: AddonManifest) => Promise<boolean>;
}

/**
 * Put the checked folder `tmp` at `dest`: the old version aside first (`.replaced-*`), then the
 * new one in, then the old one gone. Windows may hold a just-written file for a moment, so each
 * rename is tried again (`renameDir`). A failed rollback is said, never swallowed; the next start
 * (`sweepAddons`) puts an old version left aside back.
 */
async function swapIn(root: string, tmp: string, dest: string): Promise<void> {
  const had = await stat(dest).then(
    () => true,
    () => false,
  );
  const aside = join(root, tempName('replaced'));
  if (had) {
    try {
      await renameDir(dest, aside, 3);
    } catch {
      throw refused(
        'The installed version of this add-on is in use and could not be replaced. Close what uses it (a detection or Suggest boundaries), then try again.',
      );
    }
  }
  try {
    await renameDir(tmp, dest);
  } catch (e) {
    if (had) {
      try {
        await renameDir(aside, dest);
      } catch (back) {
        throw new Error(
          `The new version could not be moved in (${why(e)}), and the old one could not be put back (${why(back)}). It stays in ${aside} and comes back when the app starts again.`,
          { cause: back },
        );
      }
    }
    throw e;
  }
  if (had) await removeDir(aside).catch(() => undefined);
}

const removeDir = (dir: string) =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/**
 * Tidy `runtime/addons` when the app starts: staging and removal folders an interrupted install
 * or removal left go; an old version left aside (`.replaced-*`) comes back when its add-on folder
 * is missing, else it goes; downloads (`.download/<id>-<version>.aioaddon[.partial]`) of a version
 * that is installed, older than one installed, or older than another download of that add-on go.
 * Answers what it did, for the log.
 */
export async function sweepAddons(dataRoot: string): Promise<string[]> {
  const root = addonsRoot(dataRoot);
  const done: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return done;
  }
  for (const name of names.sort()) {
    const full = join(root, name);
    if (/^\.(install|removing)-[0-9a-f]+\.tmp$/.test(name)) {
      await removeDir(full).catch(() => undefined);
      done.push(`removed ${name}`);
    } else if (/^\.replaced-[0-9a-f]+\.tmp$/.test(name)) {
      let id: string | null;
      try {
        const m = parseAddonManifest(
          JSON.parse(await readFile(join(full, ADDON_MANIFEST_FILE), 'utf8')),
        );
        id = m.ok ? m.manifest.id : null;
      } catch {
        id = null;
      }
      const dest = id ? addonDir(dataRoot, id) : null;
      const missing =
        dest !== null &&
        (await stat(dest).then(
          () => false,
          () => true,
        ));
      if (dest && missing) {
        try {
          await renameDir(full, dest);
          done.push(`restored ${id ?? ''} from ${name}`);
          continue;
        } catch {
          // left for the next start
          continue;
        }
      }
      await removeDir(full).catch(() => undefined);
      done.push(`removed ${name}`);
    }
  }
  const downloads = join(root, '.download');
  let files: string[];
  try {
    files = await readdir(downloads);
  } catch {
    return done;
  }
  const parsed = files
    .map((f) => ({ f, m: /^([a-z0-9][a-z0-9-]*?)-(\d+\.\d+\.\d+)\.aioaddon(\.partial)?$/.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null);
  const newest = new Map<string, string>();
  for (const { m } of parsed) {
    const [, id = '', v = ''] = m;
    const had = newest.get(id);
    if (!had || compareVersions(v, had) > 0) newest.set(id, v);
  }
  for (const { f, m } of parsed) {
    const [, id = '', v = ''] = m;
    const installed = (await readInstalledAddon(dataRoot, id))?.manifest.version;
    const stale =
      v !== newest.get(id) || (installed !== undefined && compareVersions(v, installed) <= 0);
    if (stale) {
      await rm(join(downloads, f), { force: true }).catch(() => undefined);
      done.push(`removed .download/${f}`);
    }
  }
  return done;
}

/** Unpack, check and install an add-on archive; the old version stays until the new one is in. */
export async function installAddonArchive(
  archive: string,
  o: InstallArchiveOptions,
): Promise<AddonInstallResult> {
  const root = addonsRoot(o.dataRoot);
  const tmp = join(root, tempName('install'));
  const fail = (e: unknown): AddonInstallResult => {
    if (e instanceof AddonRefused) return { ok: false, error: e.message, code: e.code };
    return { ok: false, error: `The add-on could not be installed: ${why(e)}` };
  };
  try {
    const size = (await stat(archive).catch(() => null))?.size;
    if (size === undefined)
      return { ok: false, error: `${archive} does not exist.`, code: 'refused' };
    const need = (o.needBytes ?? size) + SPARE_BYTES;
    mkdirSync(root, { recursive: true });
    const free = await (o.freeBytes ?? freeBytesOf)(root);
    if (free !== null && free < need)
      return {
        ok: false,
        code: 'refused',
        error: `The add-on needs ${mb(need)} free in ${root}; there is ${mb(free)}. Free some space, then try again.`,
      };
    mkdirSync(tmp);
    o.onProgress?.({ phase: 'unpack', bytesDone: 0, bytesTotal: size });
    const u = await unpack(archive, tmp, {
      signal: o.signal,
      onBytes: (done) => o.onProgress?.({ phase: 'unpack', bytesDone: done, bytesTotal: size }),
      budget: free === null ? null : Math.max(0, free - SPARE_BYTES),
    });
    o.onProgress?.({ phase: 'check', bytesDone: size, bytesTotal: size });
    if (!u.manifest)
      throw refused('This is not an add-on file: it holds no addon.json. It was not installed.');
    let raw: unknown;
    try {
      raw = JSON.parse(u.manifest.toString('utf8'));
    } catch {
      throw refused("The add-on's addon.json is not JSON. It was not installed.");
    }
    const parsed = parseAddonManifest(raw);
    if (!parsed.ok) throw refused(sentences(parsed.error, 'It was not installed.'));
    const m = parsed.manifest;
    if (o.expect && (o.expect.id !== m.id || o.expect.version !== m.version))
      throw refused(
        `The downloaded file is ${m.id} ${m.version}, not ${o.expect.id} ${o.expect.version} as the catalogue says. It was not installed.`,
      );
    const listedSha = o.catalogueSha256?.(m.id, m.version) ?? null;
    if (listedSha !== null && listedSha !== u.archiveSha256)
      throw refused(
        `This file is not the ${m.name} ${m.version} the add-on catalogue lists (SHA-256). It may be damaged or replaced. It was not installed.`,
      );
    checkFiles(m, u.files);
    await checkKind(m, tmp, u.files);
    const unusable = o.usable?.(m) ?? null;
    if (unusable) throw refused(sentences(unusable, 'The add-on was not installed.'));
    if (listedSha === null && o.confirmUnlisted && !(await o.confirmUnlisted(m)))
      throw refused(
        `${m.name} ${m.version} was not installed: the add-on list does not vouch for this file, and installing it was not confirmed.`,
      );
    // the manifest as it was checked, so the installed add-on says what it holds
    await writeFile(join(tmp, ADDON_MANIFEST_FILE), u.manifest, { flag: 'wx' });
    if (o.signal?.aborted) throw new AddonRefused(CANCELLED, 'cancelled');
    o.onId?.(m.id);
    await swapIn(root, tmp, addonDir(o.dataRoot, m.id));
    o.onProgress?.({ phase: 'done', bytesDone: size, bytesTotal: size });
    return { ok: true, manifest: m };
  } catch (e) {
    return fail(e);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove an installed add-on: renamed aside first, so a half-deleted folder is never used. */
export async function removeAddon(
  dataRoot: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = addonDir(dataRoot, id);
  const there = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!there) return { ok: false, error: `The add-on "${id}" is not installed.` };
  const aside = join(addonsRoot(dataRoot), tempName('removing'));
  try {
    await renameDir(dir, aside, 3);
  } catch (e) {
    return {
      ok: false,
      error: `The add-on could not be removed (a program may be using it): ${why(e)}`,
    };
  }
  await removeDir(aside).catch(() => undefined);
  return { ok: true };
}
