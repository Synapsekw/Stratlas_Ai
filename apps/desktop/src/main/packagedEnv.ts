import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Environment switches an installed (packaged) app still honours. Everything else under
 * `QUADRION_*` / `STRATLAS_*`, and `ELECTRON_RENDERER_URL`, is a development or test switch: it
 * can load another renderer URL, run another Python, ffmpeg or ODM, stand a fake model, tile
 * service, update feed or download mirror in, so a packaged build drops it before any module reads
 * it. The end to end suite runs the unpackaged build and keeps every switch.
 *
 * Kept, and why:
 * - `DATA`: the default data folder (documented; the packaged smoke test points it at a temp folder).
 * - `USER_DATA`: an isolated settings folder (packaged smoke test; side-by-side runs). It moves
 *   where the app keeps its own files, it never loads code.
 * - `SMOKE`: the release smoke test (load the UI, exit 0).
 * - `SMOKE_REPORT`: only together with `SMOKE=1` and `USER_DATA`, and only a file inside that
 *   folder, so it cannot write anywhere else.
 * - `TEST_VAULT`: only together with `SMOKE=1` and `USER_DATA` (keys of the smoke run stay in its
 *   throwaway folder, not the OS vault).
 * - `WINDOW`, `WINDOW_SIZE`, `PHOTO_MEMORY_MB`, `SYSTEM_MEMORY_GB`, `SHOW_GATE`, `CRASH_NOTICE`,
 *   `PACK_NOTICE`: window placement and display hints, nothing that loads code or reaches a URL.
 */
const KEPT = new Set([
  'DATA',
  'USER_DATA',
  'SMOKE',
  'SMOKE_REPORT',
  'TEST_VAULT',
  'WINDOW',
  'WINDOW_SIZE',
  'PHOTO_MEMORY_MB',
  'SYSTEM_MEMORY_GB',
  'SHOW_GATE',
  'CRASH_NOTICE',
  'PACK_NOTICE',
]);

/** Variables outside the app's prefixes that are development switches too. */
const DEV_ONLY = ['ELECTRON_RENDERER_URL'];

function inside(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * In a packaged build, delete every development or test switch from `env` (in place) and return
 * the names removed. An unpackaged build keeps them all.
 */
export function scrubPackagedEnv(
  env: Record<string, string | undefined>,
  packaged: boolean,
): string[] {
  if (!packaged) return [];
  const removed: string[] = [];
  const drop = (name: string) => {
    if (name in env) {
      Reflect.deleteProperty(env, name);
      removed.push(name);
    }
  };
  for (const name of DEV_ONLY) drop(name);
  for (const name of Object.keys(env)) {
    const m = /^(QUADRION|STRATLAS)_(.+)$/.exec(name);
    if (m?.[2] && !KEPT.has(m[2])) drop(name);
  }
  const smoke = env.QUADRION_SMOKE === '1' && Boolean(env.QUADRION_USER_DATA);
  for (const prefix of ['QUADRION', 'STRATLAS']) {
    if (!smoke) drop(`${prefix}_TEST_VAULT`);
    const report = env[`${prefix}_SMOKE_REPORT`];
    if (report !== undefined && !(smoke && inside(env.QUADRION_USER_DATA ?? '', report)))
      drop(`${prefix}_SMOKE_REPORT`);
  }
  return removed;
}
