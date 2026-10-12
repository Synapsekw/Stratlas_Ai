/**
 * A synthetic 3D Tiles 1.1 quadtree for the performance specs (M10 D7): `depth` levels of the
 * same glTF mesh, each tile a copy of it scaled into its quadrant, `REPLACE` refinement and the
 * geometric error halving per level. Depth 4 gives 1 + 4 + 16 + 64 = 85 tiles.
 *
 * The tileset frame is z up (3DTilesRendererJS turns glTF y up into it); the entry's `transform`
 * (`QUADTREE_TO_LOCAL`) turns it into the project local frame (y up), centred on the origin, so no
 * CRS is involved. The mesh is assumed to span `MESH_SPAN` metres centred on its origin, as
 * `gridGlb` does.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The edge of the `gridGlb` mesh in metres (its quads span -30 to 30 m). */
const MESH_SPAN = 60;

/** Tileset frame (x east, y north, z up) to the project local frame (x east, y up, z south). */
export const QUADTREE_TO_LOCAL = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

interface Placed {
  scale: number;
  cx: number;
  cy: number;
}

/** The number of triangles in one copy of a `gridGlb(quads)` mesh. */
export const gridTriangles = (quads = 80): number => 2 * quads * quads;

export async function writeQuadtreeTileset(
  dir: string,
  o: { depth: number; glb: Buffer; halfM: number; triangles?: number },
): Promise<{ tiles: number; bytes: number; triangles: number; leaves: number }> {
  const perTile = o.triangles ?? gridTriangles();
  let tiles = 0;
  let bytes = 0;
  const files: Promise<void>[] = [];
  const dirs = new Set<string>();

  const tile = (level: number, x: number, y: number, parent: Placed | null): object => {
    const n = 2 ** level;
    const size = (2 * o.halfM) / n;
    const me: Placed = {
      scale: size / MESH_SPAN,
      cx: -o.halfM + size * (x + 0.5),
      cy: -o.halfM + size * (y + 0.5),
    };
    // a tile transform is relative to its parent's: the parent's scale and centre come off
    const rel = parent
      ? {
          s: me.scale / parent.scale,
          tx: (me.cx - parent.cx) / parent.scale,
          ty: (me.cy - parent.cy) / parent.scale,
        }
      : { s: me.scale, tx: me.cx, ty: me.cy };
    const uri = `t/${String(level)}/${String(x)}_${String(y)}.glb`;
    const folder = join(dir, 't', String(level));
    if (!dirs.has(folder)) {
      dirs.add(folder);
      files.push(mkdir(folder, { recursive: true }).then(() => undefined));
    }
    tiles += 1;
    bytes += o.glb.length;
    const children =
      level + 1 < o.depth
        ? [0, 1].flatMap((j) => [0, 1].map((i) => tile(level + 1, 2 * x + i, 2 * y + j, me)))
        : [];
    return {
      transform: [rel.s, 0, 0, 0, 0, rel.s, 0, 0, 0, 0, rel.s, 0, rel.tx, rel.ty, 0, 1],
      // in the tile's own frame (before its transform): the mesh, 2 m up with a small wave
      boundingVolume: {
        box: [0, 0, 2, MESH_SPAN / 2, 0, 0, 0, MESH_SPAN / 2, 0, 0, 0, 1],
      },
      geometricError: level + 1 < o.depth ? (2 * o.halfM) / 2 ** (level + 3) : 0,
      refine: 'REPLACE',
      content: { uri },
      ...(children.length > 0 ? { children } : {}),
    };
  };

  const root = tile(0, 0, 0, null);
  const tileset = {
    asset: { version: '1.1', generator: 'Stratlas e2e quadtree' },
    geometricError: o.halfM,
    root,
  };
  // write the tile files once their folders exist
  await Promise.all(files);
  const writes: Promise<void>[] = [];
  for (let level = 0; level < o.depth; level++) {
    const n = 2 ** level;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        writes.push(
          writeFile(join(dir, 't', String(level), `${String(x)}_${String(y)}.glb`), o.glb),
        );
  }
  await Promise.all(writes);
  await writeFile(join(dir, 'tileset.json'), JSON.stringify(tileset));
  const leaves = 4 ** (o.depth - 1);
  return { tiles, bytes, triangles: tiles * perTile, leaves };
}
