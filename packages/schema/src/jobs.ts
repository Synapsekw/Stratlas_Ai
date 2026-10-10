import { z } from 'zod';
import { FrameRef, LonLatRing } from './change';
import { Id, ProjectPath, Vec3 } from './common';
import { RasterPackId, TerrainDatum } from './globe';
import { Crs } from './manifest';
import { PhotoPreset, PhotoProduct, PhotoRunId, PhotoSource } from './photogrammetry';
import { ProcModelId, ProcPartKind } from './procmodel';
import { TilesetId } from './tilesets';
import { DesignFormat, DesignId, DesignSourceUnits } from './designs';
import {
  CalibrationPair,
  CalibrationSourceFormat,
  GeoidPackId,
  SiteVerticalDatum,
} from './geodesy';
import {
  ComparisonItem,
  CurrentSurfaceRef,
  DesignSurfaceRef,
  DistanceUnit,
  OverlayKind,
  PreparedSurfaceSource,
  PreviousSurfaceRef,
  QaLevel,
  SitePoint2,
  SurfaceRef,
  SurveyId,
  SurveySurfaceRef,
} from './survey';

/**
 * Pipeline jobs (Release B). Main spawns the pipeline pack's Python (`python -m aio_pipelines`)
 * and talks JSON-RPC 2.0 over stdio; these are the shapes that cross into the app. Params mirror
 * the checks in `python/src/aio_pipelines` so a bad request fails before Python starts.
 */

export const PIPELINE_PROTOCOL = 'aio.pipelines/1';

export const PipelineName = z.enum([
  'aik.cameras',
  'aik.project',
  'aik.records',
  'volumetric.process',
  'pointcloud.to_copc',
  'inspection.run',
  'road.build',
  'system.selftest',
  'volumetric.build',
  // M8 (pipeline pack 0.3.0)
  'change.raster',
  'change.surface',
  'change.cloud',
  'change.mesh',
  'change.frames',
  'drawing.import',
  'model.fit_cloud',
  // M10 (pipeline pack 0.4.0)
  'photo.align',
  'photo.georef',
  'photo.products',
  'opf.import',
  'opf.export',
  'tiles.mesh',
  'tiles.cloud',
  'packs.imagery',
  'packs.terrain',
  // M11 (pipeline pack 0.5.0)
  'survey.prepare',
  'survey.compare',
  'survey.overlay',
  'survey.section',
  'survey.export',
  'survey.qa',
  'survey.cleanup',
  'design.import',
  'geo.calibration',
  'hydro.flood',
  'hydro.flow',
  'hydro.rainfall',
  'haul.analyse',
]);
export type PipelineName = z.infer<typeof PipelineName>;

