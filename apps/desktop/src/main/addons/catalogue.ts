/**
 * The add-on catalogue (`addons.ts` in `@aio/schema`): `catalogue.json` at the add-on base URL,
 * read on each `addons:list` and `addons:install` through a session of its own (the default
 * session blocks the network), never while Settings has Offline only on.
 *
 * The base URL is `QUADRION_ADDONS_URL`, else Settings `addons.baseUrl`, else the build's own
 * address (`DEFAULT_ADDON_BASE_URL`, empty until add-ons are published). Only `https://` is read,
 * or `http://` to this computer (the e2e fake server).
 */
import { AddonCatalogue, type AddonCatalogueEntry } from '@aio/schema';
import type { FetchLike } from '../update/download';

/** The address the build reads add-ons from when nothing else is set; none is published yet. */
export const DEFAULT_ADDON_BASE_URL = '';
export const CATALOGUE_FILE = 'catalogue.json';
/** A catalogue larger than this is not a catalogue (100 entries are well under 1 MB). */
const MAX_CATALOGUE_BYTES = 1024 * 1024;
const CATALOGUE_TIMEOUT_MS = 15_000;

const LOOPBACK = new Set(['localhost', '[::1]', '::1']);
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

/** An address the app may download add-ons from: `https://`, or `http://` to this computer. */
export function allowedAddonUrl(u: URL): boolean {
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  // a literal 127.x.y.z address only: a name such as 127.example.com is anybody's
  return u.protocol === 'http:' && (LOOPBACK.has(u.hostname) || IPV4_LOOPBACK.test(u.hostname));
}

/** The base URL in use, or null when none is set. Never a URL the app may not read. */
export function addonBaseUrl(
  env: Record<string, string | undefined>,
  settingsUrl: string | undefined,
): { url: string } | { url: null; error?: string } {
  const raw = [env.QUADRION_ADDONS_URL, settingsUrl, DEFAULT_ADDON_BASE_URL]
    .map((s) => s?.trim() ?? '')
    .find((s) => s !== '');
  if (raw === undefined) return { url: null };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, error: `The add-on address ${raw} is not a web address.` };
  }
  if (!allowedAddonUrl(u)) {
    return {
      url: null,
      error: `The add-on address ${raw} is not https. Add-ons are only downloaded over https.`,
    };
  }
  // a folder: relative archive addresses resolve inside it
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return { url: u.toString() };
}

/** The archive address of a catalogue entry, resolved against the base URL, or why not. */
export function archiveUrl(
  base: string,
  entry: AddonCatalogueEntry,
): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(entry.archive.url, base);
  } catch {
    return {
      ok: false,
      error: `The catalogue gives ${entry.manifest.name} an address that is not a web address.`,
    };
  }
  if (!allowedAddonUrl(u)) {
    return {
      ok: false,
      error: `The catalogue gives ${entry.manifest.name} an address that is not https, so it is not downloaded.`,
    };
  }
  return { ok: true, url: u.toString() };
}

/** The catalogue's first problem as one sentence, or the catalogue. */
export function parseCatalogue(
  raw: unknown,
): { ok: true; catalogue: AddonCatalogue } | { ok: false; error: string } {
  const r = AddonCatalogue.safeParse(raw);
  if (r.success) {
    const ids = r.data.addons.map((a) => a.manifest.id);
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice !== undefined)
      return { ok: false, error: `The add-on catalogue lists "${twice}" twice.` };
    return { ok: true, catalogue: r.data };
  }
  const first = r.error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')})` : '';
  return {
    ok: false,
    error: `The add-on catalogue is not valid${where}: ${first?.message ?? 'unknown problem'}`,
  };
}

/**
 * A fetch for add-on archives that refuses an answer it can see came from an address the app may
 * not read. This is a courtesy, not the guarantee: Electron's `net.fetch` leaves `res.url` empty,
 * so in the app it checks only the address asked for. What protects an archive is the catalogue's
 * SHA-256 (and each file's in `addon.json`), checked before anything is unpacked.
 */
export function guardedFetch(fetch: FetchLike): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    let final: URL | null;
    try {
      // a redirected answer that does not say where it came from is refused
      final = res.url ? new URL(res.url) : res.redirected ? null : new URL(url);
    } catch {
      final = null;
    }
    if (!final || !allowedAddonUrl(final)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(
        `the server sent the request on to ${final?.origin ?? 'an address'} that is not https`,
      );
    }
    return res;
  };
}

