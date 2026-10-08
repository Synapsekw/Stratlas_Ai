import { z } from 'zod';
import { HexColor, Id, IsoTime, ProjectPath, Sha256Hex, Vec3 } from './common';
import { Crs } from './manifest';
import { DesignId } from './designs';
import { SiteVerticalDatum } from './geodesy';

/**
 * Surveying (M11): site settings, units, saved measurements, templates, the surface comparison
 * engine's inputs and results, prepared height tiles, overlays, terrain cleanups and QA. Every file
 * lives in `<project>/survey/` (or userData), which 0.10 builds never read; no layer kind, raster
 * role, `ProjectType` or `Settings` field is added (data-conventions sections 25 to 30).
 *
 * SI inside, units at the edges: every stored value is metres, square metres, cubic metres,
 * kilograms and tonnes per cubic metre, float64. Coordinates are (E, N, Z) in the project CRS
 * (manifest `crs`), metres, never the local render frame.
 */

export const SURVEY_SETTINGS_FILE = 'survey/settings.json';
export const MEASUREMENTS_FILE = 'survey/measurements.json';
export const SURVEY_TEMPLATES_FILE = 'survey/templates.json';
export const SURFACES_DIR = 'survey/surfaces';
export const OVERLAYS_FILE = 'survey/overlays.json';
export const OVERLAYS_DIR = 'survey/overlays';
export const TERRAIN_EDITS_FILE = 'survey/cleanups.json';
export const QA_DIR = 'survey/qa';
/** userData files (not `Settings` fields, so settings saved by 0.11 stay what 0.10 reads). */
export const SURVEY_DEFAULTS_USERDATA = 'survey-defaults.json';
export const SURVEY_TEMPLATES_USERDATA = 'survey-templates.json';

/** File-name-safe ids for measurements, templates, surfaces, overlays and edits. */
export const SurveyId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'An id is letters, digits, dot, dash or _.');

/** A point in the project CRS: (E, N, Z), metres. */
export const SitePoint = Vec3;
/** A planar point (E, N). */
export const SitePoint2 = z.tuple([z.number(), z.number()]);

// ---------------------------------------------------------------- units (G1)

/** `ft` is the international foot (0.3048 m); `us-ft` the US survey foot (1200/3937 m). */
export const DistanceUnit = z.enum([
  'mm',
  'cm',
  'm',
  'km',
  'ft',
  'us-ft',
  'in',
  'yd',
  'mi',
  'us-mi',
]);
export const AreaUnit = z.enum(['m2', 'ha', 'km2', 'ft2', 'us-ft2', 'yd2', 'acre', 'mi2']);
export const VolumeUnit = z.enum(['m3', 'L', 'ft3', 'yd3', 'us-gal', 'acre-ft']);
export const DensityUnit = z.enum(['kg/m3', 't/m3', 'lb/ft3', 'lb/yd3', 'ston/yd3']);
export const MassUnit = z.enum(['kg', 't', 'ston', 'lb']);
/** Grade style: percent, degrees, ratio 1:n (rise to run) or n:1 (run to rise). */
export const GradeStyle = z.enum(['percent', 'degrees', 'ratio-1-n', 'ratio-n-1']);

export const SurveyUnits = z
  .object({
    distance: DistanceUnit,
    area: AreaUnit,
    volume: VolumeUnit,
    density: DensityUnit,
    mass: MassUnit,
    grade: GradeStyle,
  })
  .strict();

/** Decimal places per quantity. */
export const SurveyPrecision = z
  .object({
    coordinate: z.number().int().min(0).max(6),
    distance: z.number().int().min(0).max(6),
    area: z.number().int().min(0).max(6),
    volume: z.number().int().min(0).max(6),
    grade: z.number().int().min(0).max(6),
  })
  .strict();

export const CoordinateOrder = z.enum(['NEZ', 'ENZ']);

// ---------------------------------------------------------------- materials, QA, heat maps

export const IndustrySet = z.enum(['construction', 'mining', 'landfill']);

/** A site material (G4): density and swell factors used by the calculators at display time. */
export const SiteMaterial = z.looseObject({
  id: SurveyId,
  name: z.string().min(1).max(120),
  code: z.string().max(40).optional(),
  densityTPerM3: z.number().positive().max(30).optional(),
  /** Volume factors relative to bank (in situ) volume. */
  swell: z
    .looseObject({
      loose: z.number().positive().max(5),
      compacted: z.number().positive().max(5),
    })
    .optional(),
});

