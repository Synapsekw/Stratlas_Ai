import { z } from 'zod';
import { FrameRef, LonLatRing } from './change';
import { Id, Vec3 } from './common';
import { ProcModelId, ProcPartKind } from './procmodel';

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
];

/** A path inside the project folder: relative, no `..`, no drive letter. */
export const ProjectPath = z
  .string()
  .min(1)
  .max(260)
  .refine(
    (p) => {
      const n = p.replace(/\\/g, '/');
      return !n.startsWith('/') && !/^[A-Za-z]:/.test(n) && !n.split('/').includes('..');
    },
    { message: 'Output paths must stay inside the project folder.' },
  );

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
  files: z.record(
    z.string(),
    z.object({ size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});
export type PipelinePackManifest = z.infer<typeof PipelinePackManifest>;
