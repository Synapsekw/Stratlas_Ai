/**
 * Find the installed Analytics pack: llama-server and the vision model the `detect.vlm` job
 * talks to. It lives in `<data folder>/runtime/analytics-pack-<version>/` (installed by
 * jobs/packInstall.ts with `ANALYTICS_PACK`); `QUADRION_ANALYTICS_PACK` names one pack folder
 * instead, as `QUADRION_PIPELINE_PACK` does for the pipeline pack.
 */
import { AnalyticsPackManifest } from '@aio/schema';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from '../fsutil';
import { compareVersions } from '../jobs/pack';
import { ANALYTICS_PACK } from '../jobs/packInstall';

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

/** A path from the manifest (`/` separated, inside the pack) under `dir`; null when it climbs out. */
function inside(dir: string, rel: string): string | null {
  const segs = rel.replace(/\\/g, '/').split('/');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || segs.some((s) => s === '..')) return null;
  return join(dir, ...segs.filter((s) => s !== '' && s !== '.'));
}

const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false;

/** One pack folder: null unless its manifest parses and llama-server, model and projector are there. */
export async function readAnalyticsPack(dir: string): Promise<AnalyticsPack | null> {
  const parsed = AnalyticsPackManifest.safeParse(
    await readJson(join(dir, 'manifest.json')).catch(() => null),
  );
  if (!parsed.success) return null;
  const manifest = parsed.data;
  const server = inside(dir, manifest.runtime.executable);
  const gguf = inside(dir, manifest.model.gguf);
  const mmproj = inside(dir, manifest.model.mmproj);
  if (server === null || gguf === null || mmproj === null) return null;
  if (!(await isFile(server)) || !(await isFile(gguf)) || !(await isFile(mmproj))) return null;
  return { version: manifest.version, dir, manifest, server, gguf, mmproj };
}

/**
 * The Analytics pack to use: the folder `QUADRION_ANALYTICS_PACK` names (and nothing else when it
 * is not a pack), else the newest valid `<data folder>/runtime/analytics-pack-<version>/`.
 */
export async function findAnalyticsPack(o: {
  dataRoot: string;
  env: Record<string, string | undefined>;
}): Promise<AnalyticsPack | null> {
  const single = o.env.QUADRION_ANALYTICS_PACK;
  if (single) return readAnalyticsPack(single);
  const runtimeDir = join(o.dataRoot, 'runtime');
  const names = await readdir(runtimeDir).catch(() => [] as string[]);
  const candidates = names
    .map((n) => ({ n, v: ANALYTICS_PACK.dir.exec(n)?.[1] }))
    .filter((c): c is { n: string; v: string } => c.v !== undefined)
    .sort((a, b) => compareVersions(b.v, a.v));
  for (const c of candidates) {
    const pack = await readAnalyticsPack(join(runtimeDir, c.n));
    if (pack) return pack;
  }
  return null;
}
