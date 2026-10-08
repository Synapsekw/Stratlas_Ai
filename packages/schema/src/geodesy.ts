import { z } from 'zod';
import { Id, IsoTime, ProjectPath, Sha256Hex } from './common';
import { Crs } from './manifest';

/**
 * Geodesy of a survey site (M11 G1, ADR 0010): PROJ in the pipeline pack is the one source of
 * truth for every coordinate a person reads or exports. The renderer never re-implements a datum:
 * it reads tables PROJ wrote (`SiteTransform`). Everything here lives in `<project>/survey/` or in
 * the data folder's `packs/geoid/`, which 0.10 builds never read (data-conventions section 25).
 */

export const SURVEY_DIR = 'survey';
export const CALIBRATION_FILE = 'survey/calibration.json';
export const SITE_TRANSFORM_FILE = 'survey/geodesy/site-transform.json';
export const GEOID_PACKS_DIR = 'packs/geoid';

/** A geoid pack id: file-name safe, the base name of `<data>/packs/geoid/<id>.tif` and `.json`. */
export const GeoidPackId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
    'A geoid pack id is letters, digits, dot, dash or _.',
  );

/**
 * How heights are shown and exported. `ellipsoidal`: heights above the ellipsoid as stored;
 * `geoid`: orthometric through a geoid pack (EGM96 and EGM2008 ship in the pipeline pack, regional
 * models are packs); `calibration`: the site calibration's vertical adjustment; `project`: the
 * project's own heights (`verticalDatum.absAltOffsetM` of the manifest), unchanged from 0.10.
 */
export const SiteVerticalDatum = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('ellipsoidal') }).strict(),
  z
    .object({
      kind: z.literal('geoid'),
      /** The EPSG vertical CRS (for example 5773 EGM96 height, 3855 EGM2008 height). */
      epsg: z.number().int().positive().optional(),
      geoid: GeoidPackId,
    })
    .strict(),
  z.object({ kind: z.literal('calibration') }).strict(),
]);

/** Where a calibration came from (decision 8: JobXML, `.dc`, 12d, point pairs; `.cal` if documented). */
export const CalibrationSourceFormat = z.enum(['jobxml', 'dc', '12d', 'cal', 'pairs']);

/**
 * A 2D similarity (Helmert) from the base projection to the local grid, about an origin, in the
 * controller's convention: `local = origin' + scale * R(rotation) * (grid - origin)`.
 */
export const HorizontalAdjustment = z
  .object({
    /** Origin in the base projection, metres (E, N). */
    originE: z.number(),
    originN: z.number(),
    /** Translation after rotation and scale, metres. */
    shiftE: z.number(),
    shiftN: z.number(),
    /** Radians, counter-clockwise positive. */
    rotationRad: z.number().min(-Math.PI).max(Math.PI),
    scale: z.number().positive(),
  })
  .strict();

/** Constant shift plus an inclined plane about an origin: `dz = shift + slopeN*(N-n0) + slopeE*(E-e0)`. */
export const VerticalAdjustment = z
  .object({
    originE: z.number(),
    originN: z.number(),
    shiftM: z.number(),
    /** Dimensionless slopes (metres per metre). */
    slopeN: z.number(),
    slopeE: z.number(),
  })
  .strict();

/** One calibration point pair with its residuals (metres). */
export const CalibrationPair = z
  .looseObject({
    name: z.string().min(1).max(120),
    /** Local grid coordinates, metres (N, E, Z as the controller lists them). */
    local: z.tuple([z.number(), z.number(), z.number()]),
    /** Global position: WGS84 latitude and longitude in degrees and ellipsoidal height in metres. */
    wgs84: z
      .tuple([z.number().min(-90).max(90), z.number().min(-180).max(180), z.number()])
      .optional(),
    /** Or grid coordinates in the base projection (N, E, Z). */
    grid: z.tuple([z.number(), z.number(), z.number()]).optional(),
    useH: z.boolean(),
    useV: z.boolean(),
    residualH: z.number().nonnegative().optional(),
    residualV: z.number().optional(),
    /** The residuals the controller file itself reported, shown side by side. */
    controllerResidualH: z.number().nonnegative().optional(),
    controllerResidualV: z.number().optional(),
  })
  .refine(
    (p) => p.wgs84 !== undefined || p.grid !== undefined,
    'A pair needs a WGS84 or grid position.',
  );

/**
 * `<project>/survey/calibration.json` (`aio.site-calibration/1`): a local site calibration in the
 * controller's order: base projection, horizontal similarity, vertical adjustment (with or without
 * a geoid). Applied only when a person confirms (`geodesy:applyCalibration`, journaled).
 */
