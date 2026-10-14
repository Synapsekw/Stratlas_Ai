import { IDENTITY, fromWgs84, placeZUp, projectToLocal, toWgs84, type UpAxis } from '@aio/geo';
import type { Mat4, Vec3 } from '@aio/schema';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ObjBounds } from './obj';
import { epsgFromPrj } from './tiff';

/**
 * Where an imported OBJ goes (data-conventions section 1): a Pix4D export (its offset file two
 * folders up) and a model in map grid coordinates are Z up and placed through the layer
 * transform; anything else is taken as Y up and placed by hand (Align, Georeference model).
 */

/** Map grid coordinates: the vertices' centre at least this far from 0 in x or y (metres). */
const GRID_M = 10_000;

export interface Pix4dOffset {
  offset: Vec3;
  file: string;
  /** EPSG of a `.prj` beside the offset file, when there is one. */
  epsg?: number;
}

export interface ObjPlacement {
  up: UpAxis;
  transform: Mat4;
  /** What the import message says about the placement; null for a model placed by hand. */
  note: string | null;
  warnings: string[];
}

/** Pix4D's `<project>_offset.xyz`: "E N H" that the mesh vertices are relative to. */
export function parseOffsetXyz(text: string): Vec3 | null {
  const n = text.trim().split(/\s+/).map(Number);
  if (n.length !== 3 || n.some((v) => !Number.isFinite(v))) return null;
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
}

/**
 * The offset of the Pix4D project an OBJ belongs to: the mesh in
 * `<project>/2_densification/3d_mesh/`, the offset in `<project>/1_initial/params/*_offset.xyz`.
 */
export async function findPix4dOffset(objPath: string): Promise<Pix4dOffset | null> {
  const meshDir = dirname(objPath);
  if (basename(meshDir).toLowerCase() !== '3d_mesh') return null;
  if (basename(dirname(meshDir)).toLowerCase() !== '2_densification') return null;
  const params = join(dirname(dirname(meshDir)), '1_initial', 'params');
  let names: string[];
  try {
    names = await readdir(params);
  } catch {
    return null;
  }
  const file = names.filter((n) => n.toLowerCase().endsWith('_offset.xyz')).sort()[0];
  if (!file) return null;
  const offset = parseOffsetXyz(await readFile(join(params, file), 'utf8'));
  if (!offset) return null;
  const prj = names.find((n) => n.toLowerCase().endsWith('.prj'));
  const epsg = prj ? epsgFromPrj(await readFile(join(params, prj), 'utf8')) : undefined;
  return { offset, file, ...(epsg !== undefined ? { epsg } : {}) };
}

export function looksProjected(b: ObjBounds): boolean {
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  return Math.max(Math.abs(cx), Math.abs(cy)) >= GRID_M;
}

/** What `objToGlb` takes off the vertices: the rounded centre of map grid coordinates, else 0. */
export function objShift(pix4d: Pix4dOffset | null, b: ObjBounds): Vec3 {
  if (pix4d || !looksProjected(b)) return [0, 0, 0];
  const r = (lo: number, hi: number) => Math.round((lo + hi) / 2);
  return [r(b.min[0], b.max[0]), r(b.min[1], b.max[1]), r(b.min[2], b.max[2])];
}

export function objPlacement(o: {
  pix4d: Pix4dOffset | null;
  bounds: ObjBounds;
  shift: Vec3;
  origin: Vec3;
  epsg: number;
}): ObjPlacement {
  if (o.pix4d) {
    const warnings: string[] = [];
    let at = o.pix4d.offset;
    if (o.pix4d.epsg !== undefined && o.pix4d.epsg !== o.epsg) {
      const p = fromWgs84(toWgs84(at, o.pix4d.epsg), o.epsg);
      at = [p[0], p[1], at[2]];
      warnings.push(
        `The export is in EPSG:${String(o.pix4d.epsg)}, the project in EPSG:${String(o.epsg)}: its offset was converted; the turn between the two grids is not applied.`,
      );
    }
    return {
      up: 'z',
      transform: placeZUp(projectToLocal(at, o.origin)),
      note: `Pix4D export: stood upright (Z up) and placed by ${o.pix4d.file}.`,
      warnings,
    };
  }
  if (looksProjected(o.bounds))
    return {
      up: 'z',
      transform: placeZUp(projectToLocal(o.shift, o.origin)),
      note: 'Map grid coordinates: stood upright (Z up) and placed in the project CRS.',
      warnings: [],
    };
  return { up: 'y', transform: [...IDENTITY], note: null, warnings: [] };
}
