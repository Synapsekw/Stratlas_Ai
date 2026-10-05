import { UPDATE_FEED_FILE, UpdateFeed, type UpdateFile, type UpdatePlatform } from '@aio/schema';

/** The feed file's address from the Settings value: a `.json` file, or a folder ending in `/`. */
export function feedUrl(setting: string): string {
  const u = new URL(setting.trim());
  if (!u.pathname.toLowerCase().endsWith('.json')) {
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    u.pathname += UPDATE_FEED_FILE;
  }
  return u.href;
}

/** The feed slot for this machine, or null where the app has no installer (Linux). */
export function platformKey(platform: string, arch: string): UpdatePlatform | null {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!cpu) return null;
  if (platform === 'win32') return `win-${cpu}`;
  if (platform === 'darwin') return `mac-${cpu}`;
  return null;
}

export type ParsedFeed =
  | { ok: true; feed: UpdateFeed; file: (UpdateFile & { href: string; name: string }) | null }
  | { ok: false; error: string };

/**
 * Validate a feed and pick this platform's installer, its URL resolved against the feed's own
 * address. Only http(s) downloads are accepted.
 */
export function parseFeed(text: string, from: string, key: UpdatePlatform | null): ParsedFeed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The update feed is not valid JSON.' };
  }
  const parsed = UpdateFeed.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `The update feed is not valid (${issue ? `${issue.path.join('.') || 'file'}: ${issue.message}` : 'unknown format'}).`,
    };
  }
  const feed = parsed.data;
  const entry = key ? feed.files[key] : undefined;
  if (!entry) return { ok: true, feed, file: null };
  let href: URL;
  try {
    href = new URL(entry.url, from);
  } catch {
    return { ok: false, error: `The update feed has an invalid file address: ${entry.url}` };
  }
  if (href.protocol !== 'https:' && href.protocol !== 'http:') {
    return { ok: false, error: `The update file must be served over http(s): ${href.href}` };
  }
  const name = decodeURIComponent(href.pathname.split('/').pop() ?? '');
  if (!name || /[\\/:*?"<>|]/.test(name)) {
    return { ok: false, error: `The update file name is not usable: ${name}` };
  }
  return {
    ok: true,
    feed,
    file: { ...entry, sha256: entry.sha256.toLowerCase(), href: href.href, name },
  };
}