export const SiteCalibration = z.looseObject({
  schema: z.literal('aio.site-calibration/1'),
  id: Id,
  name: z.string().min(1).max(200),
  source: z.looseObject({
    format: CalibrationSourceFormat,
    /** The imported file, kept as it was in `survey/calibration/` (absent for typed pairs). */
    file: ProjectPath.optional(),
    sha256: Sha256Hex.optional(),
  }),
  /** The base projection the similarity applies to (often a transverse Mercator at the site). */
  projection: Crs,
  /** The geoid the vertical adjustment sits on; absent: ellipsoidal heights. */
  geoid: GeoidPackId.optional(),
  horizontal: HorizontalAdjustment.optional(),
  vertical: VerticalAdjustment.optional(),
  pairs: z.array(CalibrationPair).max(500),
  /** Root mean square of the used residuals, metres. */
  rmsH: z.number().nonnegative().optional(),
  rmsV: z.number().nonnegative().optional(),
  computedAt: IsoTime,
  /** Set when a person applied it; an unapplied calibration is a draft. */
  appliedAt: IsoTime.optional(),
  appliedBy: z.string().max(200).optional(),
});

/** `<data>/packs/geoid/<id>.json` (`aio.geoid-pack/1`): a geoid grid and where it may be used. */
export const GeoidPackMeta = z.looseObject({
  schema: z.literal('aio.geoid-pack/1'),
  id: GeoidPackId,
  name: z.string().min(1).max(200),
  /** West, south, east, north in degrees. */
  bbox: z.tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ]),
  horizontalEpsg: z.number().int().positive().optional(),
  verticalEpsg: z.number().int().positive().optional(),
  /** The grid's PROJ-data file name (for example `au_ga_AUSGeoid2020_20180201.tif`). */
  projFile: z.string().min(1).max(200),
  licence: z.string().min(1).max(200),
  attribution: z.string().max(1000),
  provenance: z.string().max(1000).optional(),
  sha256: Sha256Hex,
  bytes: z.number().int().nonnegative(),
  /** Imported by a person (GCC models) rather than built from PROJ-data. */
  imported: z.boolean().optional(),
});

/** A float64 grid on disk: row-major, little-endian, `rows * cols` values, nodata NaN. */
export const F64Grid = z.looseObject({
  /** Relative to `survey/geodesy/`. */
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  /** Lower-left cell centre in the project CRS, metres. */
  originX: z.number(),
  originY: z.number(),
  spacingM: z.number().positive(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Values per cell: 2 for the E and N mapping grid, 1 for the geoid undulation. */
  bands: z.number().int().min(1).max(4),
});

/**
 * `<project>/survey/geodesy/site-transform.json` (`aio.site-transform/1`), written by
 * `survey.prepare`: the tables the renderer interpolates bilinearly for readouts. `grid` maps the
 * project CRS to the site grid (two bands, E and N, at 1 m); `geoid` holds the undulation for the
 * site extent. proj4js is used instead only when `proj4` is set (a pure projection it represents
 * exactly, checked against PROJ at 25 points when written).
 */
export const SiteTransform = z.looseObject({
  schema: z.literal('aio.site-transform/1'),
  /** The data CRS (manifest `crs`) and the display CRS (site settings). */
  from: Crs,
  to: Crs,
  /** PROJ's chosen operation, shown in Site settings, Details. */
  operation: z.string().max(2000),
  proj4: z.string().max(2000).optional(),
  calibration: Id.optional(),
  geoid: GeoidPackId.optional(),
  grid: F64Grid.optional(),
  geoidGrid: F64Grid.optional(),
  /** Hash of every input (CRS, calibration, geoid pack); a change marks results stale. */
  fingerprint: z.string().min(1).max(200),
  writtenAt: IsoTime,
});

/**
 * One row of the renderer's EPSG catalogue (`packages/geo/src/catalogue/epsg.json.gz`, generated
 * from PROJ's `proj.db` by `tools/geo/build-crs-catalogue.mjs`), as `geodesy:searchCrs` returns it.
 */
export const CrsCatalogueEntry = z.looseObject({
  code: z.number().int().positive(),
  name: z.string().min(1).max(300),
  kind: z.enum(['projected', 'geographic', 'vertical', 'compound']),
  /** Area of use: name and west, south, east, north in degrees. */
  area: z.string().max(500).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Linear unit (`metre`, `US survey foot`, `foot`) or angular unit. */
  unit: z.string().max(80),
  datum: z.string().max(200).optional(),
  deprecated: z.boolean(),
  /** Set when proj4js represents this CRS exactly (checked against PROJ at build time). */
  proj4: z.string().max(2000).optional(),
});

export type GeoidPackId = z.infer<typeof GeoidPackId>;
export type CrsCatalogueEntry = z.infer<typeof CrsCatalogueEntry>;
export type SiteVerticalDatum = z.infer<typeof SiteVerticalDatum>;
export type CalibrationSourceFormat = z.infer<typeof CalibrationSourceFormat>;
export type HorizontalAdjustment = z.infer<typeof HorizontalAdjustment>;
export type VerticalAdjustment = z.infer<typeof VerticalAdjustment>;
export type CalibrationPair = z.infer<typeof CalibrationPair>;
export type SiteCalibration = z.infer<typeof SiteCalibration>;
export type GeoidPackMeta = z.infer<typeof GeoidPackMeta>;
export type F64Grid = z.infer<typeof F64Grid>;
export type SiteTransform = z.infer<typeof SiteTransform>;
