import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import {
  SRC_TILE,
  resampleBilinear,
  tileToSource,
  windowTiles,
  zOrder,
  type Affine2,
  type PyramidLevel,
  type PyramidPlan,
  type RgbaImage,
} from './ringroad-tiles';
import type { PackageWriter } from './writer';

export interface OrthoBuildOptions {
  /** Source Web Mercator tiles (256 px WebP) keyed `z/x/y`. */
  tiles: ReadonlyMap<string, Uint8Array>;
  plan: PyramidPlan;
  /** Project CRS (E, N) to lon/lat. */
  toLonLat: (e: number, n: number) => [number, number];
  w: PackageWriter;
  /** WebP quality (default 82). */
  quality?: number;
  /** Colour under no-data pixels (alpha 0); the 3D view draws tiles opaque. */
  fill?: readonly [number, number, number];
  /** Fingerprint of the source; when it matches the last run, existing tiles are kept. */
  stamp?: string;
  log?: (msg: string) => void;
}

export interface OrthoLevelStats {
  z: number;
  srcZoom: number;
  tiles: number;
  bytes: number;
}

export interface OrthoBuildResult {
  levels: OrthoLevelStats[];
  /** Largest per-tile affine miss (source px). */
  maxErrPx: number;
  reused: boolean;
}

interface Stamp {
  stamp: string;
  maxErrPx: number;
  tiles: Record<string, string[]>;
}

const tileRel = (level: PyramidLevel, x: number, y: number) =>
  level.pattern.replace('{z}', String(level.z)).replace('{x}', String(x)).replace('{y}', String(y));

function invert(m: Affine2): (x: number, y: number) => [number, number] {
  const det = m.a * m.e - m.b * m.d;
  return (x, y) => {
    const dx = x - m.c;
    const dy = y - m.f;
    return [(m.e * dx - m.b * dy) / det, (-m.d * dx + m.a * dy) / det];
  };
}

/** Output tiles of a level that may hold source pixels (a one tile margin, checked later). */
function candidates(
  o: OrthoBuildOptions,
  level: PyramidLevel,
  srcKeys: readonly [number, number][],
): [number, number][] {
  const whole = { ...level, tileSize: level.tileSize * level.cols };
  const toOut = invert(tileToSource(o.plan, whole, 0, 0, o.toLonLat));
  const out = new Set<string>();
  for (const [sx, sy] of srcKeys) {
    const us: number[] = [];
    const vs: number[] = [];
    for (const [cx, cy] of [
      [sx, sy],
      [sx + 1, sy],
      [sx, sy + 1],
      [sx + 1, sy + 1],
    ] as const) {
      const [u, v] = toOut(cx * SRC_TILE, cy * SRC_TILE);
      us.push(u / level.tileSize);
      vs.push(v / level.tileSize);
    }
    const x0 = Math.max(0, Math.floor(Math.min(...us)) - 1);
    const x1 = Math.min(level.cols - 1, Math.floor(Math.max(...us)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(...vs)) - 1);
    const y1 = Math.min(level.rows - 1, Math.floor(Math.max(...vs)) + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.add(`${x},${y}`);
  }
  return zOrder([...out].map((k) => k.split(',').map(Number) as [number, number]));
}

/** Decoded source tiles, least recently used dropped first. */
class TileCache {
  private readonly map = new Map<string, Promise<Uint8Array>>();
  constructor(
    private readonly tiles: ReadonlyMap<string, Uint8Array>,
    private readonly max = 1024,
  ) {}

  get(key: string): Promise<Uint8Array> | null {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const webp = this.tiles.get(key);
    if (!webp) return null;
    const p = sharp(webp)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => {
        if (info.width !== SRC_TILE || info.height !== SRC_TILE || info.channels !== 4)
          throw new Error(`Source tile ${key} is ${info.width} x ${info.height}, not 256 x 256`);
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      });
    this.map.set(key, p);
    while (this.map.size > this.max) {
      const old = this.map.keys().next().value;
      if (old === undefined) break;
      this.map.delete(old);
    }
    return p;
  }
}

/**
 * Resample a Web Mercator tile pyramid into the plan's local-frame pyramid: every output tile
 * gets its own affine to the source zoom of its level (`tileToSource`), bilinear on premultiplied
 * colour. Tiles with no source pixel are not written.
 */
