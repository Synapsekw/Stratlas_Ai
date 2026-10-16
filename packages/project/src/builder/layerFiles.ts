import type { Layer, LayerInfo, OrientationFile, ProjectManifest, Vec3 } from '@aio/schema';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fullLayerExtent } from './extents';
import { layerRefs } from './removePlan';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** True for a project-relative ref that stays inside the project (no drive, no `..`). */
export function insideRef(p: string): boolean {
  return p !== '' && !isAbsolute(p) && !/^[a-zA-Z]:/.test(p) && !p.split('/').includes('..');
}

/** True when `target` lies below `base`. */
const within = (base: string, target: string): boolean => {
  const r = relative(base, target);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/** True when every file ref of the layer stays inside the project. */
export function refsInside(l: Layer): boolean {
  return layerRefs(l).every(insideRef);
}

/** A folder name Windows accepts for a layer name. */
export function layerFolderName(name: string): string {
  let s = Array.from(name, (c) => (/[<>:"/\\|?*]/.test(c) || c.charCodeAt(0) < 32 ? '_' : c)).join(
    '',
  );
  s = s.slice(0, 100).replace(/[. ]+$/, '');
  if (s === '') return 'dataset';
  return RESERVED.test(s) ? `${s}_` : s;
}

/** Layers whose files are in the local frame, which need the CRS sidecar to be placed elsewhere. */
export function isLocalFrame(l: Layer): boolean {
  if (l.kind === 'pointcloud') return l.format !== 'copc';
  if (l.kind === 'raster') return l.corners !== undefined;
  return l.kind === 'mesh' || l.kind === 'photos' || l.kind === 'panoramas' || l.kind === 'walk';
}

const commonDir = (paths: readonly string[]): string => {
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  const first = parts[0] ?? [];
  let n = 0;
  while (n < first.length && parts.every((q) => q[n] === first[n])) n++;
  return first.slice(0, n).join('/');
};

/** Each file of a layer and where it goes inside the layer's export folder. */
export function exportPlan(l: Layer): { from: string; to: string }[] {
  const refs = layerRefs(l);
  const base = commonDir(refs);
  return refs.map((from) => ({ from, to: base ? from.slice(base.length + 1) : from }));
}

/** The file Reveal in folder shows: the layer's first file (a walk's playback copy). */
export function mainFile(l: Layer): string | null {
  if (l.kind === 'walk' && 'path' in l.src) return l.src.path;
  return layerRefs(l)[0] ?? null;
}

export function crsSidecar(m: ProjectManifest, l: Layer): Record<string, unknown> | null {
  if (!isLocalFrame(l)) return null;
  return {
    schema: 'aio.layer-crs/1',
    crs: m.crs,
    origin: m.origin,
    frame: 'local metres from origin: x east, y up, z south',
    ...(l.kind === 'mesh' ? { transform: l.transform } : {}),
    ...(l.kind === 'raster' && l.corners ? { corners: l.corners } : {}),
  };
}

const sizeOf = async (file: string) => {
  try {
    const s = await stat(file);
    return { bytes: s.size, born: s.birthtime };
  } catch {
    return null;
  }
};

/**
 * A walk lies where its placed path does: the positions of its pose file (local frame). Its pins
 * are never read (drawing pins are plan pixels). Null while the walk is not placed or the file
 * cannot be read.
 */
async function walkExtent(root: string, l: Layer): Promise<{ min: Vec3; max: Vec3 } | null> {
  if (l.kind !== 'walk' || !l.flight || !('path' in l.flight.src)) return null;
  try {
    const j = JSON.parse(await readFile(join(root, l.flight.src.path), 'utf8')) as {
      samples?: { pos?: unknown }[];
    };
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let n = 0;
    for (const s of j.samples ?? []) {
      const p = s.pos;
      if (!Array.isArray(p) || p.length < 3) continue;
      const v = p.slice(0, 3) as unknown[];
      if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
      for (const k of [0, 1, 2] as const) {
        const x = v[k] as number;
        min[k] = Math.min(min[k], x);
        max[k] = Math.max(max[k], x);
      }
      n++;
    }
    return n > 0 ? { min, max } : null;
  } catch {
    return null;
  }
}

export async function readLayerInfo(
  root: string,
  m: ProjectManifest,
  l: Layer,
  orientation: OrientationFile | null,
): Promise<LayerInfo> {
  const refs = layerRefs(l);
  // a ref that leaves the project is listed but never read
  const sizes = await Promise.all(
    refs.map((p) => (insideRef(p) ? sizeOf(join(root, p)) : Promise.resolve(null))),
  );
  const known = sizes.filter((s) => s !== null);
  const main = mainFile(l);
  const mainStat = main && insideRef(main) ? await sizeOf(join(root, main)) : null;
  const inside = refsInside(l);
  const count =
    l.kind === 'photos' || l.kind === 'panoramas'
      ? l.items.length
      : l.kind === 'pointcloud'
        ? (l.pointCount ?? null)
        : null;
  return {
    layerId: l.id,
    name: l.name,
    kind: l.kind,
    files: refs.map((path, i) => ({ path, bytes: sizes[i]?.bytes ?? null })),
    bytes: known.length > 0 ? known.reduce((a, s) => a + s.bytes, 0) : null,
    count,
    countKind: count === null ? null : l.kind === 'pointcloud' ? 'points' : 'items',
    extent: !inside
      ? null
      : l.kind === 'walk'
        ? await walkExtent(root, l)
        : await fullLayerExtent(root, m, l, orientation),
    crs: m.crs,
    importedAt: mainStat ? mainStat.born.toISOString() : null,
    mainFile: main,
  };
}

export async function exportLayers(
  root: string,
  m: ProjectManifest,
  layerIds: readonly string[],
  dir: string,
  o: { signal?: AbortSignal; progress?: (done: number, total: number, file: string) => void } = {},
): Promise<{ written: number; skipped: string[]; cancelled: boolean }> {
  const skipped: string[] = [];
  const plans: {
    l: Layer;
    files: { from: string; to: string }[];
    side: Record<string, unknown> | null;
  }[] = [];
  for (const id of layerIds) {
    const l = m.layers.find((x) => x.id === id);
    if (!l) skipped.push(id);
    else if (!refsInside(l)) skipped.push(l.name);
    else plans.push({ l, files: exportPlan(l), side: crsSidecar(m, l) });
  }
  const total = plans.reduce((n, p) => n + p.files.length + (p.side ? 1 : 0), 0);
  const used = new Set<string>();
  let done = 0;
  let written = 0;
  await mkdir(dir, { recursive: true });
  for (const { l, files, side } of plans) {
    let name = layerFolderName(l.name);
    if (used.has(name.toLowerCase())) {
      const suffix = ` (${l.id})`;
      name = layerFolderName(l.name.slice(0, Math.max(1, 100 - suffix.length)) + suffix);
    }
    used.add(name.toLowerCase());
    const folder = join(dir, name);
    if (!within(dir, folder)) {
      skipped.push(l.name);
      continue;
    }
    try {
      await mkdir(folder);
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'EEXIST') throw e;
      skipped.push(l.name);
      done += files.length + (side ? 1 : 0);
      continue;
    }
    try {
      for (const f of files) {
        if (o.signal?.aborted) throw new Error('cancelled');
        const from = join(root, ...f.from.split('/'));
        const to = join(folder, ...f.to.split('/'));
        if (!within(root, from) || !within(folder, to))
          throw new Error('A file leaves its folder.');
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to, constants.COPYFILE_EXCL);
        o.progress?.(++done, total, f.to);
      }
      if (side) {
        if (o.signal?.aborted) throw new Error('cancelled');
        await writeFile(join(folder, `${name}.crs.json`), `${JSON.stringify(side, null, 2)}\n`, {
          flag: 'wx',
        });
        o.progress?.(++done, total, `${name}.crs.json`);
      }
      written++;
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      if (o.signal?.aborted) return { written, skipped, cancelled: true };
      throw e;
    }
  }
  return { written, skipped, cancelled: false };
}
