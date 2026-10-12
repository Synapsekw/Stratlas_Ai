// Expands the paths given to an import: files stay as given, folders are walked.
import { lstat, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

export const MAX_FOLDER_FILES = 20_000;

export interface LeftOut {
  folder: string;
  count: number;
  exts: string[];
}

export interface Expanded {
  /** Every file to import: given files first in their order, then each folder's files sorted. */
  files: string[];
  /** Per folder, the files with an extension the import does not know. */
  leftOut: LeftOut[];
  /** The folder that went over the limit, else null. */
  tooMany: string | null;
}

const keyOf = (p: string): string => {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

export async function expandImportPaths(
  paths: readonly string[],
  known: (ext: string) => boolean,
  limit: number = MAX_FOLDER_FILES,
): Promise<Expanded> {
  const seen = new Set<string>();
  const given: string[] = [];
  const folders: string[] = [];
  for (const p of paths) {
    const key = keyOf(p);
    if (seen.has(key)) continue;
    seen.add(key);
    let isDir = false;
    try {
      isDir = (await lstat(p)).isDirectory();
    } catch {
      // Missing path: keep as given, the import reports it.
    }
    (isDir ? folders : given).push(p);
  }

  const files = [...given];
  const leftOut: LeftOut[] = [];
  let total = 0;
  for (const folder of folders) {
    const found: string[] = [];
    const skipped = new Map<string, number>();
    let skippedCount = 0;
    const state = { over: false };
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (state.over) return;
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          const ext = extname(e.name).toLowerCase();
          if (known(ext)) {
            if (++total > limit) {
              state.over = true;
              return;
            }
            found.push(full);
          } else {
            skippedCount += 1;
            if (ext) skipped.set(ext, 1);
          }
        }
      }
    };
    await walk(folder);
    if (state.over) return { files: [], leftOut: [], tooMany: folder };
    found.sort();
    for (const f of found) {
      const key = keyOf(f);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(f);
    }
    if (skippedCount > 0) {
      leftOut.push({ folder, count: skippedCount, exts: [...skipped.keys()].sort() });
    }
  }
  return { files, leftOut, tooMany: null };
}
