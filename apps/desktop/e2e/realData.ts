/**
 * The one gate to the founder's real client data for the e2e suite.
 *
 * The real data root is QUADRION_REAL_DATA_ROOT, else `E:\Stratlas Data` (the founder's
 * workstation). This file is the only e2e file that may name it (`src/e2eRealData.test.ts`
 * fails otherwise). A spec reads from it only through the helpers below, and the app is only ever
 * launched on a temporary COPY of a real project:
 *
 * - `copyRealProjects(ids)` copies `projects/<id>/` (and named map packs) into a fresh temp data
 *   root; `dispose()` deletes it. Files of 1 MB or more that the app only reads (photos, models,
 *   clouds, videos, tiles) are hard-linked instead of copied when the temp folder is on the same
 *   drive as the real data (set QUADRION_E2E_COPY_DIR to such a folder for fast copies); records
 *   the app writes (JSON, journal, CSV, text) are always real copies. Under the app's e2e guard a
 *   write in place to a hard-linked file is refused (`src/main/realDataGuard.ts`).
 * - `realProject(...)` and `realDataTest(...)` in fixtures.ts copy, launch the app on the copy and
 *   delete the copy afterwards. `launchApp` refuses a data root under the real data root.
 * - `realDataPath(...)` names a file in the real data for reading only (an input to copy or to
 *   import), never as the app's data root.
 *
 * Every test that uses real data carries `@realdata` in its title (`REALDATA`), so a run without
 * it is `playwright test --grep-invert @realdata`. With no real data on the machine (CI, or
 * QUADRION_REAL_DATA_ROOT set to an empty folder) those tests skip.
 */
