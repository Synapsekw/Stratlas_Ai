import { UPDATE_FEED_FILE, UpdateFeed, type UpdateFile, type UpdatePlatform } from '@aio/schema';
import { ed25519Valid } from '../ed25519';

/** Loopback hosts: the only places a development build may read a feed over plain http. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether the update chain may use `u`: https always; plain http only to this computer
 * (127.0.0.1, localhost, ::1) and only when `allowLoopbackHttp` (an unpackaged build, the e2e
 * tests' local feed). A packaged app reads feeds and installers over https only.
 */
export function updateUrlAllowed(u: URL, allowLoopbackHttp: boolean): boolean {
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && allowLoopbackHttp && LOOPBACK.has(u.hostname.toLowerCase());
}

/**
 * The feed file's address from the Settings value: a `.json` file, or a folder ending in `/`.
 * Throws a TypeError on an invalid address and an Error on one that is not https
 * (`updateUrlAllowed`).
 */
export function feedUrl(setting: string, allowLoopbackHttp = false): string {
  const u = new URL(setting.trim());
  if (!updateUrlAllowed(u, allowLoopbackHttp))
    throw new Error('The update address must start with https://.');
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
 * address. Only https downloads are accepted (loopback http too with `allowLoopbackHttp`).
 */
export function parseFeed(
  text: string,
  from: string,
  key: UpdatePlatform | null,
  allowLoopbackHttp = false,
): ParsedFeed {
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
  if (!updateUrlAllowed(href, allowLoopbackHttp)) {
    return { ok: false, error: `The update file must be served over https: ${href.href}` };
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

/** The detached signature's address: the feed's own address with `.sig` added. */
export function signatureUrl(feed: string): string {
  const u = new URL(feed);
  u.pathname += '.sig';
  return u.href;
}

/**
 * Check the feed's detached Ed25519 signature (`<feed>.sig`, base64 of the signature over the
 * feed file's exact bytes) against the public key pinned in brand.json
 * (`signing.updateFeedKey`, base64 of the raw 32-byte key). Null when it holds, else why not.
 */
export function feedSignatureError(
  text: string,
  signature: string,
  publicKey: string,
): string | null {
  const ok = ed25519Valid(Buffer.from(text, 'utf8'), signature, publicKey);
  if (ok === null) return 'The pinned update key is not a valid Ed25519 public key.';
  return ok
    ? null
    : 'The update feed signature does not match: the feed was changed or not signed by the publisher.';
}
