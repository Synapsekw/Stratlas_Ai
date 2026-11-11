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
 * A fetch that refuses an answer that came from an address the app may not read: a redirect to
 * plain http elsewhere, or away from https. The answer's body is never read in that case.
 */
export function guardedFetch(fetch: FetchLike): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    let final: URL | null;
    try {
      final = new URL(res.url || url);
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
    res = await guardedFetch(o.fetch)(url, { signal });
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
