import { correctPos, fromWgs84, photoCorrection, projectToLocal } from '@aio/geo';
import { cloudFrameOrigin, shiftCorners, shiftedBox } from '@aio/schema';
import type { DateShift, Layer, OrientationFile, ProjectManifest, Vec3 } from '@aio/schema';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTiffGeo, tiffCorners } from './tiff';

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
  orientation: OrientationFile | null = null,
  shift: DateShift | null = null,
): Promise<LocalExtent | null> {
  try {
    if (l.kind === 'mesh' && 'path' in l.src) {
      const b = glbBounds(await glbJson(join(root, l.src.path)));
      return b ? shiftedBox(boxOf(corners(b).map((p) => applyMat4(l.transform, p))), shift) : null;
    }
    if (l.kind === 'pointcloud' && 'path' in l.src) {
      if (l.format === 'copc') {
        // COPC is in the project CRS (data-conventions section 4)
        const b = lasBounds(await readHead(join(root, l.src.path), 227));
        return b
          ? boxOf(
              corners(b).map((p) =>
                projectToLocal(
                  p,
                  cloudFrameOrigin(m.origin, { heightOffsetM: l.heightOffsetM ?? 0 }, shift),
                ),
              ),
            )
          : null;
      }
      if (l.format === 'png-packed') {
        const idx = JSON.parse(await readFile(join(root, l.src.path), 'utf8')) as {
          bounds?: LocalExtent;
        };
        const off = l.heightOffsetM ?? 0;
        const { bounds } = idx;
        if (!bounds) return null;
        return shiftedBox(
          {
            min: [bounds.min[0], bounds.min[1] + off, bounds.min[2]],
            max: [bounds.max[0], bounds.max[1] + off, bounds.max[2]],
          },
          shift,
        );
      }
      return null;
    }
    if (l.kind === 'photos')
      return shiftedBox(
        boxOf(
          l.items.flatMap((p) =>
            p.pos ? [correctPos(p.pos, photoCorrection(orientation, l.id, p.id))] : [],
          ),
        ),
        shift,
      );
    if (l.kind === 'raster' && l.corners) {
      const { tl, tr, bl } = shift ? shiftCorners(l.corners, shift) : l.corners;
      const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
      return boxOf([tl, tr, bl, br]);
    }
  } catch {
    // a file that cannot be read has no extent; the layer itself reports it
  }
  return null;
}

/**
 * The extent of every layer that has one, in manifest order. `full` reads every kind
 * `fullLayerExtent` reads (a kit pyramid's corners in its `tiles.json`, a COG, ...): the line-up
 * step needs each date's imagery; the far-content check leaves it off and sees the kinds it always saw.
 */
export async function layerExtents(
  root: string,
  m: ProjectManifest,
  orientation: OrientationFile | null = null,
  shifts: Readonly<Record<string, DateShift>> = {},
  opts: { full?: boolean } = {},
): Promise<{ layerId: string; min: Vec3; max: Vec3 }[]> {
  const out: { layerId: string; min: Vec3; max: Vec3 }[] = [];
  const extentOf = opts.full ? fullLayerExtent : layerExtent;
  for (const l of m.layers) {
    const e = await extentOf(root, m, l, orientation, shifts[l.id] ?? null);
    if (e) out.push({ layerId: l.id, ...e });
  }
  return out;
}

/** PMTiles v3 header bounds (degrees): min lon, min lat, max lon, max lat. */
export function pmtilesBounds(head: Uint8Array): [number, number, number, number] | null {
  if (
    head.length < 127 ||
    new TextDecoder().decode(head.subarray(0, 7)) !== 'PMTiles' ||
    head[7] !== 3
  )
    return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const d = (o: number) => v.getInt32(o, true) / 1e7;
  return [d(102), d(106), d(110), d(114)];
}

/** Every lon/lat pair of a GeoJSON object, in document order (heights dropped). */
export function geojsonLonLat(json: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) walk(x);
  };
  const visit = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    const g = o as {
      type?: string;
      coordinates?: unknown;
      features?: unknown[];
      geometry?: unknown;
      geometries?: unknown[];
    };
    if (Array.isArray(g.features)) for (const f of g.features) visit(f);
    if (g.geometry) visit(g.geometry);
    if (Array.isArray(g.geometries)) for (const x of g.geometries) visit(x);
    if (g.coordinates !== undefined) walk(g.coordinates);
  };
  visit(json);
  return out;
}

const epsgOf = (m: ProjectManifest) => ('epsg' in m.crs ? m.crs.epsg : null);

/**
 * The extent Properties and Zoom to show: what `layerExtent` reads, plus panoramas, kit pyramids,
 * GeoTIFFs in the project CRS, PMTiles and GeoJSON (walks: see `layer:info`). `layerExtents` does
 * not use it, so the far-content check sees the kinds it always saw.
 */
export async function fullLayerExtent(
  root: string,
  m: ProjectManifest,
  l: Layer,
  orientation: OrientationFile | null,
  shift: DateShift | null = null,
): Promise<LocalExtent | null> {
  const known = await layerExtent(root, m, l, orientation, shift);
  if (known) return known;
  return shiftedBox(await unshiftedExtent(root, m, l), shift);
}

/** The kinds `layerExtent` does not read, as stored (the caller adds the date shift). */
async function unshiftedExtent(
  root: string,
  m: ProjectManifest,
  l: Layer,
): Promise<LocalExtent | null> {
  const epsg = epsgOf(m);
  const fromLonLat = (pts: readonly [number, number][]) =>
    epsg === null
      ? null
      : boxOf(
          pts.map(([lon, lat]) =>
            projectToLocal(fromWgs84([lon, lat, m.origin[2]], epsg), m.origin),
          ),
        );
  try {
    if (l.kind === 'panoramas') return boxOf(l.items.flatMap((p) => (p.pos ? [p.pos] : [])));
    if (l.kind === 'vector' && 'path' in l.src)
      return fromLonLat(
        geojsonLonLat(JSON.parse(await readFile(join(root, l.src.path), 'utf8')) as unknown),
      );
    if (l.kind === 'raster' && 'path' in l.src) {
      const file = join(root, l.src.path);
      if (l.format === 'kit-pyramid') {
        const idx = JSON.parse(await readFile(file, 'utf8')) as {
          corners?: { tl: Vec3; tr: Vec3; bl: Vec3 };
        };
        if (!idx.corners) return null;
        const { tl, tr, bl } = idx.corners;
        return boxOf([
          tl,
          tr,
          bl,
          [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]],
        ]);
      }
      if (l.format === 'pmtiles') {
        const b = pmtilesBounds(await readHead(file, 127));
        return b
          ? fromLonLat([
              [b[0], b[1]],
              [b[2], b[3]],
            ])
          : null;
      }
      if (l.format === 'cog') {
        const t = readTiffGeo(await readHead(file, 64 * 1024));
        if (t.geo.epsg !== undefined && t.geo.epsg !== epsg) return null;
        const c = tiffCorners(t);
        const at = (p: [number, number]) => projectToLocal([p[0], p[1], m.origin[2]], m.origin);
        const br: [number, number] = [c.tr[0] + c.bl[0] - c.tl[0], c.tr[1] + c.bl[1] - c.tl[1]];
        return boxOf([at(c.tl), at(c.tr), at(c.bl), at(br)]);
      }
    }
  } catch {
    // a file that cannot be read has no extent
  }
  return null;
}