export const QaLevel = z.enum(['strict', 'moderate', 'lenient', 'off']);

/** A heat map stop: a dz (or height, or slope) value and its colour. */
export const HeatmapStop = z.object({ value: z.number(), color: HexColor }).strict();

export const HeatmapStyle = z.looseObject({
  /** Ascending; default -1, -0.1, 0.1, 1 m. */
  stops: z.array(HeatmapStop).min(2).max(16),
  stepped: z.boolean(),
  inverted: z.boolean().optional(),
});

/**
 * `<project>/survey/settings.json` (`aio.survey-settings/1`): how the site is shown and exported.
 * The manifest `crs` stays what the data is stored in. Changing anything here that a result was
 * computed with marks that result stale (its `fingerprint`).
 */
export const SurveySettings = z.looseObject({
  schema: z.literal('aio.survey-settings/1'),
  /** Display and export CRS; absent: the manifest `crs`. */
  crs: Crs.optional(),
  verticalDatum: SiteVerticalDatum,
  /** The applied calibration (`survey/calibration.json` id); absent: none. */
  calibration: Id.optional(),
  /** Distances shown as grid (default) or ground (scaled by the combined factor). */
  distances: z.enum(['grid', 'ground']),
  units: SurveyUnits,
  order: CoordinateOrder,
  precision: SurveyPrecision,
  /** Thousands separator style for numbers; default from the unit system. */
  locale: z.enum(['metric', 'imperial']).optional(),
  templateSets: z.array(IndustrySet).max(3),
  materials: z.array(SiteMaterial).max(500),
  qa: z.looseObject({
    level: QaLevel,
    /** RMSE threshold override, metres (defaults 0.05, 0.10, 0.20 by level). */
    rmseM: z.number().positive().max(10).optional(),
  }),
  heatmap: HeatmapStyle,
  /** Default deadband for new comparisons, metres. */
  deadbandM: z.number().nonnegative().max(10).optional(),
});

/** Metric defaults for a site without `survey/settings.json` (G1 derives units from the CRS). */
export const defaultSurveySettings = (): SurveySettings => ({
  schema: 'aio.survey-settings/1',
  verticalDatum: { kind: 'project' },
  distances: 'grid',
  units: { distance: 'm', area: 'm2', volume: 'm3', density: 't/m3', mass: 't', grade: 'percent' },
  order: 'NEZ',
  precision: { coordinate: 3, distance: 3, area: 2, volume: 1, grade: 1 },
  templateSets: [],
  materials: [],
  qa: { level: 'off' },
  heatmap: {
    stops: [
      { value: -1, color: '#b2182b' },
      { value: -0.1, color: '#f4a582' },
      { value: 0.1, color: '#92c5de' },
      { value: 1, color: '#2166ac' },
    ],
    stepped: false,
  },
});

/** userData `survey-defaults.json` (`aio.survey-defaults/1`): defaults for new sites. */
export const SurveyDefaults = z.looseObject({
  schema: z.literal('aio.survey-defaults/1'),
  units: SurveyUnits.optional(),
  order: CoordinateOrder.optional(),
  precision: SurveyPrecision.optional(),
  templateSets: z.array(IndustrySet).max(3).optional(),
});

// ---------------------------------------------------------------- surfaces and bases (G2)

/**
 * One side of a comparison (data-conventions section 26). Surfaces: `survey` (a capture's DSM, DTM
 * or a prepared or cleaned surface), `current` and `previous` (resolved through the capture index
 * when computed; the result records which), `design` (a design TIN with its vertical offset).
 * Bases (`BaseSpec`): `reference` levels, `smart` (Delaunay TIN of the perimeter sampled on the
 * From surface), `fit-plane`, `perimeter-mean`, and `custom` (a TIN of the polygon's vertices with
 * heights a person edits).
 */
export const SurveySurfaceRef = z
  .object({
    kind: z.literal('survey'),
    /** A prepared surface in `survey/surfaces/<surface>/`. */
    surface: SurveyId,
    capture: Id.optional(),
  })
  .strict();
export const CurrentSurfaceRef = z.object({ kind: z.literal('current') }).strict();
export const PreviousSurfaceRef = z.object({ kind: z.literal('previous') }).strict();
export const DesignSurfaceRef = z
  .object({ kind: z.literal('design'), design: DesignId, layer: DesignId })
  .strict();

