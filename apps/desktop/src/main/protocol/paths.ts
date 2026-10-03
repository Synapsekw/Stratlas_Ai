import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

export type Resolved = { ok: true; path: string } | { ok: false; status: 403 | 404 };

const FORBIDDEN: Resolved = { ok: false, status: 403 };
const NOT_FOUND: Resolved = { ok: false, status: 404 };

/**
 * Resolve a relative, already URL-decoded path to a regular file inside `root`.
 *
 * Rejects (403) parent segments, absolute paths, drive letters, NUL bytes and any symlink or
 * junction whose target leaves the root. Missing files and directories are 404.
 */
export async function resolveInside(root: string, rel: string): Promise<Resolved> {
  if (rel === '' || rel.includes('\0')) return FORBIDDEN;
  if (/^[/\\]/.test(rel) || /^[a-z]:/i.test(rel) || isAbsolute(rel)) return FORBIDDEN;
  const segments = rel.split(/[/\\]+/);
  if (segments.some((s) => s === '..')) return FORBIDDEN;

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return NOT_FOUND;
  }
  try {
    realTarget = await realpath(join(realRoot, ...segments));
  } catch {
    return NOT_FOUND;
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (!realTarget.startsWith(prefix)) return FORBIDDEN;

  try {
    const s = await stat(realTarget);
    if (!s.isFile()) return NOT_FOUND;
  } catch {
    return NOT_FOUND;
  }
  return { ok: true, path: realTarget };
}
