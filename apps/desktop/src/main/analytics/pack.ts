/**
 * Find the installed Analytics pack: llama-server and the vision model the `detect.vlm` job
 * talks to. It lives in `<data folder>/runtime/analytics-pack-<version>/` (installed by
 * jobs/packInstall.ts with `ANALYTICS_PACK`); `QUADRION_ANALYTICS_PACK` names one pack folder
 * instead, as `QUADRION_PIPELINE_PACK` does for the pipeline pack. A folder is used only when it
 * passes the installer's platform and app range checks again (it may have been copied in, or the
 * app updated since) and its files are there; `unusablePacks` says why the others are not.
 */
import { AnalyticsPackManifest } from '@aio/schema';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readJson } from '../fsutil';
import { compareVersions, type PackApp } from '../jobs/pack';
import { ANALYTICS_PACK, platformRefusal } from '../jobs/packInstall';
import { presetText } from './text';

export interface AnalyticsPack {
  version: string;
  dir: string;
  manifest: AnalyticsPackManifest;
  /** llama-server, absolute. */
  server: string;
  /** The model and its vision projector, absolute. */
  gguf: string;
  mmproj: string;
}

/** Where to look, and the app and computer (`win32-x64`) a pack must fit. */
export interface PackPlace {
  dataRoot: string;
  env: Record<string, string | undefined>;
  app: PackApp;
  platform: string;
}

export interface UnusablePack {
  version: string;
  reason: string;
}

/** A path from the manifest (`/` separated, inside the pack) under `dir`; null when it climbs out. */
function inside(dir: string, rel: string): string | null {
  const segs = rel.replace(/\\/g, '/').split('/');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || segs.some((s) => s === '..')) return null;
  return join(dir, ...segs.filter((s) => s !== '' && s !== '.'));
}

/** A file the manifest names, absolute; null when it climbs out of the pack or is not there. */
async function located(dir: string, rel: string): Promise<string | null> {
  const p = inside(dir, rel);
  return p !== null && (await stat(p).catch(() => null))?.isFile() ? p : null;
}

/** One pack folder (`named` is the version its folder name gives): the pack, or why not. */
async function checkAnalyticsPack(
  dir: string,
  named: string,
  o: Pick<PackPlace, 'app' | 'platform'>,
): Promise<AnalyticsPack | UnusablePack> {
  const parsed = AnalyticsPackManifest.safeParse(
    await readJson(join(dir, 'manifest.json')).catch(() => null),
  );
  if (!parsed.success) {
    return {
      version: named,
      reason: presetText('detect.preset.pack.damaged', { version: named, file: 'manifest.json' }),
    };
  }
  const manifest = parsed.data;
  const version = manifest.version;
  const elsewhere = platformRefusal(ANALYTICS_PACK, manifest.platform, o.platform);
  if (elsewhere) return { version, reason: elsewhere };
  if (ANALYTICS_PACK.rangeRefusal(manifest.appRange, o.app) !== null) {
    return {
      version,
      reason: presetText('detect.preset.pack.outOfRange', { version, range: manifest.appRange }),
    };
  }
  const damaged = (file: string): UnusablePack => ({
    version,
    reason: presetText('detect.preset.pack.damaged', { version, file }),
  });
  const server = await located(dir, manifest.runtime.executable);
  if (server === null) return damaged(manifest.runtime.executable);
  const gguf = await located(dir, manifest.model.gguf);
  if (gguf === null) return damaged(manifest.model.gguf);
  const mmproj = await located(dir, manifest.model.mmproj);
  if (mmproj === null) return damaged(manifest.model.mmproj);
  return { version, dir, manifest, server, gguf, mmproj };
}

/**
 * The pack folders to consider, newest first: the one `QUADRION_ANALYTICS_PACK` names (and
 * nothing else), else every `<data folder>/runtime/analytics-pack-<version>/`.
 */
async function packFolders(o: PackPlace): Promise<{ dir: string; named: string }[]> {
  const single = o.env.QUADRION_ANALYTICS_PACK;
  if (single) return [{ dir: single, named: basename(single) }];
  const runtimeDir = join(o.dataRoot, 'runtime');
  const names = await readdir(runtimeDir).catch(() => [] as string[]);
  return names
    .map((n) => ({ dir: join(runtimeDir, n), named: ANALYTICS_PACK.dir.exec(n)?.[1] }))
    .filter((c): c is { dir: string; named: string } => c.named !== undefined)
    .sort((a, b) => compareVersions(b.named, a.named));
}

const usable = (c: AnalyticsPack | UnusablePack): c is AnalyticsPack => 'dir' in c;

/**
 * The Analytics pack to use: the folder `QUADRION_ANALYTICS_PACK` names (and nothing else when it
 * is not a usable pack), else the newest usable `<data folder>/runtime/analytics-pack-<version>/`.
 */
export async function findAnalyticsPack(o: PackPlace): Promise<AnalyticsPack | null> {
  for (const f of await packFolders(o)) {
    const c = await checkAnalyticsPack(f.dir, f.named, o);
    if (usable(c)) return c;
  }
  return null;
}

/** The pack folders `findAnalyticsPack` passes over, newest first, each with why. */
export async function unusablePacks(o: PackPlace): Promise<UnusablePack[]> {
  const out: UnusablePack[] = [];
  for (const f of await packFolders(o)) {
    const c = await checkAnalyticsPack(f.dir, f.named, o);
    if (!usable(c)) out.push({ version: c.version, reason: c.reason });
  }
  return out;
}