export const ReferenceMode = z.enum([
  'level',
  'perimeter-max',
  'perimeter-min',
  'interior-max',
  'interior-min',
]);
export const ReferenceBase = z
  .object({
    kind: z.literal('reference'),
    mode: ReferenceMode,
    /** The typed level for `level`, metres in the site's vertical datum. */
    levelM: z.number().optional(),
  })
  .strict()
  .refine((b) => b.mode !== 'level' || b.levelM !== undefined, 'A typed level needs levelM.');
export const SmartBase = z.object({ kind: z.literal('smart') }).strict();
export const FitPlaneBase = z.object({ kind: z.literal('fit-plane') }).strict();
export const PerimeterMeanBase = z.object({ kind: z.literal('perimeter-mean') }).strict();
/** A custom base vertex: absolute elevation, or an offset from the From surface at the vertex. */
export const CustomBaseVertex = z
  .object({
    e: z.number(),
    n: z.number(),
    z: z.number().optional(),
    offsetM: z.number().optional(),
  })
  .strict()
  .refine((v) => (v.z === undefined) !== (v.offsetM === undefined), 'Give z or offsetM, not both.');
export const CustomBase = z
  .object({ kind: z.literal('custom'), vertices: z.array(CustomBaseVertex).min(3).max(10_000) })
  .strict();

export const BaseSpec = z.union([
  ReferenceBase,
  SmartBase,
  FitPlaneBase,
  PerimeterMeanBase,
  CustomBase,
]);
export const SurfaceRef = z.union([
  SurveySurfaceRef,
  CurrentSurfaceRef,
  PreviousSurfaceRef,
  DesignSurfaceRef,
  BaseSpec,
]);

/**
 * One comparison of a polygon: `dz = To - From`; fill where `dz > 0`, cut where `dz < 0`.
 * Coverage-weighted cells at the polygon edge; the deadband removes cells with `|dz| < deadbandM`
 * only when `useDeadband` is on.
 */
export const ComparisonItem = z.looseObject({
  id: SurveyId,
  label: z.string().max(120).optional(),
  from: SurfaceRef,
  to: SurfaceRef,
  deadbandM: z.number().nonnegative().max(10).optional(),
  useDeadband: z.boolean(),
  /** Grid cell, metres; default the finer prepared surface's. */
  cellM: z.number().min(0.01).max(100).optional(),
});

/** The engine that produced a result: the TypeScript worker or the Python reference core. */
export const SurveyEngine = z.enum(['ts', 'py']);

export const ComparisonStatus = z.enum(['ok', 'partial', 'refused', 'stale']);

/** A comparison result; never shown as current when its `fingerprint` no longer matches. */
export const ComparisonResult = z.looseObject({
  item: SurveyId,
  status: ComparisonStatus,
  /** Why it is partial or refused ("23% outside the survey"). */
  reason: z.string().max(300).optional(),
  cutM3: z.number().nonnegative(),
  fillM3: z.number().nonnegative(),
  /** fill - cut. */
  netM3: z.number(),
  /** fill + cut. */
  totalM3: z.number().nonnegative(),
  areaM2: z.number().nonnegative(),
  areaCutM2: z.number().nonnegative(),
  areaFillM2: z.number().nonnegative(),
  areaUnchangedM2: z.number().nonnegative(),
  uncoveredM2: z.number().nonnegative(),
  fromLabel: z.string().max(200),
  toLabel: z.string().max(200),
  /** The captures `current` and `previous` resolved to. */
  fromCapture: Id.optional(),
  toCapture: Id.optional(),
  deadbandM: z.number().nonnegative(),
  usedDeadband: z.boolean(),
  /** 0 for the exact TIN to TIN path. */
  cellM: z.number().nonnegative(),
  engine: SurveyEngine,
  /** Hash of every input: surface hashes, design offset, base, deadband, calibration, geoid. */
  fingerprint: z.string().min(1).max(200),
  computedAt: IsoTime,
});

// ---------------------------------------------------------------- prepared surfaces

export const PreparedSurfaceSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dsm'), layer: Id }).strict(),
  z.object({ kind: z.literal('dtm'), layer: Id }).strict(),
  z.object({ kind: z.literal('cloud'), layer: Id }).strict(),
  z.object({ kind: z.literal('design'), design: DesignId, layer: DesignId }).strict(),
  /** A derived surface (cleanup or crop) of another prepared surface. */
  z.object({ kind: z.literal('derived'), of: SurveyId, edits: z.array(SurveyId) }).strict(),
]);

