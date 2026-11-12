/**
 * Index files on disk: build or update one from its project folder, and prune the ones whose
 * folder is gone. Both run where the caller likes; main runs them in a worker thread, so reading,
 * extracting and the SQLite writes never hold up the app.
 */
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractFacts } from './extract';
import { readProjectSources, type ProjectSources } from './sources';
import { openFactIndex, type FactIndex, type SyncResult } from './store';

/** What one build or update did, and how long each phase took. */
export interface FolderSync extends SyncResult {
  facts: number;
  links: number;
  ms: { read: number; extract: number; sync: number };
}

/** The index file and its WAL and shared-memory companions. */
export const indexFiles = (file: string): string[] => [file, `${file}-wal`, `${file}-shm`];

export async function removeIndex(file: string): Promise<void> {
  for (const f of indexFiles(file)) await rm(f, { force: true });
}

/** Open an index file; one that is not a database (damaged) is deleted and made again. */
export async function openOrReset(file: string): Promise<FactIndex> {
  try {
    return openFactIndex(file);
  } catch {
    await removeIndex(file);
    return openFactIndex(file);
  }
}

export interface FolderSyncOptions {
  /** Delete the file first (Rebuild). */
  fresh?: boolean;
  /** Test hook: the sources reader. */
  read?: (root: string) => Promise<ProjectSources>;
}

/** Bring the index file of a folder up to date with it (a full build when the file is new). */
export async function syncFolder(
  root: string,
  file: string,
  opts: FolderSyncOptions = {},
): Promise<FolderSync> {
  if (opts.fresh) await removeIndex(file);
  const t0 = performance.now();
  const sources = await (opts.read ?? readProjectSources)(root);
  const t1 = performance.now();
  const next = extractFacts(sources);
  const t2 = performance.now();
  const ix = await openOrReset(file);
  try {
    const r = ix.sync(next);
    ix.setRoot(root);
    const t3 = performance.now();
    return {
      ...r,
      facts: next.facts.length,
      links: next.links.length,
      ms: {
        read: Math.round(t1 - t0),
        extract: Math.round(t2 - t1),
        sync: Math.round(t3 - t2),
      },
    };
  } finally {
    ix.close();
  }
}

/**
 * Is the folder there, or could it come back? A folder whose drive or share root is missing (an
 * unplugged disk, a share offline) counts as still there, so its index is kept.
 */
export function stillThere(root: string, exists: (p: string) => boolean = existsSync): boolean {
  if (exists(root)) return true;
  const volume = parse(root).root;
  return volume !== '' && volume !== '/' && !exists(volume);
}

/**
 * Delete the index files in `dir` whose project folder no longer exists (or that do not say which
 * folder they were built from, or cannot be read): they are derived and rebuilt on the next open.
 * A folder on a drive or share that is not there now (unplugged, offline) keeps its index.
 * Returns the index files removed.
 */
export async function pruneIndexes(dir: string, keep: (root: string) => boolean = stillThere) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names.filter((n) => n.endsWith('.sqlite')).sort()) {
    const file = join(dir, name);
    let root: string | undefined;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const r = db.prepare(`SELECT value FROM meta WHERE key = 'root'`).get();
        root = typeof r?.value === 'string' ? r.value : undefined;
      } finally {
        db.close();
      }
    } catch {
      root = undefined;
    }
    if (root && keep(root)) continue;
    await removeIndex(file);
    removed.push(file);
  }
  // companions left without their index file
  for (const name of names.filter((n) => /\.sqlite-(wal|shm)$/.test(n))) {
    const base = join(dir, name.replace(/-(wal|shm)$/, ''));
    if (!existsSync(base)) await rm(join(dir, name), { force: true });
  }
  return removed;
}
