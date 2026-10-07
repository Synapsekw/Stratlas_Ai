import { z } from 'zod';
import { Id, IsoTime, Mat4, ProjectPath } from './common';
import { PhotoRunId } from './photogrammetry';

/**
 * 3D Tiles of a project (M10 G7, decision 3): large processed meshes and clouds streamed in the
 * site view (3DTilesRendererJS) and on the Globe (CesiumJS). Listed in `<project>/tilesets.json`
 * (`aio.tilesets/1`), a file older builds ignore, so no layer kind is added (data-conventions
 * section 22). Tiles are standard 3D Tiles 1.1 in `<project>/tiles/<id>/`.
 */

/** A tileset id: file-name safe, the folder name under `tiles/`. */
export const TilesetId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'A tileset id is letters, digits, dot, dash or _.');

export const TILESETS_FILE = 'tilesets.json';
export const TILES_DIR = 'tiles';

export const TilesetKind = z.enum(['mesh', 'points', 'terrain', 'imported']);

export const TilesetEntry = z.looseObject({
  id: TilesetId,
  name: z.string().min(1).max(200),
  kind: TilesetKind,
  /** The root `tileset.json`, relative to the project (normally `tiles/<id>/tileset.json`). */
  src: ProjectPath,
  /** The layer it was made from (`tiles.mesh` of a mesh layer, `tiles.cloud` of a COPC layer). */
  from: Id.optional(),
  /** The photogrammetry run that made it. */
  run: PhotoRunId.optional(),
  /** Survey date (manifest capture id). */
  capture: Id.optional(),
  visible: z.boolean(),
  /**
   * Column-major 4x4 from the tileset's frame to the project local frame, applied after the
   * tileset's own root transform. Absent: the tileset is already in the project frame (ours are
   * written in ECEF with a root transform, and the app places them through the project CRS).
   */
  transform: Mat4.optional(),
  /** Imported tilesets: the placement a person confirmed on the map. */
  confirmedAt: IsoTime.optional(),
  /** Attribution to show with the tiles (imported tilesets from other software). */
  attribution: z.string().max(500).optional(),
});

/** `<project>/tilesets.json` (`aio.tilesets/1`). Written by the app (`tilesets:write`, `.bak`). */
export const TilesetsFile = z
  .looseObject({
    schema: z.literal('aio.tilesets/1'),
    entries: z.array(TilesetEntry).max(500),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const e of f.entries) {
      if (seen.has(e.id))
        ctx.addIssue({ code: 'custom', message: `Duplicate tileset "${e.id}"`, path: ['entries'] });
      seen.add(e.id);
    }
  });

/** A project without `tilesets.json` has no tilesets. */
export const emptyTilesets = (): TilesetsFile => ({ schema: 'aio.tilesets/1', entries: [] });

export type TilesetId = z.infer<typeof TilesetId>;
export type TilesetKind = z.infer<typeof TilesetKind>;
export type TilesetEntry = z.infer<typeof TilesetEntry>;
export type TilesetsFile = z.infer<typeof TilesetsFile>;