/**
 * `survey/surfaces/<id>/tiles.json` (`aio.height-tiles/1`), written by `survey.prepare`: 256 by
 * 256 float32 heights relative to a per-tile float64 base (`<level>/<col>_<row>.bin`, deflate),
 * a nodata bit mask per tile, and a display pyramid. Re-prepared only when `fingerprint` changes.
 */
export const HeightTiles = z.looseObject({
  schema: z.literal('aio.height-tiles/1'),
  id: SurveyId,
  name: z.string().min(1).max(200),
  source: PreparedSurfaceSource,
  capture: Id.optional(),
  crs: Crs,
  cellM: z.number().positive(),
  tileSize: z.literal(256),
  /** Lower-left corner of tile (0, 0) at level 0, project CRS metres. */
  originE: z.number(),
  originN: z.number(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  levels: z.number().int().min(1).max(20),
  /** Min E, min N, min Z, max E, max N, max Z. */
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
  /** Tiles that exist at level 0, as `col_row` (absent tiles are all nodata). */
  tiles: z.array(z.string().regex(/^\d+_\d+$/)).max(1_000_000),
  sourceSha256: Sha256Hex.optional(),
  fingerprint: z.string().min(1).max(200),
  preparedAt: IsoTime,
});

// ---------------------------------------------------------------- measurements and templates (G3)

export const MeasurementFamily = z.enum(['point', 'line', 'polygon', 'markup']);

/** Every typed tool; a template picks one. */
export const MeasurementTool = z.enum([
  // point
  'elevation',
  'elevation-difference',
  'elevation-history',
  'annotation',
  // line
  'distance',
  'grade',
  'vertex-table',
  'berm-check',
  'section',
  // polygon
  'area',
  'volume',
  // markup
  'freehand',
]);

export const MeasurementScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('site') }).strict(),
  z.object({ kind: z.literal('survey'), capture: Id }).strict(),
]);

export const MeasurementStyle = z.looseObject({
  color: HexColor,
  fill: HexColor.optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  borderWidth: z.number().min(0).max(20).optional(),
  labelSize: z.number().min(6).max(48).optional(),
  labelOnlyWhenSelected: z.boolean().optional(),
  showPropertyName: z.boolean().optional(),
});

export const CustomField = z.looseObject({
  id: SurveyId,
  name: z.string().min(1).max(80),
  type: z.enum(['text', 'number', 'dropdown']),
  options: z.array(z.string().min(1).max(80)).max(100).optional(),
});

/** Per-measurement unit overrides; absent keys use the site units. */
export const UnitsOverride = SurveyUnits.partial();

export const SurveyMeasurement = z.looseObject({
  id: SurveyId,
  family: MeasurementFamily,
  tool: MeasurementTool,
  template: SurveyId.optional(),
  label: z.string().min(1).max(200),
  folder: z.string().max(200).optional(),
  scope: MeasurementScope,
  /** Vertices (E, N, Z) in the project CRS; a polygon is closed implicitly. */
  points: z.array(SitePoint).min(1).max(100_000),
  style: MeasurementStyle.optional(),
  units: UnitsOverride.optional(),
  description: z.string().max(4000).optional(),
  /** Custom field values by field id. */
  fields: z.record(z.string(), z.union([z.string().max(1000), z.number()])).optional(),
  material: SurveyId.optional(),
  items: z.array(ComparisonItem).max(20),
  results: z.array(ComparisonResult).max(20),
  createdAt: IsoTime,
  createdBy: z.string().max(200).optional(),
  updatedAt: IsoTime.optional(),
});

