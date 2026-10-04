import { z } from 'zod';

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
  'road.build',
  'system.selftest',
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
    name: 'pointcloud.to_copc',
    title: 'Point cloud to COPC',
    description: 'LAS, LAZ or E57 to a COPC file in the project CRS, added as a layer (PDAL).',
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

const PARAMS = {
  'aik.cameras': AikCamerasParams,
  'aik.project': AikProjectParams,
  'aik.records': AikRecordsParams,
  'volumetric.process': VolumetricProcessParams,
  'pointcloud.to_copc': PointcloudToCopcParams,
  'road.build': RoadBuildParams,
  'system.selftest': SelfTestParams,
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
