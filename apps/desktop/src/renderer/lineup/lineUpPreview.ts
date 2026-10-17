import type { ProjectManifest } from '@aio/schema';
import type { Box } from '../shell/layerBounds';
import type { LineUpPreview } from './lineUpStore';

/**
 * The preview of the line-up step: a kit-pyramid ortho's coarse level (the one the 3D view keeps
 * resident), stitched into one image over the layer's box as placed now. No raster is read here
 * beyond the tiles the view itself loads. Other formats have no overview this cheap: no preview.
 */

/** A coarse level this small is a handful of tiles; a finer one is not an overview. */
const MAX_TILES = 16;

interface Level {
  z: number;
  tileSize: number;
  cols: number;
  rows: number;
  pattern: string;
}

export interface PreviewDeps {
  manifest: () => ProjectManifest | undefined;
  /** Each layer's box in the local frame, as placed now. */
  extents: () => Promise<Record<string, Box>>;
  /** A JSON file of the open project, by project-relative path. */
  readJson: (path: string) => Promise<unknown>;
  /** One tile image, by project-relative path (null when it cannot be loaded). */
  loadTile: (path: string) => Promise<CanvasImageSource | null>;
  /** The tiles drawn side by side (row by row) into one image. */
  stitch: (level: Level, tiles: readonly (CanvasImageSource | null)[]) => CanvasImageSource;
}

const isLevel = (l: unknown): l is Level => {
  const v = l as Partial<Level> | null;
  return (
    typeof v?.z === 'number' &&
    typeof v.tileSize === 'number' &&
    typeof v.cols === 'number' &&
    typeof v.rows === 'number' &&
    typeof v.pattern === 'string' &&
    v.cols > 0 &&
    v.rows > 0
  );
};

/** The first (coarsest) level that is a handful of tiles, from a `tiles.json` (aio.tiles/1). */
export function overviewLevel(index: unknown): Level | null {
  const levels = (index as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(levels)) return null;
  return (
    levels
      .filter(isLevel)
      .sort((a, b) => a.z - b.z)
      .find((l) => l.cols * l.rows <= MAX_TILES) ?? null
  );
}

export function createLineUpPreview(deps: PreviewDeps): LineUpPreview {
  return async (layerId) => {
    const layer = deps.manifest()?.layers.find((l) => l.id === layerId);
    if (layer?.kind !== 'raster' || layer.format !== 'kit-pyramid' || !('path' in layer.src))
      return null;
    const [extents, index] = await Promise.all([deps.extents(), deps.readJson(layer.src.path)]);
    const box = extents[layerId];
    const level = overviewLevel(index);
    if (!box || !level) return null;
    const tiles = await Promise.all(
      Array.from({ length: level.cols * level.rows }, (_, i) =>
        deps.loadTile(
          level.pattern
            .replace('{z}', String(level.z))
            .replace('{x}', String(i % level.cols))
            .replace('{y}', String(Math.floor(i / level.cols))),
        ),
      ),
    );
    if (tiles.every((t) => t === null)) return null;
    return {
      image: deps.stitch(level, tiles),
      box: { minX: box.min[0], maxX: box.max[0], minZ: box.min[2], maxZ: box.max[2] },
    };
  };
}