export async function buildOrthoPyramid(o: OrthoBuildOptions): Promise<OrthoBuildResult> {
  const first = o.plan.levels[0];
  if (!first) throw new Error('Pyramid plan has no levels');
  const stampRel = `${dirname(dirname(first.pattern)).replace(/\\/g, '/')}/source.json`;
  const fill = o.fill ?? [20, 29, 45];
  const quality = o.quality ?? 82;
  const log = o.log ?? (() => undefined);

  const prev = existsSync(o.w.abs(stampRel))
    ? (JSON.parse(readFileSync(o.w.abs(stampRel), 'utf8')) as Stamp)
    : null;
  if (o.stamp && prev?.stamp === o.stamp) {
    const kept = o.plan.levels.every((l) =>
      (prev.tiles[String(l.z)] ?? []).every((k) => {
        const [x, y] = k.split('_').map(Number) as [number, number];
        return existsSync(o.w.abs(tileRel(l, x, y)));
      }),
    );
    if (kept) {
      const levels = o.plan.levels.map((l) => {
        const names = prev.tiles[String(l.z)] ?? [];
        let bytes = 0;
        for (const k of names) {
          const [x, y] = k.split('_').map(Number) as [number, number];
          o.w.keep(tileRel(l, x, y));
          bytes += statSync(o.w.abs(tileRel(l, x, y))).size;
        }
        return { z: l.z, srcZoom: l.srcZoom, tiles: names.length, bytes };
      });
      o.w.writeJson(stampRel, prev);
      return { levels, maxErrPx: prev.maxErrPx, reused: true };
    }
  }

  const byZoom = new Map<number, [number, number][]>();
  for (const k of o.tiles.keys()) {
    const [z, x, y] = k.split('/').map(Number) as [number, number, number];
    const list = byZoom.get(z) ?? [];
    list.push([x, y]);
    byZoom.set(z, list);
  }

  const cache = new TileCache(o.tiles);
  const stamp: Stamp = { stamp: o.stamp ?? '', maxErrPx: 0, tiles: {} };
  const levels: OrthoLevelStats[] = [];
  for (const level of o.plan.levels) {
    const t0 = Date.now();
    const names: string[] = [];
    const stats: OrthoLevelStats = { z: level.z, srcZoom: level.srcZoom, tiles: 0, bytes: 0 };
    const pending = new Set<Promise<void>>();
    const cands = candidates(o, level, byZoom.get(level.srcZoom) ?? []);
    for (const [tx, ty] of cands) {
      const m = tileToSource(o.plan, level, tx, ty, o.toLonLat);
      stamp.maxErrPx = Math.max(stamp.maxErrPx, m.err);
      const win = windowTiles(m, level.tileSize);
      const parts: { x: number; y: number; p: Promise<Uint8Array> }[] = [];
      for (let y = win.y0; y < win.y1; y++)
        for (let x = win.x0; x < win.x1; x++) {
          const p = cache.get(`${level.srcZoom}/${x}/${y}`);
          if (p) parts.push({ x, y, p });
        }
      if (!parts.length) continue;
      const width = (win.x1 - win.x0) * SRC_TILE;
      const height = (win.y1 - win.y0) * SRC_TILE;
      const img: RgbaImage = { data: new Uint8Array(width * height * 4), width, height };
      const decoded = await Promise.all(parts.map((p) => p.p));
      parts.forEach((part, i) => {
        const src = decoded[i];
        if (!src) return;
        const ox = (part.x - win.x0) * SRC_TILE;
        const oy = (part.y - win.y0) * SRC_TILE;
        for (let r = 0; r < SRC_TILE; r++) {
          img.data.set(
            src.subarray(r * SRC_TILE * 4, (r + 1) * SRC_TILE * 4),
            ((oy + r) * width + ox) * 4,
          );
        }
      });
      const local: Affine2 = {
        ...m,
        c: m.c - win.x0 * SRC_TILE,
        f: m.f - win.y0 * SRC_TILE,
      };
      const size = level.tileSize;
      const out = resampleBilinear(img, local, size, fill);
      if (out.covered === 0) continue;
      const rel = tileRel(level, tx, ty);
      names.push(`${tx}_${ty}`);
      const raw = sharp(Buffer.from(out.data.buffer), {
        raw: { width: size, height: size, channels: 4 },
      });
      const job: Promise<void> = (out.covered === size * size ? raw.removeAlpha() : raw)
        .webp({ quality, alphaQuality: 90, effort: 4 })
        .toBuffer()
        .then((buf) => {
          o.w.write(rel, buf);
          stats.tiles++;
          stats.bytes += buf.length;
        })
        .finally(() => pending.delete(job));
      pending.add(job);
      if (pending.size >= 8) await Promise.race(pending);
    }
    await Promise.all(pending);
    names.sort();
    stamp.tiles[String(level.z)] = names;
    levels.push(stats);
    log(
      `ortho level ${level.z} (source z${level.srcZoom}): ${stats.tiles} tiles of ${cands.length} candidates in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
  }
  o.w.writeJson(stampRel, stamp);
  return { levels, maxErrPx: stamp.maxErrPx, reused: false };
}