export const PIPELINES: readonly { name: PipelineName; title: string; description: string }[] = [
  {
    name: 'aik.cameras',
    title: 'Cameras from photos',
    description: 'Camera poses from EXIF GPS and DJI gimbal angles, and 2560 px review copies.',
  },
  {
    name: 'aik.project',
    title: 'Place findings on the model',
    description: 'Back-projects finding boxes and masks onto the GLB as pins or textured patches.',
  },
  {
    name: 'aik.records',
    title: 'Findings register and stats',
    description: 'Findings with heights, zones and sides, the summary stats and the CSV.',
  },
  {
    name: 'volumetric.process',
    title: 'Stockpile volumes',
    description: 'Piles from DSM GeoTIFFs, four bases, volumes and change between two dates.',
  },
  {
    name: 'volumetric.build',
    title: 'Volumetric survey',
    description:
      'Raw DSM and ortho GeoTIFFs (or point clouds) per date to piles, toe lines, four bases, volumes, change and terrain.',
  },
  {
    name: 'pointcloud.to_copc',
    title: 'Point cloud to COPC',
    description: 'LAS, LAZ or E57 to a COPC file in the project CRS, added as a layer (PDAL).',
  },
  {
    name: 'inspection.run',
    title: 'Inspection: detections to issues',
    description:
      'Contact sheets, detections placed on the model, grouped into issues, and the stats for the report.',
  },
  {
    name: 'road.build',
    title: 'Road survey',
    description:
      'Ortho tiles, chainage from the centreline, defect polygons, ASTM D6433 sample units, deducts and PCI.',
  },
  {
    name: 'system.selftest',
    title: 'Check the pipeline pack',
    description:
      'Loads every library the pipelines need; optionally waits to try cancel and resume.',
  },
  {
    name: 'change.raster',
    title: 'Imagery change',
    description:
      'Two orthos of the same area: co-registration check, illumination-robust difference, change heat map and polygons.',
  },
  {
    name: 'change.surface',
    title: 'Surface change',
    description:
      'Two DSMs or point clouds: DEM of difference, cut and fill regions with volumes, and the site total.',
  },
  {
    name: 'change.cloud',
    title: 'Point cloud change',
    description:
      'Cloud-to-cloud distance as a COPC with a Distance field, and change regions from the points that moved.',
  },
  {
    name: 'change.mesh',
    title: '3D model change',
    description:
      'Deviation of the later model from the earlier one, and tagged parts added, removed, moved or changed.',
  },
  {
    name: 'change.frames',
    title: 'Change in matched frames',
    description:
      'Frame and photo pairs of two dates aligned by features; changes become draft detections.',
  },
  {
    name: 'drawing.import',
    title: 'Drawing import (DXF)',
    description:
      'A DXF plot plan in its units, placed by control points: vector layers per layer group, a plan raster and height hints.',
  },
  {
    name: 'model.fit_cloud',
    title: 'Model from point cloud',
    description:
      'Ground removal, clustering and primitive fitting (tanks, boxes, buildings, pipes) into draft model parts.',
  },
  {
    name: 'photo.align',
    title: 'Align photos',
    description:
      'Drone photos to calibrated cameras and a sparse model: EXIF and RTK tags, matching, structure from motion and GNSS georeferencing.',
  },
  {
    name: 'photo.georef',
    title: 'Adjust with ground control',
    description:
      'Bundle adjustment with marked control points; checkpoints measured only; the accuracy report.',
  },
  {
    name: 'photo.products',
    title: 'Create products from photos',
    description:
      'Dense cloud (COPC), DSM and DTM, orthomosaic and textured mesh from an aligned run, as new layers.',
  },
  {
    name: 'opf.import',
    title: 'OPF import',
    description:
      'An Open Photogrammetry Format project: calibrated cameras, control points and its outputs as layers.',
  },
  {
    name: 'opf.export',
    title: 'OPF export',
    description:
      'A processing run as an OPF project: cameras, calibration, control points, CRS and the sparse cloud.',
  },
  {
    name: 'tiles.mesh',
    title: 'Mesh to 3D Tiles',
    description:
      'A large mesh to a 3D Tiles 1.1 tileset placed through the project CRS, for the site view and the Globe.',
  },
  {
    name: 'tiles.cloud',
    title: 'Point cloud to 3D Tiles',
    description:
      'A COPC point cloud to a 3D Tiles points tileset following its hierarchy, for the Globe.',
  },
  {
    name: 'packs.imagery',
    title: 'Imagery pack',
    description:
      'GeoTIFF or COG imagery to an offline raster pack (PMTiles, WebP, Web Mercator) with its licence and attribution.',
  },
  {
    name: 'packs.terrain',
    title: 'Terrain pack',
    description:
      'A DEM to an offline terrain pack (Terrarium tiles in PMTiles) with its vertical datum, licence and attribution.',
  },
  {
    name: 'survey.prepare',
    title: 'Prepare surfaces',
    description:
      'A DSM, DTM, cloud, design or cleaned surface to height tiles for measuring, plus the site coordinate tables.',
  },
  {
    name: 'survey.compare',
    title: 'Compare surfaces',
    description:
      'Cut, fill, net and total between any two surfaces or a base, for many measurements at once or the whole site.',
  },
  {
    name: 'survey.overlay',
    title: 'Terrain overlay',
    description: 'Contours, slope, elevation ramp or shaded relief of a surface or a difference.',
  },
  {
    name: 'survey.section',
    title: 'Cross-section',
    description: 'A multi-surface cross-section as DXF (2D or 3D) or CSV.',
  },
  {
    name: 'survey.export',
    title: 'Survey export',
    description:
      'Surfaces, orthos, clouds, contours, measurements and sections as GeoTIFF, LAZ, DXF, LandXML, 12da, CSV, KML, SHP or GeoJSON in the site grid or WGS84.',
  },
  {
    name: 'survey.qa',
    title: 'Survey QA',
    description:
      'Checks a surface against checkpoints and against the previous survey at the site QA level.',
  },
  {
    name: 'survey.cleanup',
    title: 'Terrain cleanup',
    description:
      'Cleanups, crops and DTM filters as a new derived surface; the delivered surface is never changed.',
  },
  {
    name: 'design.import',
    title: 'Import design',
    description:
      'LandXML, DXF, 12da or CSV designs to TIN surfaces, linework, alignments and points, keeping the original file.',
  },
  {
    name: 'geo.calibration',
    title: 'Site calibration',
    description:
      'A Trimble JobXML or .dc, a 12d transform or point pairs to a site calibration with residuals.',
  },
  {
    name: 'hydro.flood',
    title: 'Flood to level',
    description: 'The area, depth and stored volume below a water level.',
  },
  {
    name: 'hydro.flow',
    title: 'Runoff and catchments',
    description: 'Flow paths from a drop point, catchments of outlets and the stream network.',
  },
  {
    name: 'hydro.rainfall',
    title: 'Direct rainfall',
    description: 'Water depth over time from a rainfall hyetograph (simplified 2D model).',
  },
  {
    name: 'haul.analyse',
    title: 'Haul-road compliance',
    description:
      'Width, gradient, cross fall, superelevation and berm height along a haul road against site limits.',
  },
];

const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);
/** Anything shaped like a kit job file (job.yaml for the inspection kit, job.json for volumes). */
const KitConfig = z.record(z.string(), z.unknown());

export const AikCamerasParams = z
  .object({
    /** Folder of original photos (absolute, or relative to the project). Read only. */
    photos: z.string().min(1),
    /** Asset base centre and ground altitude: latitude, longitude, metres. */
    origin: z.tuple([Latitude, Longitude, z.number()]).optional(),
    assetHeight: z.number().min(0.1).max(2000).optional(),
    sensorWidthMm: z.number().min(1).max(100).optional(),
    longEdge: z.number().int().min(256).max(16384).optional(),
    out: ProjectPath.optional(),
    photosOut: ProjectPath.optional(),
    /**
     * Camera heights (data-conventions section 3a). `auto` (default): absolute altitude minus the
     * origin's ground altitude when an origin is given, else relative altitude above the take-off
     * point (the estimated ground). A photo without the preferred altitude uses the other.
     */
    altitude: z.enum(['auto', 'absolute', 'relative']).optional(),
    /** Height of the take-off point above the ground datum, for relative altitude (metres). */
    takeoffHeight: z.number().min(-500).max(5000).optional(),
  })
  .strict();

export const AikProjectParams = z
  .object({
    job: z.string().min(1).optional(),
    config: KitConfig.optional(),
    grid: z.number().int().min(4).max(256).optional(),
    placement: z.enum(['point', 'patch', 'none']).optional(),
    out: ProjectPath.optional(),
  })
  .strict();

export const AikRecordsParams = z
  .object({
    job: z.string().min(1).optional(),
    config: KitConfig.optional(),
    out: ProjectPath.optional(),
    csv: ProjectPath.optional(),
  })
  .strict();

export const VolumetricProcessParams = z
  .object({
    job: z.string().min(1).optional(),
    config: KitConfig.optional(),
    out: ProjectPath.optional(),
  })
  .strict();

/** One survey date of a volumetric build: a DSM GeoTIFF or a point cloud, and an optional ortho. */
export const VolumetricSurvey = z
  .object({
    /** Short key (e1, e2); defaults to the position. */
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,15}$/)
      .optional(),
    date: z.iso.date(),
    label: z.string().min(1).optional(),
    /** DSM GeoTIFF (absolute, or relative to the project). Read only. */
    dsm: z.string().min(1).optional(),
    /** LAS, LAZ, E57 or PLY instead of a DSM. Read only. */
    cloud: z.string().min(1).optional(),
    /** Orthomosaic GeoTIFF (RGB or RGBA). Read only. */
    ortho: z.string().min(1).optional(),
  })
  .loose()
  .refine((s) => Boolean(s.dsm) !== Boolean(s.cloud), {
    message: 'Each survey needs a DSM or a point cloud.',
  });

