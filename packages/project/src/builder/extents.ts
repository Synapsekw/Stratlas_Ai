import { projectToLocal } from '@aio/geo';
import type { Layer, ProjectManifest, Vec3 } from '@aio/schema';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const applyMat4 = (t: readonly number[], p: Vec3): Vec3 => {
  const e = (i: number) => t[i] ?? 0;
  return [
    e(0) * p[0] + e(4) * p[1] + e(8) * p[2] + e(12),
    e(1) * p[0] + e(5) * p[1] + e(9) * p[2] + e(13),
    e(2) * p[0] + e(6) * p[1] + e(10) * p[2] + e(14),
  ];
};

/**
 * Where a layer lies, read from its files: an axis-aligned box in the local frame
 * (data-conventions section 1). Used to notice data that lands far from the project origin.
 */
export interface LocalExtent {
  min: Vec3;
  max: Vec3;
}

function boxOf(points: readonly Vec3[]): LocalExtent | null {
  if (points.length === 0) return null;
  const axis = (k: 0 | 1 | 2) => points.map((p) => p[k]);
  const lo = (k: 0 | 1 | 2) => Math.min(...axis(k));
  const hi = (k: 0 | 1 | 2) => Math.max(...axis(k));
  return { min: [lo(0), lo(1), lo(2)], max: [hi(0), hi(1), hi(2)] };
}

function corners(b: LocalExtent): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const r = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, r.bytesRead);
  } finally {
    await fh.close();
  }
}

/** LAS public header bounds: max X at 179, min X 187, max Y 195, min Y 203, max Z 211, min Z 219. */
export function lasBounds(head: Uint8Array): LocalExtent | null {
  if (head.length < 227 || new TextDecoder().decode(head.subarray(0, 4)) !== 'LASF') return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const d = (o: number) => v.getFloat64(o, true);
  return { min: [d(187), d(203), d(219)], max: [d(179), d(195), d(211)] };
}

interface GltfJson {
  meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}

/** The POSITION accessors' bounds of a glTF (node transforms are not applied). */
export function glbBounds(json: unknown): LocalExtent | null {
  const j = json as GltfJson | null;
  const pts: Vec3[] = [];
  for (const m of j?.meshes ?? [])
    for (const p of m.primitives ?? []) {
      const a = j?.accessors?.[p.attributes?.POSITION ?? -1];
      if (a?.min && a.max && a.min.length >= 3 && a.max.length >= 3)
        pts.push(
          [a.min[0] ?? 0, a.min[1] ?? 0, a.min[2] ?? 0],
          [a.max[0] ?? 0, a.max[1] ?? 0, a.max[2] ?? 0],
        );
    }
  return boxOf(pts);
}

async function glbJson(file: string): Promise<unknown> {
  const head = await readHead(file, 20);
  if (head.length < 20) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  // 'glTF' magic, then the first chunk must be 'JSON'
  if (v.getUint32(0, true) !== 0x46546c67 || v.getUint32(16, true) !== 0x4e4f534a) return null;
  const all = await readHead(file, 20 + v.getUint32(12, true));
  return JSON.parse(new TextDecoder().decode(all.subarray(20))) as unknown;
}

/** One layer's extent in the local frame, or null when it has none (or its file cannot be read). */
export async function layerExtent(
  root: string,
  m: ProjectManifest,
  l: Layer,
): Promise<LocalExtent | null> {
  try {
    if (l.kind === 'mesh' && 'path' in l.src) {
      const b = glbBounds(await glbJson(join(root, l.src.path)));
      return b ? boxOf(corners(b).map((p) => applyMat4(l.transform, p))) : null;
    }
    if (l.kind === 'pointcloud' && 'path' in l.src) {
      if (l.format === 'copc') {
        // COPC is in the project CRS (data-conventions section 4)
        const b = lasBounds(await readHead(join(root, l.src.path), 227));
        return b ? boxOf(corners(b).map((p) => projectToLocal(p, m.origin))) : null;
      }
      if (l.format === 'png-packed') {
        const idx = JSON.parse(await readFile(join(root, l.src.path), 'utf8')) as {
          bounds?: LocalExtent;
        };
        return idx.bounds ?? null;
      }
      return null;
    }
    if (l.kind === 'photos') return boxOf(l.items.flatMap((p) => (p.pos ? [p.pos] : [])));
    if (l.kind === 'raster' && l.corners) {
      const { tl, tr, bl } = l.corners;
      const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
      return boxOf([tl, tr, bl, br]);
    }
  } catch {
    // a file that cannot be read has no extent; the layer itself reports it
  }
  return null;
}

/** The extent of every layer that has one, in manifest order. */
export async function layerExtents(
  root: string,
  m: ProjectManifest,
): Promise<{ layerId: string; min: Vec3; max: Vec3 }[]> {
  const out: { layerId: string; min: Vec3; max: Vec3 }[] = [];
  for (const l of m.layers) {
    const e = await layerExtent(root, m, l);
    if (e) out.push({ layerId: l.id, ...e });
  }
  return out;
}
