// Protomaps planet builds: which daily build to extract a region from. The extract itself is
// `extract.ts` (TypeScript, HTTP ranges, resumable); no external tool is needed.
import { BUILD_BASE } from './manager';

/** Index of the Protomaps daily builds. */
export const BUILDS_INDEX = 'https://build-metadata.protomaps.dev/builds.json';

/** Newest `YYYYMMDD` planet build from the builds index. */
export function latestBuildFrom(index: unknown): string {
  const keys = Array.isArray(index)
    ? index
        .map((b: unknown) => (b as { key?: unknown } | null)?.key)
        .filter((k): k is string => typeof k === 'string' && /^\d{8}\.pmtiles$/.test(k))
        .sort()
    : [];
  const newest = keys.at(-1);
  if (!newest) throw new Error('The Protomaps build list did not name a planet build.');
  return newest.slice(0, 8);
}

export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<Response>;

/**
 * Newest planet build that can be downloaded: the builds index, then a HEAD request on up to
 * three of the newest builds (a fresh build can be listed before its file is published).
 * `where` points both at a mirror or a local test server.
 */
export async function findLatestBuild(
  fetchFn: FetchLike,
  signal: AbortSignal,
  where: { index?: string; base?: string } = {},
): Promise<string> {
  const index = where.index ?? BUILDS_INDEX;
  const base = where.base ?? BUILD_BASE;
  const res = await fetchFn(index, { signal });
  if (!res.ok) {
    throw new Error(`The Protomaps build list is not reachable (HTTP ${String(res.status)}).`);
  }
  const list: unknown = await res.json();
  const keys = Array.isArray(list)
    ? list
        .map((b: unknown) => (b as { key?: unknown } | null)?.key)
        .filter((k): k is string => typeof k === 'string' && /^\d{8}\.pmtiles$/.test(k))
        .sort()
        .reverse()
    : [];
  latestBuildFrom(list);
  for (const key of keys.slice(0, 3)) {
    const head = await fetchFn(`${base}${key}`, { method: 'HEAD', signal });
    if (head.ok) return key.slice(0, 8);
  }
  throw new Error('No recent Protomaps planet build is published. Try again later.');
}

/**
 * Where planet builds come from: Protomaps, or `STRATLAS_PACK_SOURCE` (a mirror base URL ending
 * in `/` that serves `builds.json` and `<YYYYMMDD>.pmtiles`, used by the e2e tests on 127.0.0.1).
 */
export function buildSource(env: Record<string, string | undefined>): {
  index: string;
  base: string;
} {
  const mirror = env.STRATLAS_PACK_SOURCE;
  if (mirror && /^https?:\/\//.test(mirror)) {
    const base = mirror.endsWith('/') ? mirror : `${mirror}/`;
    return { index: `${base}builds.json`, base };
  }
  return { index: BUILDS_INDEX, base: BUILD_BASE };
}
