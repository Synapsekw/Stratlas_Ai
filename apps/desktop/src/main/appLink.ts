import { PACKAGE_EXTENSION } from '@aio/schema';
import { posix, win32 } from 'node:path';

/** What a `<urlScheme>://` link the OS hands to the app asks for. */
export type AppLink = { kind: 'focus' } | { kind: 'open'; path: string };

/**
 * Parse a link such as `stratlas://open?path=%2FUsers%2Fme%2Fsite.aio` (macOS `open-url`).
 * Only `open` with an absolute local path to a `.aio` package opens anything, through the same
 * read-only flow as a double-clicked package; every other link of the scheme just brings the
 * app to the front. Network paths are refused, so a web page cannot make the app reach out.
 * Returns null for a URL of another scheme.
 */
export function parseAppLink(
  url: string,
  scheme: string,
  platform: NodeJS.Platform = process.platform,
): AppLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${scheme.toLowerCase()}:`) return null;
  const focus: AppLink = { kind: 'focus' };
  const action = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'open') return focus;
  const path = u.searchParams.get('path');
  if (!path?.toLowerCase().endsWith(PACKAGE_EXTENSION)) return focus;
  if (/^[\\/]{2}/.test(path) || path.includes('\0')) return focus;
  const abs =
    platform === 'win32'
      ? win32.isAbsolute(path) && /^[a-z]:[\\/]/i.test(path)
      : posix.isAbsolute(path);
  return abs ? { kind: 'open', path } : focus;
}

/**
 * Windows (MSIX `windows.protocol`) starts the app with the link as an argument, or hands it to
 * the running instance in `second-instance`: the package path it opens, if any.
 */
export function linkPathFromArgv(
  argv: readonly string[],
  scheme: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const link = parseAppLink(argv[i] ?? '', scheme, platform);
    if (link?.kind === 'open') return link.path;
  }
  return null;
}
