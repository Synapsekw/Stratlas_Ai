import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The settings folder follows the product name: `%APPDATA%\Quadrion AI` (macOS
 * `~/Library/Application Support/Quadrion AI`) since the rename, `...\Stratlas` before it. On the
 * first start after the update, before anything reads the folder, the old folder's contents are
 * copied over once: settings, library, identity, jobs, logs, the renderer's local storage. The
 * old folder is never moved or deleted, so going back to an old version still finds it.
 */

/** The folder name before the rename (7 Oct 2026). */
export const LEGACY_USER_DATA_NAME = 'Stratlas';
/** Written into the new folder once the copy is done; its presence means "never copy again". */
export const MIGRATION_MARKER = 'migrated-from-stratlas.json';
/** Chromium caches and locks: rebuilt on demand, or only valid for the process that made them. */
export const NOT_COPIED: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'lockfile',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
];

export type UserDataMigration =
  | { kind: 'copied'; from: string; copied: string[]; failed: string[] }
  | {
      kind: 'skipped';
      reason: 'override' | 'not-packaged' | 'done' | 'has-settings' | 'no-legacy';
    };

export interface FsPorts {
  exists: (p: string) => boolean;
  list: (dir: string) => string[];
  mkdir: (dir: string) => void;
  copy: (from: string, to: string) => void;
  write: (file: string, text: string) => void;
}

const nodeFs: FsPorts = {
  exists: existsSync,
  list: (dir) => readdirSync(dir),
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  // never overwrite what the new folder already has
  copy: (from, to) => {
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  },
  write: (file, text) => {
    writeFileSync(file, text);
  },
};

/**
 * Copy `<appData>/Stratlas` into `userData` once. Skipped for an isolated profile
 * (`QUADRION_USER_DATA`: tests, smoke runs, side-by-side runs), for development runs (their folder
 * is not named after the product), when the marker exists, when the new folder already has
 * settings, and when there is no old folder. An entry that cannot be copied is listed in
 * `failed` and does not stop the others; the marker is written either way.
 */
export function migrateLegacyUserData(o: {
  userData: string;
  appData: string;
  packaged: boolean;
  /** True when the userData folder was overridden (QUADRION_USER_DATA). */
  overridden: boolean;
  now?: Date;
  fs?: FsPorts;
}): UserDataMigration {
  const fs = o.fs ?? nodeFs;
  if (o.overridden) return { kind: 'skipped', reason: 'override' };
  if (!o.packaged) return { kind: 'skipped', reason: 'not-packaged' };
  if (fs.exists(join(o.userData, MIGRATION_MARKER))) return { kind: 'skipped', reason: 'done' };
  if (fs.exists(join(o.userData, 'settings.json')))
    return { kind: 'skipped', reason: 'has-settings' };
  const from = join(o.appData, LEGACY_USER_DATA_NAME);
  if (from === o.userData || !fs.exists(from)) return { kind: 'skipped', reason: 'no-legacy' };
  fs.mkdir(o.userData);
  const copied: string[] = [];
  const failed: string[] = [];
  for (const name of fs.list(from)) {
    if (NOT_COPIED.includes(name)) continue;
    try {
      fs.copy(join(from, name), join(o.userData, name));
      copied.push(name);
    } catch {
      failed.push(name);
    }
  }
  const at = (o.now ?? new Date()).toISOString();
  fs.write(
    join(o.userData, MIGRATION_MARKER),
    `${JSON.stringify({ from, at, copied, failed }, null, 2)}\n`,
  );
  return { kind: 'copied', from, copied, failed };
}