export const MAX_HOPS = 5;

/** The sentence for a refused redirect, shown after "The add-on list could not be read from <base>: ". */
export const REDIRECT_REFUSED = (origin: string): string =>
  `the address sends the app on to ${origin}, which the app does not read add-ons from (use an https address that answers directly)`;
export const REDIRECT_UNSEEN =
  'the address sends the app on somewhere it could not check (use an https address that answers directly)';
export const REDIRECT_TOO_MANY = 'the address sends the app on too many times';

/**
 * Whether the request at `from` may follow a redirect to `location` as hop number `hop` (0 for the
 * first redirect): the next address must be one `allowedAddonUrl` accepts, never a step down from
 * https to plain http (even to this computer), and at most `MAX_HOPS` hops. The one rule for both
 * the tested fetch path (`fetchHopByHop`) and the app's `net.request` adapter
 * (`netCatalogueFetch`).
 */
export function checkHop(
  from: string,
  location: string | null | undefined,
  hop: number,
): { ok: true; url: string } | { ok: false; error: string } {
  if (!location) return { ok: false, error: REDIRECT_UNSEEN };
  if (hop >= MAX_HOPS) return { ok: false, error: REDIRECT_TOO_MANY };
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return { ok: false, error: REDIRECT_UNSEEN };
  }
  if (new URL(from).protocol === 'https:' && next.protocol !== 'https:')
    return { ok: false, error: REDIRECT_REFUSED(next.origin) };
  if (!allowedAddonUrl(next)) return { ok: false, error: REDIRECT_REFUSED(next.origin) };
  return { ok: true, url: next.toString() };
}

/**
 * Fetch the catalogue following redirects by hand (`redirect: 'manual'`), each hop checked with
 * `checkHop` before it is requested: a plain-http hop can never send the request on to a host of
 * its choosing, as checking only the final address would let it. A redirect the fetch does not
 * show (an opaque one), or one it followed anyway, is refused. A fetch that applies `checkHop`
 * itself (the app's `netCatalogueFetch`) only ever answers the final response, which passes
 * straight through.
 */
export async function fetchHopByHop(
  fetch: FetchLike,
  url: string,
  init: { signal?: AbortSignal } = {},
): Promise<Response> {
  if (!allowedAddonUrl(new URL(url))) throw new Error(REDIRECT_REFUSED(new URL(url).origin));
  let at = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(at, { ...init, redirect: 'manual' });
    const isRedirect =
      res.type === 'opaqueredirect' ||
      (res.status >= 300 && res.status < 400 && res.status !== 304);
    if (res.redirected) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(REDIRECT_UNSEEN);
    }
    if (!isRedirect) return res;
    await res.body?.cancel().catch(() => undefined);
    const location = res.type === 'opaqueredirect' ? null : res.headers.get('location');
    const next = checkHop(at, location, hop);
    if (!next.ok) throw new Error(next.error);
    at = next.url;
  }
}

/** The body as text, refused past `cap` bytes without reading the rest. */
async function readCapped(res: Response, cap: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? '0') > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('the list is too large to be one');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error('the list is too large to be one');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read `catalogue.json` at `base` (a base URL from `addonBaseUrl`). */
export async function readCatalogue(o: {
  base: string;
  fetch: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: true; catalogue: AddonCatalogue } | { ok: false; error: string }> {
  const url = new URL(CATALOGUE_FILE, o.base).toString();
  const timeout = AbortSignal.timeout(o.timeoutMs ?? CATALOGUE_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchHopByHop(o.fetch, url, { signal });
  } catch (e) {
    const why = timeout.aborted
      ? 'it did not answer in time'
      : (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return { ok: false, error: `The add-on list could not be read from ${o.base}: ${why}.` };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      error: `The add-on list could not be read from ${o.base}: the server answered HTTP ${String(res.status)}.`,
    };
  }
  let text: string;
  try {
    text = await readCapped(res, MAX_CATALOGUE_BYTES);
  } catch (e) {
    return {
      ok: false,
      error: `The add-on list could not be read from ${o.base}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}.`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `The add-on list at ${o.base} is not JSON.` };
  }
  return parseCatalogue(raw);
}
