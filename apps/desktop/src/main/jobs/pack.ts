import { packRangeRefusal, PipelinePackManifest, type RuntimeInfo } from '@aio/schema';
import { access, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJson } from '../fsutil';

/** A usable pipeline runtime: the pack folder and its Python. */
export interface PackInfo {
  dir: string;
  version: string;
  python: string;
  manifest?: PipelinePackManifest;
}

const PACK_DIR = /^pipeline-pack-(.+)$/;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Numeric dotted-version order; a pre-release (`1.0.0-rc1`) sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [ca = '', pa] = a.split('-', 2);
  const [cb = '', pb] = b.split('-', 2);
  const na = ca.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const nb = cb.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa === undefined && pb !== undefined) return 1;
  if (pa !== undefined && pb === undefined) return -1;
  return (pa ?? '').localeCompare(pb ?? '');
}

/** The app reading packs: a pack whose `appRange` leaves it out is refused (M9 T8). */
export interface PackApp {
  version: string;
  name?: string;
}

async function readPack(
  dir: string,
  appInfo?: PackApp,
): Promise<PackInfo | { refused: string } | null> {
  let raw: unknown;
  try {
    raw = await readJson(join(dir, 'manifest.json'));
  } catch {
    return null;
  }
  const m = PipelinePackManifest.safeParse(raw);
  if (!m.success) return null;
  if (appInfo) {
    const refused = packRangeRefusal(m.data.appRange, appInfo.version, appInfo.name);
    if (refused) return { refused };
  }
  const python = join(dir, ...m.data.python.executable.split('/'));
  if (!(await exists(python))) return null;
  return { dir, version: m.data.version, python, manifest: m.data };
}

/**
 * Find the pipeline pack: `STRATLAS_PIPELINE_PYTHON` (a development interpreter, e.g. the uv
 * venv in python/.venv), then `STRATLAS_PIPELINE_PACK` (one pack folder), then the newest valid
 * `<data folder>/runtime/pipeline-pack-<version>/`. The pack lives outside the installer and the
 * repository; it is built by tools/pipeline-pack/build.mjs.
 */
export async function findPack(o: {
  dataRoot: string;
  env: Record<string, string | undefined>;
  /** This app: packs declaring an `appRange` without it are refused with a clear message. */
  app?: PackApp;
}): Promise<{ pack: PackInfo | null; runtime: RuntimeInfo }> {
  const devPython = o.env.STRATLAS_PIPELINE_PYTHON;
  if (devPython) {
    if (await exists(devPython)) {
      const pack = { dir: dirname(devPython), version: 'dev', python: devPython };
      return { pack, runtime: { found: true, version: 'dev', dir: pack.dir } };
    }
    return {
      pack: null,
      runtime: {
        found: false,
        problem: `STRATLAS_PIPELINE_PYTHON points at ${devPython}, which does not exist.`,
      },
    };
  }
  const single = o.env.STRATLAS_PIPELINE_PACK;
  if (single) {
    const pack = await readPack(single, o.app);
    if (pack && 'refused' in pack) {
      return { pack: null, runtime: { found: false, problem: pack.refused } };
    }
    return pack
      ? { pack, runtime: { found: true, version: pack.version, dir: pack.dir } }
      : {
          pack: null,
          runtime: { found: false, problem: `${single} is not a valid pipeline pack.` },
        };
  }
  const runtimeDir = join(o.dataRoot, 'runtime');
  let names: string[];
  try {
    names = await readdir(runtimeDir);
  } catch {
    names = [];
  }
  const candidates = names
    .map((n) => ({ n, m: PACK_DIR.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => compareVersions(b.m[1] ?? '', a.m[1] ?? ''));
  let refused: string | null = null;
  for (const c of candidates) {
    const pack = await readPack(join(runtimeDir, c.n), o.app);
    if (pack && 'refused' in pack) {
      refused ??= pack.refused;
      continue;
    }
    if (pack) return { pack, runtime: { found: true, version: pack.version, dir: pack.dir } };
  }
  if (refused) return { pack: null, runtime: { found: false, problem: refused } };
  return {
    pack: null,
    runtime: {
      found: false,
      problem:
        candidates.length > 0
          ? `No valid pipeline pack in ${runtimeDir}: each one needs manifest.json and its Python.`
          : `No pipeline pack in ${runtimeDir}. Build one with node tools/pipeline-pack/build.mjs or copy one there.`,
    },
  };
}