/** The Volumetric Survey Kit job (`volumetric/job.json`): surveys first to last, optional grid. */
export const VolumetricBuildConfig = z
  .object({
    epochs: z.array(VolumetricSurvey).min(1).max(2),
    grid: z.record(z.string(), z.number()).optional(),
    detect: z.record(z.string(), z.unknown()).optional(),
    volume: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const VolumetricBuildParams = z
  .object({
    /** Kit job file, default `volumetric/job.json` (written by a first build). */
    job: z.string().min(1).optional(),
    config: VolumetricBuildConfig.optional(),
  })
  .strict();

export const PointcloudToCopcParams = z
  .object({
    /** LAS, LAZ, E57 or PLY file (absolute). Read only. */
    src: z.string().min(1),
    /** Project-relative COPC file; default `clouds/<name>.copc.laz`. */
    out: ProjectPath.optional(),
    /** Project CRS: the cloud is reprojected to it when the file declares its own. */
    epsg: z.number().int().min(1024).max(999999).optional(),
    origin: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .strict();

export const InspectionRunParams = z
  .object({
    /** `aio.detections/1` (or kit, COCO) files and folders; default the project's `detections/`. */
    detections: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Count unreviewed (draft) AI and model detections too. */
    includeDrafts: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    /** Same-class detections closer than this are one issue; default the kit's max(0.75 m, 2% of the height). */
    clusterM: z.number().min(0.01).max(1000).optional(),
    /** Field of view for photos without a lens; default the kit's 70 degrees. */
    hfovDeg: z.number().min(1).max(179).optional(),
    /** Kit vertical profile for zones and sides; default from the class catalogue's asset type. */
    profile: z.enum(['stack', 'tank', 'telecom-tower', 'ohtl-tower']).optional(),
    sheetsPer: z.number().int().min(1).max(64).optional(),
    sheetWidth: z.number().int().min(400).max(8000).optional(),
    /** YOLO class index to class id, comma separated (YOLO folders only). */
    yoloNames: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Folder for sheets, register, stats and the issue map; default `inspection`. */
    out: ProjectPath.optional(),
  })
  .strict();

const Epsg = z.number().int().min(1024).max(999999);

/** `road.build` (python `aio_pipelines/road/pipeline.py`): input files are read only. */
export const RoadBuildParams = z
  .object({
    /** GeoJSON (drawn in the app or from GIS), KML, DXF or the kit's centreline_utm.json. */
    centreline: z.string().min(1),
    /** CRS of a DXF centreline (default: the project CRS). */
    centrelineEpsg: Epsg.optional(),
    /** Orthomosaic GeoTIFF, or several blocks drawn in order. */
    ortho: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Finest ortho pixel (cm); default the GeoTIFF's own. */
    orthoCm: z.number().min(0.5).max(100).optional(),
    /** Defect polygons: GeoJSON, a shapefile (.shp) or the road review's defects.js. */
    defects: z.string().min(1).optional(),
    defectsEpsg: Epsg.optional(),
    /** Pavement footprint raster (pixels above 0); default the centreline buffered by the lanes. */
    pavement: z.string().min(1).optional(),
    /** Sample units along the road (default) or on a square grid as delivered for the Ring Road. */
    units: z.enum(['chainage', 'grid']).optional(),
    /** Unit length (chainage) or cell size (grid), metres. */
    unitLength: z.number().min(5).max(200).optional(),
    lanes: z.number().int().min(1).max(12).optional(),
    laneWidth: z.number().min(2).max(6).optional(),
    /** Grid origin (E, N) in the project CRS, without a pavement raster. */
    gridOrigin: z.tuple([z.number(), z.number()]).optional(),
    closeups: z.boolean().optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

export const SelfTestParams = z.object({ seconds: z.number().min(0).max(600).optional() }).strict();

// ---------------------------------------------------------------- M8 change and modelling
// Python resolves layers through the project manifest. Capture ids name the date pair of the
// change set; when absent, the layers' own `capture` fields are used. Defaults are the founder's
// change thresholds (`DEFAULT_CHANGE_THRESHOLDS`, 6 Oct 2026).

/** The date pair of a change set, when the layers do not carry `capture`. */
const CapturePair = z.object({ from: Id, to: Id }).strict();
/** A box in the project local frame, metres. */
const LocalBox = z.object({ min: Vec3, max: Vec3 }).strict();

/** `change.raster` (python `aio_pipelines/change/raster.py`). */
export const ChangeRasterParams = z
  .object({
    /** Capture ids of the earlier and later date. */
    from: Id,
    to: Id,
    /** Ortho raster layers of each date. */
    layerFrom: Id,
    layerTo: Id,
    method: z.enum(['gradient', 'ssim', 'rgb']),
    /** Change score threshold, 0 to 1; default from the `conservative` preset. */
    threshold: z.number().min(0).max(1).optional(),
    minAreaM2: z.number().positive().max(1e6).optional(),
    /** Refuse when the dates are shifted more than this (default 2 px). */
    maxShiftPx: z.number().min(0).max(100).optional(),
    /** Only inside this polygon (lon/lat). */
    mask: LonLatRing.optional(),
    /** Never inside these polygons (water, roads with traffic). */
    ignore: z.array(LonLatRing).max(200).optional(),
    /** Folder for the heat map, polygons and change set; default `change/<from>-<to>-raster`. */
    out: ProjectPath.optional(),
  })
  .strict();

const SurfaceInput = z.object({ layer: Id, kind: z.enum(['dsm', 'cloud']) }).strict();

/** `change.surface` (python `aio_pipelines/change/surface.py`). */
export const ChangeSurfaceParams = z
  .object({
    from: SurfaceInput,
    to: SurfaceInput,
    captures: CapturePair.optional(),
    /** Grid cell, metres; default the coarser input's. */
    cellM: z.number().min(0.01).max(100).optional(),
    /** Default 0.10 m and 1 m2. */
    minDepthM: z.number().positive().max(100).optional(),
    minAreaM2: z.number().positive().max(1e6).optional(),
    /** Areas to report volumes for (for example drawn boundaries). */
    areas: z
      .array(z.object({ id: Id, name: z.string().min(1).max(120), ring: LonLatRing }).strict())
      .max(500)
      .optional(),
    out: ProjectPath.optional(),
  })
  .strict();

/** `change.cloud` (python `aio_pipelines/change/cloud.py`). */
export const ChangeCloudParams = z
  .object({
    layerFrom: Id,
    layerTo: Id,
    captures: CapturePair.optional(),
    /** Significant change from (default 0.05 m). */
    minDistM: z.number().positive().max(10).optional(),
    /** "Far" class above (default 0.30 m). */
    maxDistM: z.number().positive().max(100).optional(),
    /** Signed distance along the local normal. */
    signed: z.boolean().optional(),
    /** Subsample spacing for the comparison, metres. */
    spacingM: z.number().positive().max(10).optional(),
    region: LocalBox.optional(),
    out: ProjectPath.optional(),
  })
  .strict();

/** `change.mesh` (python `aio_pipelines/change/mesh.py`). */
export const ChangeMeshParams = z
  .object({
    layerFrom: Id,
    layerTo: Id,
    captures: CapturePair.optional(),
    samples: z.number().int().min(1000).max(50_000_000).optional(),
    /** A part has changed when its mean deviation is above this (default 0.05 m). */
    minDistM: z.number().positive().max(10).optional(),
    maxDistM: z.number().positive().max(100).optional(),
    out: ProjectPath.optional(),
  })
  .strict();

/** `change.frames` (python `aio_pipelines/change/frames.py`): explicit pairs, or a pose search. */
export const ChangeFramesParams = z
  .object({
    pairs: z
      .array(z.object({ a: FrameRef, b: FrameRef }).strict())
      .min(1)
      .max(5000)
      .optional(),
    from: Id.optional(),
    to: Id.optional(),
    maxPoseM: z.number().positive().max(1000).optional(),
    maxAngleDeg: z.number().positive().max(180).optional(),
    minAreaPx: z.number().int().min(1).optional(),
    out: ProjectPath.optional(),
  })
  .strict()
  .refine((p) => Boolean(p.pairs) || (Boolean(p.from) && Boolean(p.to)), {
    message: 'Give the frame pairs, or the two dates to pair.',
  });

/** Parsed parameters of the M8 change pipelines (producers build them in the app). */
export type ChangeRasterParams = z.infer<typeof ChangeRasterParams>;
export type ChangeSurfaceParams = z.infer<typeof ChangeSurfaceParams>;
export type ChangeCloudParams = z.infer<typeof ChangeCloudParams>;
export type ChangeMeshParams = z.infer<typeof ChangeMeshParams>;
export type ChangeFramesParams = z.infer<typeof ChangeFramesParams>;

/** One control point: a drawing coordinate and where it lies on the map or in the model. */
export const DrawingControlPoint = z
  .object({
    drawing: z.tuple([z.number(), z.number()]),
    lonLat: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
    local: Vec3.optional(),
  })
  .strict()
  .refine((c) => (c.lonLat === undefined) !== (c.local === undefined), {
    message: 'A control point is placed on the map (lonLat) or in the model (local).',
  });

/** `drawing.import` (python `aio_pipelines/drawing/`). DXF only; DWG is not supported. */
export const DrawingImportParams = z
  .object({
    /** The DXF file (absolute). Read only. */
    src: z.string().min(1),
    /** Drawing units when the file states none (a unitless file is refused without it). */
    units: z.enum(['mm', 'cm', 'm', 'in', 'ft', 'us-ft']).optional(),
    /** DXF layers to import; default all. */
    layers: z.array(z.string().min(1)).max(1000).optional(),
    control: z.array(DrawingControlPoint).min(2).max(50).optional(),
    out: ProjectPath.optional(),
  })
  .strict();

/** `model.fit_cloud` (python `aio_pipelines/modelfit/`). */
export const ModelFitParams = z
  .object({
    /** Point cloud layer. */
    layer: Id,
    /** Only inside this box (local frame) or polygon (lon/lat). */
    region: z.union([LocalBox, LonLatRing]).optional(),
    kinds: z.array(ProcPartKind).min(1).optional(),
    /** RANSAC inlier distance, metres. */
    distM: z.number().positive().max(5).optional(),
    minInliers: z.number().int().min(10).optional(),
    /** Procedural model id to append the draft parts to; default a new model. */
    model: ProcModelId.optional(),
  })
  .strict();

// ---------------------------------------------------------------- M10 photogrammetry, OPF, tiles, packs
// Python stubs in `python/src/aio_pipelines/{photo,opf,tiles,packs}/` take the same parameter
// names (G0); each stream fills its own module. Paths named "absolute" are read in place, never
// written; outputs stay inside the project (`ProjectPath`), except raster packs, which go to the
// data folder's `packs/imagery/` or `packs/terrain/` (`dest`, chosen by main).

const MAX_PATH = 1024;

/** `photo.align` (python `aio_pipelines/photo/align.py`, G2). */
export const PhotoAlignParams = z
  .object({
    photos: PhotoSource,
    /** Run id; default a new one from the date (`20261007-1015`). */
    run: PhotoRunId.optional(),
    preset: PhotoPreset,
    matching: z.enum(['auto', 'gps', 'sequential', 'exhaustive']).optional(),
    mapper: z.enum(['auto', 'global', 'incremental']).optional(),
    /** How GNSS positions weigh: `auto` reads the RTK flag of each photo. */
    gnss: z.enum(['auto', 'rtk', 'standard', 'ignore']).optional(),
    /** PPK positions (`image, lat, lon, h, sh, sv` CSV, absolute path), replacing EXIF ones. */
    ppk: z.string().min(1).max(MAX_PATH).optional(),
    /** Default the project CRS (manifest `crs`). */
    crs: Crs.optional(),
    /** Longest image side for features, pixels; default from the preset. */
    maxImageSize: z.number().int().min(320).max(20_000).optional(),
  })
  .strict();

/** `photo.georef` (python `aio_pipelines/photo/georef.py`, G2). */
export const PhotoGeorefParams = z
  .object({
    run: PhotoRunId,
    /** Default `photogrammetry/<run>/gcp.json`. */
    gcp: ProjectPath.optional(),
    /** Keep GNSS position priors in the adjustment (default true). */
    useGnss: z.boolean().optional(),
  })
  .strict();

/** `photo.products` (python `aio_pipelines/photo/products.py`, G3). Existing layer kinds only. */
export const PhotoProductsParams = z
  .object({
    run: PhotoRunId,
    products: z.array(PhotoProduct).min(1),
    /** Default the run's preset. */
    preset: PhotoPreset.optional(),
    /** `cuda` only with the GPU accelerator (decision 5: M10.1 at the earliest). */
    dense: z.enum(['auto', 'cpu', 'cuda']).optional(),
    /** Ortho ground sample distance, cm; default the median GSD of the photos. */
    gsdCm: z.number().min(0.1).max(1000).optional(),
    region: LonLatRing.optional(),
    /** Survey date set on every new layer (a manifest capture id). */
    capture: Id.optional(),
    /** Triangle budget of the site-view GLB (default 2 M). */
    meshTriangles: z.number().int().min(10_000).max(50_000_000).optional(),
  })
  .strict();

/** `opf.import` (python `aio_pipelines/opf/importer.py`, G5). */
export const OpfImportParams = z
  .object({
    /** The `.opf` project file (absolute). Read only; files outside its folder are refused. */
    src: z.string().min(1).max(MAX_PATH),
    /** Outputs to bring in as layers when present; default all. */
    products: z.array(z.enum(['cloud', 'ortho', 'dsm', 'mesh'])).optional(),
    /** Where the photos are when the OPF's own paths do not resolve (absolute). */
    photosRoot: z.string().min(1).max(MAX_PATH).optional(),
  })
  .strict();

/** `opf.export` (python `aio_pipelines/opf/exporter.py`, G5). */
export const OpfExportParams = z
  .object({
    run: PhotoRunId,
    /** Folder to write the OPF project into (absolute, chosen in a save dialog). */
    out: z.string().min(1).max(MAX_PATH),
  })
  .strict();

/** `tiles.mesh` (python `aio_pipelines/tiles/mesh.py`, G7): a mesh layer or a run's full mesh. */
export const TilesMeshParams = z
  .object({
    layer: Id.optional(),
    /** A GLB or OBJ inside the project (a run's full-resolution mesh). */
    src: ProjectPath.optional(),
    id: TilesetId.optional(),
    name: z.string().min(1).max(200).optional(),
    run: PhotoRunId.optional(),
    compression: z.enum(['meshopt', 'draco', 'none']).optional(),
    maxTrianglesPerTile: z.number().int().min(1000).max(5_000_000).optional(),
    textureMaxPx: z.number().int().min(64).max(16_384).optional(),
  })
  .strict()
  .refine((p) => (p.layer === undefined) !== (p.src === undefined), {
    message: 'Give a mesh layer or a mesh file, not both.',
  });

/** `tiles.cloud` (python `aio_pipelines/tiles/cloud.py`, G7): a COPC layer to 3D Tiles points. */
export const TilesCloudParams = z
  .object({
    layer: Id,
    id: TilesetId.optional(),
    name: z.string().min(1).max(200).optional(),
    maxPointsPerTile: z.number().int().min(1000).max(5_000_000).optional(),
  })
  .strict();

const rasterPackParams = {
  /** GeoTIFF or COG files, or folders of them (absolute). Read only. */
  src: z.array(z.string().min(1).max(MAX_PATH)).min(1).max(10_000),
  /** `<data>/packs/imagery` or `<data>/packs/terrain` (absolute, set by main). */
  dest: z.string().min(1).max(MAX_PATH),
  id: RasterPackId,
  label: z.string().min(1).max(120),
  licence: z.string().min(1).max(200),
  attribution: z.string().min(1).max(500),
  provenance: z.string().max(300).optional(),
  minZoom: z.number().int().min(0).max(22).optional(),
  maxZoom: z.number().int().min(0).max(22).optional(),
};

/** `packs.imagery` (python `aio_pipelines/packs/imagery.py`, G7). */
export const ImageryPackParams = z
  .object({
    ...rasterPackParams,
    customerLicence: z.boolean(),
    format: z.enum(['webp', 'png', 'jpeg']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    tileSize: z.union([z.literal(256), z.literal(512)]).optional(),
  })
  .strict();

/** `packs.terrain` (python `aio_pipelines/packs/terrain.py`, G7). Terrarium encoding. */
export const TerrainPackParams = z
  .object({
    ...rasterPackParams,
    verticalDatum: TerrainDatum,
    /** As on imagery; optional here, absent means not customer-licensed (0.10 integration). */
    customerLicence: z.boolean().optional(),
    format: z.enum(['webp', 'png']).optional(),
  })
  .strict();

// ---------------------------------------------------------------- M11 surveying
// Python stubs in `python/src/aio_pipelines/{survey,design,geodesy,hydro,haul}/` take the same
// parameter names (G0); each stream fills its own module. Inputs read in place are absolute paths;
// outputs stay in `<project>/survey/` except exports, whose destination main chooses (`out`).

/** A ring in the project CRS (E, N), metres; the last point may repeat the first. */
const SiteRing = z.array(SitePoint2).min(3).max(100_000);

/** `survey.prepare` (python `aio_pipelines/survey/prepare.py`, G2; site tables G1). */
export const SurveyPrepareParams = z
  .object({
    surfaces: z
      .array(
        z
          .object({
            id: SurveyId,
            name: z.string().min(1).max(200),
            source: PreparedSurfaceSource,
            capture: Id.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    /** Tile cell, metres; default the source's own. */
    cellM: z.number().min(0.01).max(100).optional(),
    /** Also write `survey/geodesy/` (site transform and geoid subgrid); default true. */
    geodesy: z.boolean().optional(),
  })
  .strict();

/** `survey.compare` (python `aio_pipelines/survey/compare.py`, G2): stored items or the whole site. */
export const SurveyCompareParams = z
  .object({
    items: z
      .array(
        z
          .object({
            measurement: SurveyId,
            ring: SiteRing,
            item: ComparisonItem,
            /** The capture the measurement is viewed on (resolves `current` and `previous`). */
            capture: Id.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5000)
      .optional(),
    site: z
      .object({
        from: SurfaceRef,
        to: SurfaceRef,
        deadbandM: z.number().nonnegative().max(10).optional(),
        cellM: z.number().min(0.01).max(100).optional(),
        /** Restrict to a boundary; default the overlap of both surfaces. */
        ring: SiteRing.optional(),
      })
      .strict()
      .optional(),
    out: ProjectPath.optional(),
  })
  .strict()
  .refine(
    (p) => (p.items === undefined) !== (p.site === undefined),
    'Give items or site, not both.',
  );

/** `survey.overlay` (python `aio_pipelines/survey/overlay.py`, G5). */
export const SurveyOverlayParams = z
  .object({
    id: SurveyId.optional(),
    surface: SurveyId.optional(),
    comparison: z.object({ from: SurfaceRef, to: SurfaceRef }).strict().optional(),
    kind: OverlayKind,
    /**
     * Contours: `minorM`, `majorM`; slope: `style`, `stops`; elevation: `stops`, `stepped`;
     * relief: `azimuth`, `altitude`, `intensity`.
     */
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (p) => (p.surface === undefined) !== (p.comparison === undefined),
    'Give a surface or a comparison, not both.',
  );

const SectionSurface = z.union([
  SurveySurfaceRef,
  CurrentSurfaceRef,
  PreviousSurfaceRef,
  DesignSurfaceRef,
]);

/** `survey.section` (python `aio_pipelines/survey/section.py`, G5). */
export const SurveySectionParams = z
  .object({
    line: z.array(SitePoint2).min(2).max(10_000),
    surfaces: z.array(SectionSurface).min(1).max(20),
    format: z.enum(['dxf-2d-xy', 'dxf-2d-xz', 'dxf-2d-yz', 'dxf-3d-zup', 'dxf-3d-yup', 'csv']),
    /** The capture the section is viewed on. */
    capture: Id.optional(),
    /** Absolute output file, chosen by main. */
    out: z.string().min(1).max(MAX_PATH),
  })
  .strict();

/** `survey.export` (python `aio_pipelines/survey/export.py`, G7). */
export const SurveyExportParams = z
  .object({
    what: z.enum(['surface', 'ortho', 'cloud', 'contours', 'measurements', 'section']),
    format: z.enum(['geotiff', 'laz', 'dxf', 'landxml', '12da', 'csv', 'kml', 'shp', 'geojson']),
    /** `site`: the site grid, calibrated when a calibration applies. */
    crs: z.union([
      z.enum(['site', 'wgs84']),
      z.object({ epsg: z.number().int().positive() }).strict(),
    ]),
    units: DistanceUnit.optional(),
    /** Surfaces and clouds: keep this share of points or faces (1 = full). */
    decimate: z.number().gt(0).max(1).optional(),
    /** What to export: a prepared surface, a layer, an overlay or measurement ids. */
    surface: SurveyId.optional(),
    layer: Id.optional(),
    overlay: SurveyId.optional(),
    measurements: z.array(SurveyId).max(20_000).optional(),
    /** Absolute output file or folder, chosen by main. */
    out: z.string().min(1).max(MAX_PATH),
  })
  .strict();

/** `survey.qa` (python `aio_pipelines/survey/qa.py`, G8). */
export const SurveyQaParams = z
  .object({
    capture: Id,
    surface: SurveyId,
    level: QaLevel,
    /** Checkpoints: a CSV (absolute) or the M10 GCP file of a run. */
    checkpoints: z
      .union([
        z.object({ csv: z.string().min(1).max(MAX_PATH) }).strict(),
        z.object({ gcp: ProjectPath }).strict(),
      ])
      .optional(),
    previous: z.object({ capture: Id, surface: SurveyId }).strict().optional(),
  })
  .strict();

/** `survey.cleanup` (python `aio_pipelines/survey/cleanup.py`, G8). */
export const SurveyCleanupParams = z
  .object({
    /** The prepared surface the edits apply to. */
    surface: SurveyId.optional(),
    /** Edits from `survey/cleanups.json`, applied in order. */
    edits: z.array(SurveyId).max(2000).optional(),
    /** A DTM from a cloud layer with a filter preset (PDAL smrf or csf). */
    dtmFilter: z
      .object({
        layer: Id,
        preset: z.enum(['equipment', 'equipment-vegetation', 'structures', 'everything']),
      })
      .strict()
      .optional(),
    /** The derived surface id; default `<capture>-clean`. */
    out: SurveyId.optional(),
  })
  .strict()
  .refine(
    (p) => (p.surface !== undefined && p.edits !== undefined) !== (p.dtmFilter !== undefined),
    'Give a surface with edits, or a DTM filter.',
  );

/** `design.import` (python `aio_pipelines/design/importer.py`, G6). */
export const DesignImportParams = z
  .object({
    /** The design file (absolute); copied byte for byte into `survey/designs/<id>/`. */
    src: z.string().min(1).max(MAX_PATH),
    /** Default from the extension and content. */
    format: DesignFormat.optional(),
    id: DesignId.optional(),
    name: z.string().min(1).max(200).optional(),
    crs: Crs.optional(),
    /** Place local coordinates through the site calibration. */
    useCalibration: z.boolean().optional(),
    /** Default from the file (`INSUNITS`, LandXML `Units`). */
    units: DesignSourceUnits.optional(),
    /** Source layer names to import; default all. */
    layers: z.array(z.string().min(1).max(200)).max(1000).optional(),
  })
  .strict();

/** `geo.calibration` (python `aio_pipelines/geodesy/calibration.py`, G1). */
export const GeoCalibrationParams = z
  .object({
    /** A controller file (absolute): JobXML, `.dc`, 12d, `.cal`. */
    src: z.string().min(1).max(MAX_PATH).optional(),
    format: CalibrationSourceFormat.optional(),
    /** Or point pairs to solve by least squares. */
    pairs: z.array(CalibrationPair).min(1).max(500).optional(),
    /** The base projection. */
    crs: Crs,
    verticalDatum: SiteVerticalDatum.optional(),
    geoid: GeoidPackId.optional(),
  })
  .strict()
  .refine(
    (p) => (p.src === undefined) !== (p.pairs === undefined),
    'Give a file or point pairs, not both.',
  );

/** `hydro.flood` (python `aio_pipelines/hydro/flood.py`, G10). */
export const HydroFloodParams = z
  .object({
    surface: SurveyId,
    levelM: z.number(),
    /** `connected`: only water connected to `seed`; `all-below`: every cell below the level. */
    mode: z.enum(['connected', 'all-below']),
    seed: SitePoint2.optional(),
    region: SiteRing.optional(),
    run: SurveyId.optional(),
  })
  .strict();

/** `hydro.flow` (python `aio_pipelines/hydro/flow.py`, G10). */
export const HydroFlowParams = z
  .object({
    surface: SurveyId,
    mode: z.enum(['runoff', 'catchment', 'streams']),
    drop: SitePoint2.optional(),
    outlets: z.array(SitePoint2).max(100).optional(),
    method: z.enum(['d8', 'dinf']).optional(),
    depressions: z.enum(['fill', 'breach']).optional(),
    /** Stream threshold: contributing area, square metres. */
    streamAreaM2: z.number().positive().optional(),
    region: SiteRing.optional(),
    run: SurveyId.optional(),
  })
  .strict();

/** `hydro.rainfall` (python `aio_pipelines/hydro/rainfall.py`, G10; decision 3). */
export const HydroRainfallParams = z
  .object({
    surface: SurveyId,
    /** Rainfall CSV (absolute): time in minutes, intensity in mm/h. */
    hyetograph: z.string().min(1).max(MAX_PATH),
    manningN: z.number().positive().max(1),
    infiltrationMmPerH: z.number().nonnegative().max(1000),
    cellM: z.union([z.literal(0.5), z.literal(1), z.literal(2)]),
    durationMin: z.number().positive().max(10_080).optional(),
    region: SiteRing.optional(),
    run: SurveyId.optional(),
  })
  .strict();

/** `haul.analyse` (python `aio_pipelines/haul/analyse.py`, G11). */
export const HaulAnalyseParams = z
  .object({
    surface: SurveyId,
    /** A drawn centreline (E, N) or a design alignment or polyline layer. */
    centreline: z.union([
      z.array(SitePoint2).min(2).max(100_000),
      z.object({ design: DesignId, layer: DesignId }).strict(),
    ]),
    intervalM: z.number().positive().max(1000),
    limits: z
      .object({
        minWidthM: z.number().positive().optional(),
        maxGradePct: z.number().positive().optional(),
        crossFallMinPct: z.number().optional(),
        crossFallMaxPct: z.number().optional(),
        minBermHeightM: z.number().positive().optional(),
      })
      .strict(),
    run: SurveyId.optional(),
  })
  .strict();

export type PhotoAlignParams = z.infer<typeof PhotoAlignParams>;
export type PhotoGeorefParams = z.infer<typeof PhotoGeorefParams>;
export type PhotoProductsParams = z.infer<typeof PhotoProductsParams>;
export type OpfImportParams = z.infer<typeof OpfImportParams>;
export type OpfExportParams = z.infer<typeof OpfExportParams>;
export type TilesMeshParams = z.infer<typeof TilesMeshParams>;
export type TilesCloudParams = z.infer<typeof TilesCloudParams>;
export type ImageryPackParams = z.infer<typeof ImageryPackParams>;
export type TerrainPackParams = z.infer<typeof TerrainPackParams>;
export type SurveyPrepareParams = z.infer<typeof SurveyPrepareParams>;
export type SurveyCompareParams = z.infer<typeof SurveyCompareParams>;
export type SurveyOverlayParams = z.infer<typeof SurveyOverlayParams>;
export type SurveySectionParams = z.infer<typeof SurveySectionParams>;
export type SurveyExportParams = z.infer<typeof SurveyExportParams>;
export type SurveyQaParams = z.infer<typeof SurveyQaParams>;
export type SurveyCleanupParams = z.infer<typeof SurveyCleanupParams>;
export type DesignImportParams = z.infer<typeof DesignImportParams>;
export type GeoCalibrationParams = z.infer<typeof GeoCalibrationParams>;
export type HydroFloodParams = z.infer<typeof HydroFloodParams>;
export type HydroFlowParams = z.infer<typeof HydroFlowParams>;
export type HydroRainfallParams = z.infer<typeof HydroRainfallParams>;
export type HaulAnalyseParams = z.infer<typeof HaulAnalyseParams>;

const PARAMS = {
  'aik.cameras': AikCamerasParams,
  'aik.project': AikProjectParams,
  'aik.records': AikRecordsParams,
  'volumetric.process': VolumetricProcessParams,
  'pointcloud.to_copc': PointcloudToCopcParams,
  'inspection.run': InspectionRunParams,
  'road.build': RoadBuildParams,
  'system.selftest': SelfTestParams,
  'volumetric.build': VolumetricBuildParams,
  'change.raster': ChangeRasterParams,
  'change.surface': ChangeSurfaceParams,
  'change.cloud': ChangeCloudParams,
  'change.mesh': ChangeMeshParams,
  'change.frames': ChangeFramesParams,
  'drawing.import': DrawingImportParams,
  'model.fit_cloud': ModelFitParams,
  'photo.align': PhotoAlignParams,
  'photo.georef': PhotoGeorefParams,
  'photo.products': PhotoProductsParams,
  'opf.import': OpfImportParams,
  'opf.export': OpfExportParams,
  'tiles.mesh': TilesMeshParams,
  'tiles.cloud': TilesCloudParams,
  'packs.imagery': ImageryPackParams,
  'packs.terrain': TerrainPackParams,
  'survey.prepare': SurveyPrepareParams,
  'survey.compare': SurveyCompareParams,
  'survey.overlay': SurveyOverlayParams,
  'survey.section': SurveySectionParams,
  'survey.export': SurveyExportParams,
  'survey.qa': SurveyQaParams,
  'survey.cleanup': SurveyCleanupParams,
  'design.import': DesignImportParams,
  'geo.calibration': GeoCalibrationParams,
  'hydro.flood': HydroFloodParams,
  'hydro.flow': HydroFlowParams,
  'hydro.rainfall': HydroRainfallParams,
  'haul.analyse': HaulAnalyseParams,
} as const satisfies Record<PipelineName, z.ZodType>;

export function pipelineParams(name: PipelineName): z.ZodType<Record<string, unknown>> {
  return PARAMS[name];
}

/** Same rule as the Python runtime: a file-name-safe id. */
export const JobId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'Not a valid job id');

/** `20261004-101500-aik-cameras-a1b2`: sortable by start time, readable in a file browser. */
export function newJobId(
  pipeline: PipelineName,
  at: Date,
  random: () => number = Math.random,
): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(at.getFullYear())}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`;
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${stamp}-${pipeline.replace('.', '-')}-${tail}`;
}

export const JobStatus = z.enum([
  'starting',
  'running',
  'cancelling',
  'done',
  'failed',
  'cancelled',
  /** The app quit or the runtime process died while the job ran; it can resume. */
  'interrupted',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const StepState = z.enum(['pending', 'running', 'done', 'skipped', 'failed', 'cancelled']);

export const JobStep = z.object({
  name: z.string(),
  title: z.string().optional(),
  state: StepState,
  message: z.string().optional(),
});

export const JobArtifact = z.object({ path: z.string(), kind: z.string() });

export const JobRecord = z.object({
  id: JobId,
  pipeline: PipelineName,
  /** Absolute project folder the job reads and writes. */
  project: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  status: JobStatus,
  /** 0 to 1 over the whole job. */
  progress: z.number().min(0).max(1),
  steps: z.array(JobStep),
  /** Latest progress message. */
  message: z.string().optional(),
  error: z.string().optional(),
  artifacts: z.array(JobArtifact),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Pack version that ran the job last. */
  packVersion: z.string().optional(),
});
export type JobRecord = z.infer<typeof JobRecord>;
export type JobStep = z.infer<typeof JobStep>;
export type StepState = z.infer<typeof StepState>;

export const JobLogLine = z.object({
  time: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error', 'stderr']),
  message: z.string(),
  step: z.string().optional(),
});
export type JobLogLine = z.infer<typeof JobLogLine>;

/** The pipeline pack the app found under `<data folder>/runtime/`. */
export const RuntimeInfo = z.object({
  found: z.boolean(),
  version: z.string().optional(),
  dir: z.string().optional(),
  /** Why no pack is usable, in words for the person. */
  problem: z.string().optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

/** One `pipeline-pack-<version>` folder in `<data folder>/runtime/` (Settings, Processing tools). */
export const InstalledPack = z.object({
  /** The folder name, `pipeline-pack-<version>`. */
  name: z.string(),
  version: z.string(),
  dir: z.string(),
  bytes: z.number().nonnegative(),
  /** False for a folder without a readable manifest or its Python (a half-copied pack). */
  valid: z.boolean(),
});
export type InstalledPack = z.infer<typeof InstalledPack>;

/**
 * The pipeline pack as Settings, Processing tools shows it. `state`: `ok` (every job this app can
 * start is in the pack), `too-old` (a pack is in use but `needs` lists what it lacks), `incompatible`
 * (packs are there but none is made for this app version), `missing`, or `dev` (the pack comes from
 * `QUADRION_PIPELINE_PYTHON` or `QUADRION_PIPELINE_PACK`, not from the data folder).
 */
export const PipelinePackStatus = z.object({
  state: z.enum(['ok', 'too-old', 'incompatible', 'missing', 'dev']),
  version: z.string().optional(),
  dir: z.string().optional(),
  bytes: z.number().nonnegative().optional(),
  /** `<data folder>/runtime`: where packs are installed. */
  runtimeDir: z.string(),
  /** This computer as a pack manifest names it (`win32-x64`). */
  platform: z.string(),
  /** What a newer pack is needed for, a plain sentence each (`too-old`). */
  needs: z.array(z.string()),
  /** Why no pack is usable (`missing`, `incompatible`), in words for the person. */
  problem: z.string().optional(),
  /** The other pack folders in `runtime`, newest first: not in use, safe to remove. */
  others: z.array(InstalledPack),
  /** An install is running (`pipelinePack:progress` follows it). */
  installing: z.boolean(),
  /** False in an automated run: the start notice stays away (QUADRION_PACK_NOTICE=1 brings it back). */
  notify: z.boolean(),
});
export type PipelinePackStatus = z.infer<typeof PipelinePackStatus>;

/** A pipeline pack archive found beside the app, in Downloads or in `runtime` (names and manifest only). */
export const PackArchive = z.object({
  path: z.string(),
  version: z.string(),
  where: z.enum(['app', 'downloads', 'runtime']),
  bytes: z.number().nonnegative(),
});
export type PackArchive = z.infer<typeof PackArchive>;

/** Progress of `pipelinePack:install`: archive bytes read and entries unpacked. */
export const PackInstallProgress = z.object({
  phase: z.enum(['unpack', 'check', 'activate', 'done', 'failed', 'cancelled']),
  bytesDone: z.number().nonnegative(),
  bytesTotal: z.number().nonnegative(),
  entries: z.number().int().nonnegative(),
});
export type PackInstallProgress = z.infer<typeof PackInstallProgress>;

export const JobStartRequest = z.union([
  z
    .object({
      pipeline: PipelineName,
      project: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ resume: JobId }).strict(),
]);

export const JobEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), job: JobRecord }),
  z.object({ type: z.literal('log'), jobId: JobId, line: JobLogLine }),
]);
export type JobEvent = z.infer<typeof JobEvent>;

/** `manifest.json` at the root of a pipeline pack (written by tools/pipeline-pack/build.mjs). */
export const PipelinePackManifest = z.object({
  schema: z.literal('aio.pipeline-pack/1'),
  version: z.string().min(1),
  protocol: z.string(),
  python: z.object({ version: z.string(), build: z.string(), executable: z.string().min(1) }),
  platform: z.string(),
  createdAt: z.string(),
  pipelines: z.array(z.object({ name: z.string(), title: z.string() })),
  /** M9 T8: the app versions the pack works with (`>=0.9.0 <2.0.0`); absent in older packs. */
  appRange: z.string().min(1).max(100).optional(),
  files: z.record(
    z.string(),
    z.object({ size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});
export type PipelinePackManifest = z.infer<typeof PipelinePackManifest>;
