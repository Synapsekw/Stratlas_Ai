import type { Vec3 } from '@aio/schema';
import { quantFromBounds, type Bounds3, type Quantisation } from './decode';

export interface PngChunkInfo {
  /** Stable key within the cloud (the file as written in the index). */
  id: string;
  /** Where to fetch the PNG (see README: package-relative for aio.pngcloud/1, index-relative for legacy). */
  file: string;
  points: number;
  /** Tight bounds used for LOD distance. */
  bounds: Bounds3;
  /** 0 = coarse overview, always shown; higher = finer, additive refinement. */
  lod: number;
  quant: Quantisation;
}

export interface PngCloudIndex {
  /** True for the Al-Zour artifact `pc.json` (`levels` format). */
  legacy: boolean;
  bounds: Bounds3;
  /** Typical point spacing of the full cloud in metres, if the index states it. */
  spacing?: number;
  chunks: PngChunkInfo[];
  totalPoints: number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isTile = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(isNum);
const isBounds = (v: unknown): v is Bounds3 => isRec(v) && isVec3(v.min) && isVec3(v.max);

function union(boxes: readonly Bounds3[]): Bounds3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] ?? Infinity, b.min[a] ?? Infinity);
      max[a] = Math.max(max[a] ?? -Infinity, b.max[a] ?? -Infinity);
    }
  }
  return boxes.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

function parseAio(j: Rec): PngCloudIndex {
  if (!Array.isArray(j.chunks)) throw new Error('png-packed index: "chunks" must be an array');
  const chunks = j.chunks.map((c: unknown, i): PngChunkInfo => {
    if (!isRec(c) || typeof c.file !== 'string' || !isNum(c.points) || !isBounds(c.bounds)) {
      throw new Error(`png-packed index: chunk ${i} needs file, points and bounds`);
    }
    let quant = quantFromBounds(c.bounds);
    if (isRec(c.quant) && isVec3(c.quant.offset)) {
      const s = c.quant.scale;
      if (isNum(s)) quant = { offset: c.quant.offset, scale: [s, s, s] };
      else if (isVec3(s)) quant = { offset: c.quant.offset, scale: s };
    }
    return {
      id: c.file,
      file: c.file,
      points: c.points,
      bounds: c.bounds,
      lod: isNum(c.lod) ? c.lod : 0,
      quant,
    };
  });
  const out: PngCloudIndex = {
    legacy: false,
    bounds: isBounds(j.bounds) ? j.bounds : union(chunks.map((c) => c.bounds)),
    chunks,
    totalPoints: chunks.reduce((s, c) => s + c.points, 0),
  };
  if (isNum(j.spacing)) out.spacing = j.spacing;
  return out;
}

function parseLegacy(j: Rec & { levels: unknown[] }): PngCloudIndex {
  const urls = isRec(j.urls) ? j.urls : {};
  const chunks: PngChunkInfo[] = [];
  j.levels.forEach((level, lod) => {
    if (!Array.isArray(level)) throw new Error(`png-packed index: level ${lod} is not an array`);
    level.forEach((c: unknown, i) => {
      if (!isRec(c) || typeof c.f !== 'string' || !isNum(c.n) || !isVec3(c.o) || !isNum(c.q)) {
        throw new Error(`png-packed index: level ${lod} chunk ${i} needs f, n, o and q`);
      }
      const quant: Quantisation = { offset: c.o, scale: [c.q, c.q, c.q] };
      const span = 65535 * c.q;
      const b = c.b;
      // `b` is the 2D tile [minX, minZ, maxX, maxZ]; the height is unknown, so the box sits on o.y.
      const tile = isTile(b) ? b : null;
      const bounds: Bounds3 = tile
        ? { min: [tile[0], c.o[1], tile[1]], max: [tile[2], c.o[1], tile[3]] }
        : { min: [...c.o], max: [c.o[0] + span, c.o[1] + span, c.o[2] + span] };
      const mapped = urls[c.f];
      chunks.push({
        id: c.f,
        file: typeof mapped === 'string' ? mapped : c.f,
        points: c.n,
        bounds,
        lod,
        quant,
      });
    });
  });
  return {
    legacy: true,
    bounds: union(chunks.map((c) => c.bounds)),
    chunks,
    totalPoints: chunks.reduce((s, c) => s + c.points, 0),
  };
}

/** Parse a png-packed index: `aio.pngcloud/1` or the legacy Al-Zour artifact `pc.json`. */
export function parsePngCloudIndex(json: unknown): PngCloudIndex {
  if (isRec(json) && json.schema === 'aio.pngcloud/1') return parseAio(json);
  if (isRec(json) && Array.isArray(json.levels)) {
    return parseLegacy(json as Rec & { levels: unknown[] });
  }
  throw new Error('This file is not a png-packed cloud index (aio.pngcloud/1 or pc.json levels)');
}
