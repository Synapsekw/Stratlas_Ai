import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { BUILD_BASE, type Extract, type ExtractRequest } from './manager';

/** The slice of a child process the runner uses (node:child_process spawn result). */
export interface ChildLike {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnLike = (cmd: string, args: string[]) => ChildLike;

const WORLD = (b: readonly number[]) =>
  (b[0] ?? 0) <= -179.9 && (b[2] ?? 0) >= 179.9 && (b[1] ?? 0) <= -84 && (b[3] ?? 0) >= 84;

/** Arguments for `pmtiles extract` (go-pmtiles CLI). */
export function extractArgs(req: Pick<ExtractRequest, 'source' | 'out' | 'bbox' | 'maxZoom'>) {
  const args = ['extract', req.source, req.out, `--maxzoom=${String(req.maxZoom)}`];
  if (!WORLD(req.bbox)) args.push(`--bbox=${req.bbox.join(',')}`);
  args.push('--download-threads=4');
  return args;
}

/** The last "NN%" in a chunk of the tool's progress bar output, as a fraction. */
export function parseProgress(text: string): number | null {
  const all = [...text.matchAll(/(\d{1,3})%/g)];
  const last = all.at(-1)?.[1];
  if (last === undefined) return null;
  return Math.min(100, Number(last)) / 100;
}

/** An Extract that runs the go-pmtiles binary at `bin`. */
export function createExtract(bin: string, spawn: SpawnLike): Extract {
  return (req) =>
    new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) {
        reject(new Error('Download cancelled'));
        return;
      }
      const child = spawn(bin, extractArgs(req));
      let tail = '';
      let settled = false;
      const onData = (chunk: Buffer | string) => {
        const text = chunk.toString();
        tail = (tail + text).slice(-2000);
        const p = parseProgress(text);
        if (p !== null) req.onProgress(p);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const onAbort = () => {
        child.kill();
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        req.signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      child.on('error', (e) => {
        finish(new Error(`The map download tool could not start: ${e.message}`));
      });
      child.on('exit', (code) => {
        if (req.signal.aborted) {
          finish(new Error('Download cancelled'));
          return;
        }
        if (code === 0) {
          finish(null);
          return;
        }
        // Last meaningful lines of output, without progress bar redraws.
        const lines = tail
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter((l) => l && !/^\d{1,3}%/.test(l));
        const why = lines.slice(-2).join(' ') || 'no output';
        finish(new Error(`The map download tool stopped (exit code ${String(code)}): ${why}`));
      });
    });
}

export interface ResolveOptions {
  env: Record<string, string | undefined>;
  platform: string;
  packaged: boolean;
  /** process.resourcesPath of the packaged app. */
  resourcesPath: string;
  /** app.getAppPath(): apps/desktop in development. */
  appPath: string;
  exists: (p: string) => boolean;
}

/**
 * Where the go-pmtiles binary is: STRATLAS_PMTILES, then `resources/bin` of a packaged app
 * (electron-builder `extraResources`), then `tools/maps/bin` of the repository in development
 * (fetched by `node tools/maps/build-packs.mjs --tool-only`). null when none exists.
 */
export function resolvePmtiles(o: ResolveOptions): string | null {
  const exe = o.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles';
  const candidates = [
    o.env.STRATLAS_PMTILES,
    o.packaged ? join(o.resourcesPath, 'bin', exe) : undefined,
    o.packaged ? undefined : join(o.appPath, '..', '..', 'tools', 'maps', 'bin', exe),
  ];
  for (const c of candidates) if (c && o.exists(c)) return c;
  return null;
}

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
 */
export async function findLatestBuild(fetchFn: FetchLike, signal: AbortSignal): Promise<string> {
  const res = await fetchFn(BUILDS_INDEX, { signal });
  if (!res.ok) {
    throw new Error(`The Protomaps build list is not reachable (HTTP ${String(res.status)}).`);
  }
  const index: unknown = await res.json();
  const keys = Array.isArray(index)
    ? index
        .map((b: unknown) => (b as { key?: unknown } | null)?.key)
        .filter((k): k is string => typeof k === 'string' && /^\d{8}\.pmtiles$/.test(k))
        .sort()
        .reverse()
    : [];
  latestBuildFrom(index);
  for (const key of keys.slice(0, 3)) {
    const head = await fetchFn(`${BUILD_BASE}${key}`, { method: 'HEAD', signal });
    if (head.ok) return key.slice(0, 8);
  }
  throw new Error('No recent Protomaps planet build is published. Try again later.');
}