import { envVar } from '@aio/brand/env';
import { existsSync, statSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { DataRoot } from './fixtures';

/** The tag every real-data test carries in its title (describe or test). */
export const REALDATA = '@realdata';

/** QUADRION_<name> (else the legacy STRATLAS_<name>), unless unset or empty. */
const fromEnv = (name: string): string | undefined => {
  const v = envVar(process.env, name);
  return v === undefined || v === '' ? undefined : v;
};

/** The founder's real data root. Read-only for tests. */
export const REAL_DATA_ROOT = resolve(fromEnv('REAL_DATA_ROOT') ?? 'E:\\Stratlas Data');

/** A path inside the real data root, for reading only. */
export function realDataPath(...segments: string[]): string {
  return join(REAL_DATA_ROOT, ...segments);
}

/** Does the real data hold this file or folder? */
export function hasRealData(...segments: string[]): boolean {
  return existsSync(realDataPath(...segments));
}

/** A real project's folder, for reading only (`projects/<id>`). */
export function realProjectDir(id: string): string {
  return realDataPath('projects', id);
}

/** Is the real project on this machine (its manifest.json)? */
export function hasRealProject(id: string): boolean {
  return hasRealData('projects', id, 'manifest.json');
}

/** The skip reason for a missing real project. */
export function missingRealProject(id: string): string {
  return `real project ${id} not found under ${REAL_DATA_ROOT} (QUADRION_REAL_DATA_ROOT)`;
}

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** The founder's folder stays off limits also when QUADRION_REAL_DATA_ROOT names another. */
const PROTECTED =
  process.platform === 'win32' ? [REAL_DATA_ROOT, resolve('E:\\Stratlas Data')] : [REAL_DATA_ROOT];

/** Is `p` the real data root (or the founder's folder) or inside it? */
export function isUnderRealData(p: string): boolean {
  const q = fold(resolve(p));
  return PROTECTED.some((root) => {
    const r = fold(root);
    return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/** Throw unless `p` is outside the real data root. */
export function assertNotRealData(p: string, what: string): void {
  if (isUnderRealData(p))
    throw new Error(
      `${what} ${p} is inside the real data root ${REAL_DATA_ROOT}: e2e tests run on a copy (realData.ts)`,
    );
}

/** Records the app may write: always copied, never linked. */
const RECORDS = new Set([
  '.json',
  '.jsonl',
  '.ndjson',
  '.geojson',
  '.csv',
  '.txt',
  '.md',
  '.xml',
  '.html',
  '.yaml',
  '.yml',
  '.bak',
  '.tmp',
  '.log',
]);
/** Files from this size on are linked when they can be. */
const LINK_FROM = 1024 * 1024;

/** May this file be hard-linked into a copy instead of copied? */
export function linkable(name: string, size: number): boolean {
  return size >= LINK_FROM && !RECORDS.has(extname(name).toLowerCase());
}

/**
 * An `include` for `copyRealProjects` that keeps only these files (paths relative to the project,
 * `/`-separated) and the folders on the way to them.
 */
export function onlyPaths(paths: Iterable<string>): (rel: string) => boolean {
  const keep = new Set<string>();
  for (const p of paths) {
    const parts = p.replace(/\\/g, '/').split('/');
    for (let i = 1; i <= parts.length; i++) keep.add(parts.slice(0, i).join('/'));
  }
  return (rel) => keep.has(rel);
}

/** Where copies go: QUADRION_E2E_COPY_DIR, else the system temp folder. */
function copyParent(): string {
  return fromEnv('E2E_COPY_DIR') ?? tmpdir();
}

/** How a copy was made, for the test log. */
export interface CopyStats {
  copied: number;
  linked: number;
  bytes: number;
}

/**
 * Copy the tree `src` to `dst`, keeping what `include(rel)` keeps (`rel` relative to `src`, with
 * `/`). Large read-only files are hard-linked when `links` (falling back to a copy).
 */
async function copyTree(
  src: string,
  dst: string,
  include: (rel: string) => boolean,
  stats: CopyStats,
  links: { ok: boolean },
  rel = '',
): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (!include(r)) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    const s = statSync(from);
    if (s.isDirectory()) {
      await copyTree(from, to, include, stats, links, r);
      continue;
    }
    if (s.isFile()) await copyOrLink(from, to, s.size, stats, links);
  }
}

/** Copy one file, or hard-link it when it is large, read-only and `links.ok`. */
async function copyOrLink(
  from: string,
  to: string,
  size: number,
  stats: CopyStats,
  links: { ok: boolean },
): Promise<void> {
  if (links.ok && linkable(from, size)) {
    try {
      await link(from, to);
      stats.linked += 1;
      return;
    } catch {
      // another drive, or a file system without links: copy from now on
      links.ok = false;
    }
  }
  await copyFile(from, to);
  stats.copied += 1;
  stats.bytes += size;
}

export interface RealCopyOptions {
  /** Map packs to copy too (`packs/<name>.pmtiles` and `.json`), when present. */
  packs?: string[];
  /**
   * Keep a file or folder of a project: `rel` is relative to the project folder, `/`-separated.
   * Default: everything.
   */
  include?: (rel: string, id: string) => boolean;
  /** Rewrite a project's manifest.json in the copy. */
  manifest?: (manifest: Record<string, unknown>, id: string) => Record<string, unknown>;
  /** Folder name of a project in the copy, when not its id. */
  rename?: Record<string, string>;
  /** Prefix of the temp folder (default `aio-real-`). */
  prefix?: string;
  /** Hard-link large read-only files (default true). */
  link?: boolean;
}

/** A temp data root holding copies of real projects. */
export interface RealDataCopy extends DataRoot {
  /** The copy of a project (`<root>/projects/<folder>`). */
  projectDirOf(id: string): string;
  stats: CopyStats;
  /** Delete the temp folder (the real data is never touched). */
  dispose(): Promise<void>;
}

/**
 * A temp data root with copies of the real projects `ids` that exist here (missing ones are left
 * out; skip on `hasRealProject` first), plus `opts.packs`. `projectId` / `projectDir` name the
 * first project. The real data is only read.
 */
export async function copyRealProjects(
  ids: readonly string[],
  opts: RealCopyOptions = {},
): Promise<RealDataCopy> {
  const parent = copyParent();
  assertNotRealData(parent, 'QUADRION_E2E_COPY_DIR');
  const base = await mkdtemp(join(parent, opts.prefix ?? 'aio-real-'));
  const root = join(base, 'data');
  const userData = join(base, 'user');
  await mkdir(join(root, 'packs'), { recursive: true });
  await mkdir(join(root, 'projects'), { recursive: true });
  await mkdir(userData, { recursive: true });
  const stats: CopyStats = { copied: 0, linked: 0, bytes: 0 };
  const links = { ok: opts.link ?? true };
  const folder = (id: string) => opts.rename?.[id] ?? id;
  try {
    for (const pack of opts.packs ?? []) {
      for (const ext of ['.pmtiles', '.json']) {
        const from = realDataPath('packs', pack + ext);
        if (existsSync(from))
          await copyOrLink(
            from,
            join(root, 'packs', pack + ext),
            statSync(from).size,
            stats,
            links,
          );
      }
    }
    for (const id of ids) {
      if (!hasRealProject(id)) continue;
      const dst = join(root, 'projects', folder(id));
      await copyTree(realProjectDir(id), dst, (r) => opts.include?.(r, id) ?? true, stats, links);
      if (opts.manifest) {
        const file = join(dst, 'manifest.json');
        const m = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        await writeFile(file, JSON.stringify(opts.manifest(m, id), null, 2));
      }
    }
  } catch (e) {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw e;
  }
  const first = ids[0] ?? '';
  return {
    base,
    root,
    userData,
    projectId: first ? folder(first) : '',
    projectDir: first ? join(root, 'projects', folder(first)) : '',
    projectDirOf: (id) => join(root, 'projects', folder(id)),
    stats,
    dispose: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

/**
 * Copy one file or folder of the real data (`rel` segments under the root) to `dest`, linking
 * large read-only files like `copyRealProjects`. False when the real data does not have it.
 */
export async function copyRealData(
  rel: readonly string[],
  dest: string,
  opts: { link?: boolean; include?: (rel: string) => boolean } = {},
): Promise<boolean> {
  assertNotRealData(dest, 'copy destination');
  const from = realDataPath(...rel);
  if (!existsSync(from)) return false;
  const stats: CopyStats = { copied: 0, linked: 0, bytes: 0 };
  const links = { ok: opts.link ?? true };
  const s = statSync(from);
  if (s.isDirectory()) await copyTree(from, dest, opts.include ?? (() => true), stats, links);
  else {
    await mkdir(dirname(dest), { recursive: true });
    await copyOrLink(from, dest, s.size, stats, links);
  }
  return true;
}
