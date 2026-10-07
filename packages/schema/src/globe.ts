import { z } from 'zod';
import { LonLatRing } from './change';
import { Id, IsoDate, IsoTime } from './common';
import { TilesetId, TilesetKind } from './tilesets';

/**
 * The Globe (M10 G6, decision 3) and the imagery and terrain packs it shares with the map and the
 * site view (G7, decision 4). Everything is offline: packs live in `<data>/packs/imagery/` and
 * `<data>/packs/terrain/`, folders older builds never scan, so an 0.9 build never mistakes a raster
 * pack for a street map (data-conventions section 23). The street-map `MapPackInfo` is unchanged.
 */

/** A raster pack id, the file name of `<id>.pmtiles` and `<id>.json`. */
export const RasterPackId = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'A pack id is lower-case letters, digits and dashes.')
  .min(1)
  .max(48);

export const RasterPackKind = z.enum(['imagery', 'terrain']);
export const RASTER_PACK_DIRS = { imagery: 'packs/imagery', terrain: 'packs/terrain' } as const;

/** Heights of a terrain pack: Copernicus GLO-30 and NASADEM are EGM2008 and EGM96. */
export const TerrainDatum = z.enum(['egm2008', 'egm96', 'ellipsoid']);

const rasterPackFields = {
  id: RasterPackId,
  kind: RasterPackKind,
  label: z.string().min(1).max(120),
  /** West, south, east, north in WGS84 degrees. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  minZoom: z.number().int().min(0).max(24),
  maxZoom: z.number().int().min(0).max(24),
  tileSize: z.union([z.literal(256), z.literal(512)]),
  format: z.enum(['webp', 'png', 'jpeg']),
  /** Terrain only: Terrarium-encoded heights (decision 4; the precedent is Mapterhorn). */
  encoding: z.literal('terrarium').optional(),
  /** Terrain only: what the heights are measured from; the Globe adds the geoid separation. */
  verticalDatum: TerrainDatum.optional(),
  /** SPDX id (`CC-BY-4.0`), `public-domain`, or the customer's own licence words. */
  licence: z.string().min(1).max(200),
  /** Shown in the Globe, the map and every export that contains the data. */
  attribution: z.string().min(1).max(500),
  /** Where the data came from ("Copernicus Sentinel-2 Global Mosaic 2025 Q2"). */
  provenance: z.string().max(300).optional(),
  /**
   * Imported under the customer's own licence (decision 12): never redistributed by us, and left
   * out of `.aio` packages unless the person ticks it.
   */
  customerLicence: z.boolean(),
  builtAt: IsoTime,
};

const terrainRules = (
  p: { kind: 'imagery' | 'terrain'; encoding?: 'terrarium' | undefined; verticalDatum?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (p.kind === 'terrain' && (p.encoding === undefined || p.verticalDatum === undefined))
    ctx.addIssue({
      code: 'custom',
      message: 'A terrain pack names its encoding and vertical datum.',
      path: ['encoding'],
    });
  if (p.kind === 'imagery' && (p.encoding !== undefined || p.verticalDatum !== undefined))
    ctx.addIssue({
      code: 'custom',
      message: 'An imagery pack has no height encoding or vertical datum.',
      path: ['encoding'],
    });
};

/**
 * `<data>/packs/{imagery,terrain}/<id>.json` (`aio.raster-pack/1`): the metadata beside each raster
 * PMTiles archive, written by `packs.imagery` and `packs.terrain` and by the pack build tool.
 */
export const RasterPackMeta = z
  .looseObject({ schema: z.literal('aio.raster-pack/1'), ...rasterPackFields })
  .superRefine(terrainRules);

/** A raster pack as `imageryPacks:list` and `terrainPacks:list` report it. */
export const RasterPackInfo = z
  .object({
    ...rasterPackFields,
    sizeBytes: z.number().int().nonnegative(),
    /** How the pack arrived (the same words as a street pack's `MapPackInfo.source`). */
    source: z.enum(['download', 'import', 'build-tool', 'package']).optional(),
  })
  .superRefine(terrainRules);

/** **Import imagery**: the customer's GeoTIFF or COG (or a folder of them) to an imagery pack. */
export const ImageryImportRequest = z
  .object({
    path: z.string().min(1).max(1024),
    id: RasterPackId.optional(),
    label: z.string().min(1).max(120),
    licence: z.string().min(1).max(200),
    attribution: z.string().min(1).max(500),
    provenance: z.string().max(300).optional(),
    customerLicence: z.boolean(),
  })
  .strict();

/** **Import terrain**: a DEM GeoTIFF (or a folder) to a Terrarium terrain pack. */
export const TerrainImportRequest = z
  .object({
    path: z.string().min(1).max(1024),
    id: RasterPackId.optional(),
    label: z.string().min(1).max(120),
    licence: z.string().min(1).max(200),
    attribution: z.string().min(1).max(500),
    provenance: z.string().max(300).optional(),
    verticalDatum: TerrainDatum,
  })
  .strict();

/** A library project on the Globe (`globe:sites`), computed from its manifest in the data process. */
export const GlobeSite = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  /** The project origin in WGS84 degrees. */
  lonLat: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  footprint: LonLatRing.optional(),
  captures: z.array(z.object({ id: Id, label: z.string(), date: IsoDate })),
  issues: z.object({
    open: z.number().int().nonnegative(),
    /** Open issues by severity level, keyed by the level value as text. */
    bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  }),
  tilesets: z.array(z.object({ id: TilesetId, name: z.string(), kind: TilesetKind })),
});

/**
 * userData `globe.json` (`aio.globe-settings/1`): Globe and site-surroundings preferences. Its own
 * file, not a `Settings` field, so settings saved by 0.10 stay exactly what 0.9 reads.
 */
export const GlobeSettings = z.looseObject({
  schema: z.literal('aio.globe-settings/1'),
  /** `auto`: the best covering imagery pack per tile over Natural Earth II; or one pack. */
  imagery: z.union([z.literal('auto'), RasterPackId]).optional(),
  /** `auto`: the best covering terrain pack; `off`: the ellipsoid. */
  terrain: z.union([z.literal('auto'), z.literal('off'), RasterPackId]).optional(),
  terrainExaggeration: z.number().min(1).max(5).optional(),
  showIssues: z.boolean().optional(),
  /** Terrain and imagery around the site in the three.js site view (G7). */
  aroundSite: z.object({ terrain: z.boolean(), imagery: z.boolean() }).optional(),
});

export const defaultGlobeSettings = (): GlobeSettings => ({
  schema: 'aio.globe-settings/1',
  imagery: 'auto',
  terrain: 'auto',
  terrainExaggeration: 1,
  showIssues: true,
});

export type RasterPackId = z.infer<typeof RasterPackId>;
export type RasterPackKind = z.infer<typeof RasterPackKind>;
export type TerrainDatum = z.infer<typeof TerrainDatum>;
export type RasterPackMeta = z.infer<typeof RasterPackMeta>;
export type RasterPackInfo = z.infer<typeof RasterPackInfo>;
export type ImageryImportRequest = z.infer<typeof ImageryImportRequest>;
export type TerrainImportRequest = z.infer<typeof TerrainImportRequest>;
export type GlobeSite = z.infer<typeof GlobeSite>;
export type GlobeSettings = z.infer<typeof GlobeSettings>;
