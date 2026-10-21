/**
 * Archive member names, checked the way the pipeline pack installer checks them
 * (`apps/desktop/src/main/jobs/packInstall.ts` `archiveSegments`), shared here for the readers
 * of project packages.
 */

/** Device names Windows reserves, with or without an extension (`CON`, `nul.json`, `COM1.txt`). */
export const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type Segments = { ok: true; segments: string[] } | { ok: false; why: string };

/**
 * The folder segments of an archive member name, or why it cannot be used: absolute paths, `..`,
 * control characters, over-long names and, for Windows, `< > : " | ? *` (`:` opens an alternate
 * data stream), a trailing dot or space and the reserved device names.
 */
export function archiveSegments(
  raw: string,
  win32: boolean = process.platform === 'win32',
): Segments {
  if (raw.length === 0) return { ok: false, why: 'an entry without a name' };
  if (raw.length > 4096) return { ok: false, why: 'a path that is too long' };
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { ok: false, why: 'an absolute path' };
  const segments: string[] = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') return { ok: false, why: 'a path that climbs out with ".."' };
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

/** The key two member names share when Windows would see them as one file. */
export const caseFoldKey = (name: string): string => name.normalize('NFC').toLowerCase();
