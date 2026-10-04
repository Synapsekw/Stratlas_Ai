import type { Vec3 } from '@aio/schema';

/** A kit pyramid (`aio.tiles/1`, data-conventions section 5) as the map reads it. */
export interface PyramidIndex {
  levels: { z: number; tileSize: number; cols: number; rows: number; pattern: string }[];
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 };
}

/** A local-frame box on the ground (x east, z south). */
export interface GroundBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PyramidTile {
  key: string;
  z: number;
  x: number;
  y: number;
  path: string;
  /** Local corners of the tile, for the image quad. */
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 };
}

const sub = (a: Vec3, b: Vec3): [number, number] => [a[0] - b[0], a[2] - b[2]];

/** Ground size of one pixel of a level, metres (along the top edge). */
export function levelMetresPerPx(index: PyramidIndex, z: number): number {
  const level = index.levels.find((l) => l.z === z);
  if (!level) return Infinity;
  const [ux, uz] = sub(index.corners.tr, index.corners.tl);
  return Math.hypot(ux, uz) / (level.cols * level.tileSize);
}

export function tileUrlPath(pattern: string, z: number, x: number, y: number): string {
  return pattern.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** The point at fractions (u, v) of the placement (u along tl to tr, v along tl to bl). */
function at(c: PyramidIndex['corners'], u: number, v: number): Vec3 {
  const { tl, tr, bl } = c;
  return [
    tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v,
    tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v,
    tl[2] + (tr[2] - tl[2]) * u + (bl[2] - tl[2]) * v,
  ];
}

/**
 * The tiles to draw for a view: the coarsest level whose pixels are no larger than the screen's
 * (`metresPerScreenPx`), or the finest level when zoomed past it, stepping to coarser levels while
 * the view would need more than `maxTiles`. Null when the view misses the pyramid.
 */
export function pyramidView(
  index: PyramidIndex,
  view: GroundBox,
  metresPerScreenPx: number,
  maxTiles = 48,
): { z: number; tiles: PyramidTile[] } | null {
  const levels = [...index.levels].sort((a, b) => a.cols - b.cols);
  if (!levels.length) return null;
  const { tl } = index.corners;
  const [ux, uz] = sub(index.corners.tr, tl);
  const [vx, vz] = sub(index.corners.bl, tl);
  const det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-9) return null;
  // (u, v) placement fractions of the four view corners.
  const uv = (
    [
      [view.minX, view.minZ],
      [view.maxX, view.minZ],
      [view.maxX, view.maxZ],
      [view.minX, view.maxZ],
    ] as const
  ).map(([x, z]) => {
    const dx = x - tl[0];
    const dz = z - tl[2];
    return [(dx * vz - dz * vx) / det, (ux * dz - uz * dx) / det] as const;
  });
  const u0 = Math.max(0, Math.min(...uv.map((p) => p[0])));
  const u1 = Math.min(1, Math.max(...uv.map((p) => p[0])));
  const v0 = Math.max(0, Math.min(...uv.map((p) => p[1])));
  const v1 = Math.min(1, Math.max(...uv.map((p) => p[1])));
  if (u0 >= u1 || v0 >= v1) return null;

  let pick = levels.findIndex((l) => levelMetresPerPx(index, l.z) <= metresPerScreenPx * 1.001);
  if (pick < 0) pick = levels.length - 1;
  for (let i = pick; i >= 0; i--) {
    const level = levels[i];
    if (!level) continue;
    const x0 = Math.floor(u0 * level.cols);
    const x1 = Math.min(level.cols - 1, Math.floor(u1 * level.cols - 1e-9));
    const y0 = Math.floor(v0 * level.rows);
    const y1 = Math.min(level.rows - 1, Math.floor(v1 * level.rows - 1e-9));
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count > maxTiles && i > 0) continue;
    const tiles: PyramidTile[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const a = x / level.cols;
        const b = (x + 1) / level.cols;
        const c = y / level.rows;
        const d = (y + 1) / level.rows;
        tiles.push({
          key: `${level.z}/${x}/${y}`,
          z: level.z,
          x,
          y,
          path: tileUrlPath(level.pattern, level.z, x, y),
          corners: {
            tl: at(index.corners, a, c),
            tr: at(index.corners, b, c),
            bl: at(index.corners, a, d),
          },
        });
      }
    }
    return { z: level.z, tiles };
  }
  return null;
}