/** `<project>/survey/measurements.json` (`aio.measurements/1`), written atomically with `.bak`. */
export const MeasurementsFile = z
  .looseObject({
    schema: z.literal('aio.measurements/1'),
    measurements: z.array(SurveyMeasurement).max(20_000),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const m of f.measurements) {
      if (seen.has(m.id))
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate measurement "${m.id}"`,
          path: ['measurements'],
        });
      seen.add(m.id);
    }
  });

export const emptyMeasurements = (): MeasurementsFile => ({
  schema: 'aio.measurements/1',
  measurements: [],
});

/** A comparison preset in a template: an item without its id (one is made when used). */
export const ComparisonPreset = z.looseObject({
  label: z.string().max(120).optional(),
  from: SurfaceRef,
  to: SurfaceRef,
  deadbandM: z.number().nonnegative().max(10).optional(),
  useDeadband: z.boolean(),
});

export const SurveyTemplate = z.looseObject({
  id: SurveyId,
  name: z.string().min(1).max(120),
  family: MeasurementFamily,
  tool: MeasurementTool,
  description: z.string().max(2000).optional(),
  /** Result rows in display order (`cut`, `fill`, `net`, `total`, `area`, `length`, ...). */
  items: z.array(z.string().min(1).max(40)).max(40),
  fields: z.array(CustomField).max(50),
  comparisons: z.array(ComparisonPreset).max(10),
  style: MeasurementStyle.optional(),
  bookmarked: z.boolean().optional(),
  /** The industry set it came from (G9), when it was not made by a person. */
  set: IndustrySet.optional(),
});

/** `survey/templates.json` and userData `survey-templates.json` (`aio.survey-templates/1`). */
export const SurveyTemplatesFile = z.looseObject({
  schema: z.literal('aio.survey-templates/1'),
  templates: z.array(SurveyTemplate).max(1000),
});

export const emptySurveyTemplates = (): SurveyTemplatesFile => ({
  schema: 'aio.survey-templates/1',
  templates: [],
});

// ---------------------------------------------------------------- sections (G5)

export const SectionSpec = z.looseObject({
  /** The section line (E, N), two or more points. */
  line: z.array(SitePoint2).min(2).max(10_000),
  surfaces: z
    .array(z.union([SurveySurfaceRef, CurrentSurfaceRef, PreviousSurfaceRef, DesignSurfaceRef]))
    .min(1)
    .max(20),
  /** Sample step, metres; default half the finest cell. */
  stepM: z.number().positive().max(100).optional(),
  /** Vertical exaggeration 1 to 20. */
  exaggeration: z.number().min(1).max(20).optional(),
});

/** One surface's profile: chainage and elevation pairs, `null` where the surface has no data. */
export const SectionProfile = z.looseObject({
  surface: z.string().max(200),
  label: z.string().max(200),
  chainage: z.array(z.number()),
  z: z.array(z.number().nullable()),
});

// ---------------------------------------------------------------- overlays, cleanups and QA (G5, G8)

export const OverlayKind = z.enum(['contours', 'slope', 'elevation', 'relief']);

export const SurveyOverlay = z.looseObject({
  id: SurveyId,
  name: z.string().min(1).max(200),
  kind: OverlayKind,
  /** A prepared surface, or the difference of a comparison. */
  source: z.union([
    z.object({ surface: SurveyId }).strict(),
    z.object({ comparison: z.object({ from: SurfaceRef, to: SurfaceRef }).strict() }).strict(),
  ]),
  /** Kind-specific options (intervals, stops, sun angles). */
  options: z.record(z.string(), z.unknown()),
  /** The overlay's files, `survey/overlays/<id>/`. */
  dir: ProjectPath,
  visible: z.boolean(),
  fingerprint: z.string().min(1).max(200),
  createdAt: IsoTime,
});

/** `survey/overlays.json` (`aio.survey-overlays/1`). */
export const SurveyOverlaysFile = z.looseObject({
  schema: z.literal('aio.survey-overlays/1'),
  overlays: z.array(SurveyOverlay).max(500),
});

export const TerrainEdit = z.looseObject({
  id: SurveyId,
  kind: z.enum(['cleanup', 'crop']),
  /** The prepared surface it applies to. */
  surface: SurveyId,
  ring: z.array(SitePoint2).min(3).max(100_000),
  /** Cleanup interpolation from the boundary. */
  method: z.enum(['tin', 'thin-plate']).optional(),
  enabled: z.boolean(),
  label: z.string().max(200).optional(),
  createdAt: IsoTime,
});

/** `survey/cleanups.json` (`aio.terrain-edits/1`); outputs are `survey/surfaces/<capture>-clean/`. */
export const TerrainEditsFile = z.looseObject({
  schema: z.literal('aio.terrain-edits/1'),
  edits: z.array(TerrainEdit).max(2000),
});

export const QaStatus = z.enum(['pass', 'fail', 'hold', 'released', 'unchecked']);

/** `survey/qa/<capture>.json` (`aio.survey-qa/1`). A failed check holds the survey; a person releases it. */
export const SurveyQa = z.looseObject({
  schema: z.literal('aio.survey-qa/1'),
  capture: Id,
  level: QaLevel,
  status: QaStatus,
  checkpoints: z
    .looseObject({
      count: z.number().int().nonnegative(),
      rmseM: z.number().nonnegative(),
      meanM: z.number(),
      maxAbsM: z.number().nonnegative(),
      /** Per point: name, dz (surface minus surveyed), metres; null where the surface has no data. */
      points: z
        .array(z.object({ name: z.string().max(120), dz: z.number().nullable() }).strict())
        .max(10_000),
    })
    .optional(),
  previous: z
    .looseObject({
      capture: Id,
      thresholdM: z.number().positive(),
      changedShare: z.number().min(0).max(1),
    })
    .optional(),
  hold: z
    .object({ at: IsoTime, reason: z.string().max(500) })
    .strict()
    .optional(),
  release: z
    .object({ at: IsoTime, by: z.string().max(200).optional(), note: z.string().min(1).max(2000) })
    .strict()
    .optional(),
  checkedAt: IsoTime,
});

export type SurveyId = z.infer<typeof SurveyId>;
export type SitePoint = z.infer<typeof SitePoint>;
export type SitePoint2 = z.infer<typeof SitePoint2>;
export type DistanceUnit = z.infer<typeof DistanceUnit>;
export type AreaUnit = z.infer<typeof AreaUnit>;
export type VolumeUnit = z.infer<typeof VolumeUnit>;
export type DensityUnit = z.infer<typeof DensityUnit>;
export type MassUnit = z.infer<typeof MassUnit>;
export type GradeStyle = z.infer<typeof GradeStyle>;
export type SurveyUnits = z.infer<typeof SurveyUnits>;
export type SurveyPrecision = z.infer<typeof SurveyPrecision>;
export type CoordinateOrder = z.infer<typeof CoordinateOrder>;
export type IndustrySet = z.infer<typeof IndustrySet>;
export type SiteMaterial = z.infer<typeof SiteMaterial>;
export type QaLevel = z.infer<typeof QaLevel>;
export type HeatmapStop = z.infer<typeof HeatmapStop>;
export type HeatmapStyle = z.infer<typeof HeatmapStyle>;
export type SurveySettings = z.infer<typeof SurveySettings>;
export type SurveyDefaults = z.infer<typeof SurveyDefaults>;
export type ReferenceMode = z.infer<typeof ReferenceMode>;
export type CustomBaseVertex = z.infer<typeof CustomBaseVertex>;
export type BaseSpec = z.infer<typeof BaseSpec>;
export type SurfaceRef = z.infer<typeof SurfaceRef>;
export type ComparisonItem = z.infer<typeof ComparisonItem>;
export type SurveyEngine = z.infer<typeof SurveyEngine>;
export type ComparisonStatus = z.infer<typeof ComparisonStatus>;
export type ComparisonResult = z.infer<typeof ComparisonResult>;
export type PreparedSurfaceSource = z.infer<typeof PreparedSurfaceSource>;
export type HeightTiles = z.infer<typeof HeightTiles>;
export type MeasurementFamily = z.infer<typeof MeasurementFamily>;
export type MeasurementTool = z.infer<typeof MeasurementTool>;
export type MeasurementScope = z.infer<typeof MeasurementScope>;
export type MeasurementStyle = z.infer<typeof MeasurementStyle>;
export type CustomField = z.infer<typeof CustomField>;
export type UnitsOverride = z.infer<typeof UnitsOverride>;
export type SurveyMeasurement = z.infer<typeof SurveyMeasurement>;
export type MeasurementsFile = z.infer<typeof MeasurementsFile>;
export type ComparisonPreset = z.infer<typeof ComparisonPreset>;
export type SurveyTemplate = z.infer<typeof SurveyTemplate>;
export type SurveyTemplatesFile = z.infer<typeof SurveyTemplatesFile>;
export type SectionSpec = z.infer<typeof SectionSpec>;
export type SectionProfile = z.infer<typeof SectionProfile>;
export type OverlayKind = z.infer<typeof OverlayKind>;
export type SurveyOverlay = z.infer<typeof SurveyOverlay>;
export type SurveyOverlaysFile = z.infer<typeof SurveyOverlaysFile>;
export type TerrainEdit = z.infer<typeof TerrainEdit>;
export type TerrainEditsFile = z.infer<typeof TerrainEditsFile>;
export type QaStatus = z.infer<typeof QaStatus>;
export type SurveyQa = z.infer<typeof SurveyQa>;
