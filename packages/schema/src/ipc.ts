import { z } from 'zod';
import { AiErrorCode, AiProvider, AiTask, ToolRisk, WindowKind } from './agent';
import { Issue } from './annotation';
import { Conversation, ConversationId, ConversationSummary } from './conversation';
import {
  JobEvent,
  JobId,
  JobLogLine,
  JobRecord,
  JobStartRequest,
  PackArchive,
  PackInstallProgress,
  PipelinePackStatus,
  RuntimeInfo,
} from './jobs';
import {
  AltitudeChoice,
  AltitudePlan,
  CapturePatch,
  DrawingStem,
  ImportHeights,
  ImportItem,
  LayerPatch,
  NewProjectRequest,
  ProjectPurpose,
  ReportBrand,
  SeverityTemplate,
} from './builder';
import { SELECTION_MAX_POINTS, SelectionName, selectionByteLength } from './selection';
import { ProjectManifest } from './manifest';
import { ClassCatalogue, LibraryClass, SeverityModel } from './severity';
import { HexColor, IsoDate, ProjectPath, Vec3 } from './common';
import { AntennaAiLabel, AntennasFile } from './antennas';
import { CleanupLayerId, NoiseRun, PointcloudCleanup } from './pointcloudCleanup';
import { PanoQuality, PanoScan } from './panoStitch';
import {
  AntennaId,
  CatalogueId,
  CatalogueOrigin,
  RfCatalogueEntry,
  RfRun,
  RfRunId,
  RfSectorsFile,
  RfOriginsMap,
} from './rf';
import { AiPolicy, EditPolicy, ExportKind, PackageInfo, PackageOrigin } from './package';
import { BoundaryEditsFile, VolumesFile } from './volumes';
import { DetectionsFile } from './detections';
import { NarrativeFile, ReportContentsSettings } from './report';
import { ReportTemplateFile } from './reportTemplate';
import { OrientationFile } from './orientation';
import { ReleaseNotes, UpdateStatus } from './update';
import { WebsiteUpdateStatus, WebsiteUpdateResult } from './websiteUpdate';
import { ChangeKind, ChangeSet, ChangeSetId, ChangeSetSummary, ChangeThresholds } from './change';
import { ProcModel, ProcModelId, ProcModelSummary } from './procmodel';
import { Detail, EngineerProposal, EngineerRun, EngineerSetup, RunId } from './engineer';
import { EvidencePack } from './modelEvidence';
import { ComponentObservation } from './componentObservation';
import {
  DetectorModelId,
  DetectorModelInfo,
  InferenceItem,
  InferenceRuntime,
  InferenceSettings,
} from './inference';
import { FetchPolicy, LayerBlobStatus } from './blobs';
import {
  ApprovalDecision,
  CollabState,
  CollabTarget,
  CommentId,
  PolicySetPayload,
  SavedView,
} from './collab';
import { Id, Sha256Hex } from './common';
import { ExchangeKind, ExchangePreview, Heads, TeamProjectId } from './exchange';
import { ActorId, DeviceId, Identity, Initials, Member, PersonName, Role } from './identity';
import { LaunchSettings } from './launch';
import { LayerExportResult, LayerInfo } from './layerInfo';
import {
  MapKeyProvider,
  MapKeysStatus,
  OnlineSourceId,
  OnlineTileCache,
  OnlineTilesStatus,
} from './onlineImagery';
import { DesignFormat, DesignsFile, DesignSourceUnits } from './designs';
import { HydroRun } from './hydro';
import { HaulRun } from './haul';
import { CrsCatalogueEntry, GeoidPackId, GeoidPackMeta, SiteCalibration } from './geodesy';
import {
  HeightTiles,
  MeasurementsFile,
  SitePoint2,
  SurveyQa,
  SurveyOverlaysFile,
  SurveySettings,
  SurveyTemplatesFile,
  TerrainEditsFile,
} from './survey';
import {
  AuditEntry,
  AuditExportFormat,
  AuditFilter,
  EditCommand,
  OpId,
  RecordRef,
  VerifyReport,
  Via,
} from './journal';
import { Conflict, QuarantineEntry, ServerInfo, SyncMode, TeamStatus } from './sync';
import {
  AccuracyReport,
  GcpFile,
  HardwareProbe,
  PhotoEstimate,
  PhotoPreset,
  PhotoProduct,
  PhotoRun,
  PhotoRunId,
  PhotoRunSummary,
  PhotoSource,
} from './photogrammetry';
import {
  GlobeSettings,
  GlobeSite,
  ImageryImportRequest,
  RasterPackId,
  RasterPackInfo,
  TerrainImportRequest,
} from './globe';
import { TilesetEntry, TilesetsFile } from './tilesets';
import { WalkFile } from './walks';
import { WalkProcessSummary } from './walkProcess';
import { RemovalPlan, RemoveTarget } from './removal';
import {
  OdmGpuSetting,
  OdmInstallProgress,
  OdmInstallResult,
  OdmStatus,
  ProcessingSettings,
} from './odm';

const Empty = z.object({}).strict();

/**
 * Why a request failed, for the renderer to act on: `not-implemented` (the channel exists but this
 * build does not do it yet), `read-only` (a package or player mode), `forbidden` (M9: the role or
 * the entitlement does not allow it), `offline-only` (M9: the workstation allows no network).
 */
export const FailureCode = z.enum(['not-implemented', 'read-only', 'forbidden', 'offline-only']);
const Failure = z.object({ ok: z.literal(false), error: z.string(), code: FailureCode.optional() });
const OkOrFailure = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true) }), Failure]);
const ProjectId = z.string().min(1);

/** The checks of a written engineering GLB (`engineer:validate`; `@aio/modelling` `GlbReport`). */
export const GlbCheckReport = z
  .object({
    validatorErrors: z.number().int().nonnegative(),
    validatorWarnings: z.number().int().nonnegative(),
    messages: z.array(z.string()).max(200),
    finite: z.boolean(),
    indicesValid: z.boolean(),
    normalsUnit: z.boolean(),
    degenerate: z.number().int().nonnegative(),
    duplicateTris: z.number().int().nonnegative(),
    unintendedHoles: z.array(z.object({ node: z.string(), loops: z.number().int() })).max(500),
    intendedOpenOk: z.boolean(),
    openingProblems: z.array(z.object({ node: z.string(), problem: z.string() })).max(500),
    triangles: z.number().int().nonnegative(),
    withinBudget: z.boolean(),
  })
  .strict();
export type GlbCheckReport = z.infer<typeof GlbCheckReport>;

/** How an engineering GLB was meshed: coarsened for the budget, or not built at all. */
export const GlbBuildReport = z
  .object({
    triangles: z.number().int().nonnegative(),
    overBudget: z.boolean(),
    /** The coarsest detail level used. */
    detail: Detail,
    simplified: z.array(z.object({ id: z.string(), detail: Detail }).strict()),
    failed: z.array(z.object({ id: z.string(), reason: z.string() }).strict()),
    notes: z.array(z.string()),
  })
  .strict();
export type GlbBuildReport = z.infer<typeof GlbBuildReport>;

/** A detection pass file name in `<project>/detections/` (`review.json`, `ai-<run>.json`). */
export const DetectionPassName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/, 'A pass file is a plain .json file name.');

/** One image of an `ai:detect` request: scaled down and encoded in the renderer. */
export const DetectImage = z
  .object({
    /** The caller's key for the image (photo or frame), echoed in the result. */
    key: z.string().min(1).max(300),
    dataUrl: z.string().startsWith('data:image/'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

/** One proposal in an `ai:detect` result, coordinates normalised (0 to 1, top-left origin). */
export const AiDetectionResult = z.object({
  classId: z.string(),
  label: z.string(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  polygon: z.array(z.tuple([z.number(), z.number()])).optional(),
  confidence: z.number().min(0).max(1).optional(),
  severity: z.number().int().nullable().optional(),
  uncertain: z.boolean().optional(),
  note: z.string().optional(),
});

export const LibraryFolderId = z.string().regex(/^f_[a-z0-9]{10}$/);
export const LibraryFolder = z.object({
  id: LibraryFolderId,
  name: z.string().trim().min(1).max(60),
});
export type LibraryFolder = z.infer<typeof LibraryFolder>;

export const LibraryEntry = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  customer: z.string().optional(),
  site: z.string().optional(),
  kind: z.enum(['native', 'aik', 'volumetric', 'road', 'twin']),
  sizeBytes: z.number().int().nonnegative().optional(),
  lastOpened: z.string().optional(),
  /** aio:// URL of a poster image. */
  thumbnail: z.string().optional(),
  captureDate: z.string().optional(),
  layerCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** Set when the entry is a single-file `.aio` package rather than a folder. */
  package: z.object({ encrypted: z.boolean(), readOnly: z.boolean() }).optional(),
  /**
   * Set on the demo projects that ship with the app (synthetic data, `resources/demo/`); `primary`
   * is the one the first-start welcome opens. `copy`: its working copy on this computer, the folder
   * a delete moves to the recycle bin; absent when there is none.
   */
  demo: z.object({ primary: z.boolean(), copy: z.string().optional() }).optional(),
  /** M9: a shared project's badge (mode, unread comments, conflicts, ops not yet sent). */
  team: z
    .object({
      mode: SyncMode,
      unread: z.number().int().nonnegative(),
      conflicts: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    })
    .optional(),
  /** Per computer: the library folder the card is in; absent when loose. */
  folderId: LibraryFolderId.optional(),
  /** The manifest's purpose when this build knows it (cover colours). */
  purpose: ProjectPurpose.optional(),
  /**
   * The card shows a changed cover: a per-computer one (userData covers/), or Change thumbnail
   * wrote the folder's `thumbnail.jpg` and kept its own picture as `thumbnail.original.jpg`.
   */
  customCover: z.boolean().optional(),
});

const CoverJpeg = z
  .instanceof(Uint8Array)
  .refine((d) => d.byteLength > 3 && d.byteLength <= 512 * 1024, {
    message: 'A cover is a JPEG of at most 512 KB',
  });

/** Per-machine sync preferences (M9). Absent: no auto-sync, every 15 minutes, 50 GB of blobs. */
export const TeamSettings = z.object({
  autoSync: z.boolean().optional(),
  intervalMin: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  blobCacheGb: z.number().min(1).max(100_000).optional(),
});

/** What a first start finds on this workstation, so the welcome can explain each missing piece. */
export const SetupStatus = z.object({
  dataRoot: z.string(),
  /** The data folder exists (it is created with the first project or pack). */
  dataRootExists: z.boolean(),
  /** Offline map packs installed. */
  mapPacks: z.number().int().nonnegative(),
  /** The pipeline pack that builds projects from raw data (Jobs). */
  pipeline: z.object({
    found: z.boolean(),
    version: z.string().optional(),
    problem: z.string().optional(),
    /** PDAL was found (the pack's `tools/pdal`, `AIO_PDAL` or the PATH): DTM filter presets. */
    pdal: z.boolean().optional(),
  }),
});

/** An OpenAI-compatible model server on this machine (for example Ollama). Off by default. */
export const LocalModelSettings = z.object({
  enabled: z.boolean(),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().min(1).max(200),
  // ---- M8 (AI-9): the person's own server (Ollama, LM Studio, llama.cpp server); nothing bundled
  /** Server kind found by discovery: Ollama's own API, or any OpenAI-compatible server. */
  kind: z.enum(['ollama', 'openai-compatible']).optional(),
  /** Context window of the model, tokens (bounds output and conversation trimming). */
  contextTokens: z.number().int().min(512).max(10_000_000).optional(),
  /** `compact`: a short tool list with short descriptions for small models. */
  toolProfile: z.enum(['full', 'compact']).optional(),
  /** What the capability probe measured (absent: not probed). */
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean() }).strict().optional(),
  /** Request timeout, ms (first token included: model load can be slow). */
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
});

/** One model a local server offers (`ai:localModels`). */
export const LocalModelInfo = z.object({
  id: z.string().min(1).max(200),
  name: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contextTokens: z.number().int().positive().optional(),
  /** Claimed by the server; `ai:localProbe` checks them. */
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  family: z.string().optional(),
  quantization: z.string().optional(),
});

export const ModelRouteSchema = z.object({
  task: AiTask,
  provider: AiProvider,
  model: z.string().min(1),
  /**
   * "Treat as vision model" in Settings: the person vouches that this route's model reads images
   * and returns structured output, so an unknown model may run the engineer step (with
   * conservative limits). Absent means off.
   */
  treatAsVision: z.boolean().optional(),
});

/** One evidence image of an engineer request: a pack image id, never a path. */
const EngineerImageKind = z.enum(['photo', 'side', 'top', 'slice', 'crop', 'generated']);
const EngineerCallImage = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
    kind: EngineerImageKind,
    dataUrl: z
      .string()
      .max(40_000_000)
      .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
    bytes: z.number().int().nonnegative(),
    view: z.string().max(40).optional(),
  })
  .strict();

/** The engineer request of one pass of a run (`ai:engineerPreview`, `ai:engineer`). */
const EngineerCallRequest = z
  .object({
    projectId: z.string().min(1),
    /** The engineering run (`engineering/<run>/`): cache folder, cost cap and AI time. */
    engineerRun: RunId,
    approvalScope: z.enum(['request', 'run']).optional(),
    pass: z.number().int().min(1).max(3),
    images: z.array(EngineerCallImage).max(64),
    /** The evidence pack's measurement summary (JSON text); main refuses one over 40 000. */
    summary: z.string().max(200_000),
    observations: z.array(ComponentObservation).max(512).optional(),
    setup: EngineerSetup,
    previous: EngineerProposal.optional(),
  })
  .strict();

/** The send preview's content: exactly the request text and images. */
const EvidencePreviewContent = z.object({
  measurements: z.string().optional(),
  text: z.string(),
  images: z.array(
    z.object({
      id: z.string(),
      kind: EngineerImageKind,
      label: z.string(),
      thumb: z.string(),
      bytes: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      resized: z.boolean(),
    }),
  ),
  leftOut: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
});

/** The outcome of one engineer request. */
const EngineerOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proposal'),
    proposal: EngineerProposal,
    cached: z.boolean(),
    costUsd: z.number().nonnegative(),
    identityConflict: z.literal(true).optional(),
    stopped: z.literal('budget').optional(),
    /** Tokens of the request (absent for a cached reply or when the provider does not say). */
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  }),
  z.object({
    kind: z.literal('refused'),
    approvalRequired: z.boolean().optional(),
    reason: z.string(),
    code: z.enum([
      'offline',
      'policy',
      'no-key',
      'capability',
      'budget',
      'identity',
      /** Another request of this engineering run is in flight. */
      'busy',
      /** The run's 10 minutes of AI time are used up. */
      'time',
    ]),
  }),
  z.object({
    kind: z.literal('failed'),
    error: z.string(),
    code: z.enum(['invalid', 'rate-limit', 'network', 'provider', 'cancelled']),
  }),
]);

/** Tokens and estimated cost for one provider. */
export const ProviderUsage = z.object({
  provider: z.string().min(1),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** False when a model had no price in the table: the cost is then a lower bound. */
  costKnown: z.boolean(),
});

export const ProjectUsage = z.object({
  /** Normalised project root, the key of the usage store. */
  key: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  providers: z.array(ProviderUsage),
});

/**
 * The person's own company branding for the reports Stratlas generates (issue register PDF).
 * The logo file lives in the app's userData `branding/` folder (never in a project) and is
 * served as `aio://branding/<logo>`. Unset fields mean neutral reports: no company name, no logo.
 */
export const ReportBrandingSettings = z.object({
  companyName: z.string().max(120).optional(),
  /** Accent colour of the report (cover, rules), `#rrggbb`. */
  accent: HexColor.optional(),
  /** File name of the copied logo inside userData `branding/`, e.g. `logo-1a2b3c4d.png`. */
  logo: z
    .string()
    .regex(/^logo-[a-z0-9]{6,64}\.(png|jpg|svg)$/)
    .optional(),
});

/** A crash the app recorded locally (diagnostics), shown once as a notice. */
export const CrashNotice = z.object({
  /** `closed`: the app ended unexpectedly; `window`: the window stopped and was reloaded. */
  kind: z.enum(['closed', 'window']),
  /** Id of the crash report in userData `crash-reports/`. */
  report: z.string(),
  time: z.string(),
  process: z.string(),
  reason: z.string(),
});

/** An http(s) URL, or empty for "not set". */
const OptionalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ })]);

export const Settings = z.object({
  cloudAi: z.boolean(),
  /** `system` follows the operating system's light or dark preference. */
  theme: z.enum(['dark', 'light', 'system']),
  sidebarCollapsed: z.boolean(),
  /** Folder that holds projects and map packs, e.g. E:\Stratlas Data. */
  dataRoot: z.string(),
  routes: z.array(ModelRouteSchema),
  /** Optional so settings written before the local provider existed stay valid. */
  localModel: LocalModelSettings.optional(),
  /** Layout direction of the UI (Arabic readiness). Default `ltr`. */
  direction: z.enum(['ltr', 'rtl']).optional(),
  /** `more` always raises contrast; `system` (default) follows the OS (prefers-contrast). */
  contrast: z.enum(['system', 'more']).optional(),
  /** `reduce` always cuts motion (camera flights jump, no fades); `system` follows the OS. */
  motion: z.enum(['system', 'reduce']).optional(),
  /**
   * Offline-only workstation: every online action (map pack download, update check, team server,
   * cloud AI) is disabled. A local model on this machine stays available. Default false; the app
   * still makes no request unless the person starts one.
   */
  offlineOnly: z.boolean().optional(),
  /** Allow the "Check now" button for online updates (ADR 0003). Default false. */
  updateCheck: z.boolean().optional(),
  websiteAutoUpdate: z.boolean().optional(),
  /**
   * Address of the update feed: the `stratlas-update.json` file itself, or the folder that holds
   * it (ending in `/`). Empty when not set.
   */
  updateUrl: OptionalUrl.optional(),
  /**
   * Anthropic workspace ID, sent as the `anthropic-workspace-id` header. Needed only with a key
   * that is not scoped to a workspace (an organisation key). Empty when not set.
   */
  anthropicWorkspaceId: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9_-]*$/, 'A workspace ID has only letters, digits, _ and -.')
    .optional(),
  /** Company name, logo and accent for generated reports. Absent: neutral reports. */
  reportBranding: ReportBrandingSettings.optional(),
  /** Sections of the house-format report and which issues get a page. Absent: everything. */
  reportContents: ReportContentsSettings.optional(),
  /** Change thresholds (M8); absent: `DEFAULT_CHANGE_THRESHOLDS`. */
  change: ChangeThresholds.optional(),
  /** Local ONNX detection (M8): model folder, execution provider, memory cap. */
  inference: InferenceSettings.optional(),
  /** Sync preferences (M9). Never keys, tokens or invite codes: those live in the vault. */
  team: TeamSettings.optional(),
  /** Settings, Processing tools: the photogrammetry engine (ODM). Absent: GPU auto. */
  processing: ProcessingSettings.optional(),
});

/** West, south, east, north in WGS84 degrees. */
export const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine(([w, s, e, n]) => w < e && s < n, 'The box must have west < east and south < north');

const PackId = z.string().regex(/^[a-z0-9-]+$/);

export const MapPackInfo = z.object({
  id: PackId,
  label: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  maxZoom: z.number().int(),
  sizeBytes: z.number().int().nonnegative(),
  /** When the pack file was written (ISO 8601). Older packs fall back to the file date. */
  builtAt: z.string().optional(),
  /**
   * How the pack arrived: the in-app download, a file import, tools/maps/build-packs.mjs, or
   * `package`: carried inside an open `.aio` package (listed only while this machine lacks it).
   */
  source: z.enum(['download', 'import', 'build-tool', 'package']).optional(),
  /** Protomaps planet build the pack was cut from, e.g. `20261003`. */
  build: z.string().optional(),
});

/** A region to download from the Protomaps daily build. */
export const PackRegion = z.object({
  id: PackId.min(1).max(48),
  label: z.string().min(1).max(80),
  bbox: Bbox,
  maxZoom: z.number().int().min(0).max(15),
});

export const PackJob = PackRegion.extend({
  state: z.enum(['running', 'verifying', 'done', 'failed', 'cancelled', 'interrupted']),
  /** 0 to 1, as reported by the extract tool. */
  progress: z.number().min(0).max(1),
  /** Bytes written so far. */
  bytes: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  build: z.string().optional(),
});

const Ok = z.object({ ok: z.boolean(), error: z.string().optional() });

const OpenResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Stable id for aio://project/<id>/ URLs. */
    id: z.string(),
    root: z.string(),
    manifest: ProjectManifest,
    issues: z.array(Issue),
    /** Present when the project was opened from a `.aio` package (never written to). */
    package: PackageInfo.optional(),
    /** A folder project extracted from a package: its `package-origin.json`. */
    origin: PackageOrigin.optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    /** The package is encrypted: ask for the passphrase and open again. */
    needsPassphrase: z.boolean().optional(),
  }),
]);

/** An installed imagery or terrain pack a package may carry, clipped to the site. */
export const RasterPackRef = z
  .object({ kind: z.enum(['imagery', 'terrain']), id: RasterPackId })
  .strict();

/** What carrying one raster pack would cost, or why it cannot be carried. */
export const PackageRasterPlan = z.intersection(
  z.object({
    kind: z.enum(['imagery', 'terrain']),
    id: RasterPackId,
    label: z.string(),
    licence: z.string(),
    attribution: z.string(),
    customerLicence: z.boolean(),
  }),
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      bytes: z.number().int().nonnegative(),
      tiles: z.number().int().nonnegative(),
      maxZoom: z.number().int(),
    }),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ]),
);

/** Size of what a package would hold, per layer and in total. */
export const PackagePlan = z.object({
  layers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      /** Bytes only this layer brings (files shared with kept layers are not counted). */
      bytes: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
    }),
  ),
  /** Manifest, issues, thumbnail, report and other files every package carries. */
  baseBytes: z.number().int().nonnegative(),
  /** Bytes and files of the package for the requested exclusions. */
  totalBytes: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  /** Free space on the volume of the data folder, when known. */
  freeBytes: z.number().int().nonnegative().optional(),
  /**
   * The map pack region the package would carry (when `mapPack` was asked for): clipped from an
   * installed pack, or why none can be (no pack covers the site, no georeference). Its bytes are
   * included in `totalBytes` when `ok`.
   */
  mapPack: z
    .discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        /** Installed pack the region is clipped from. */
        sourceId: z.string(),
        sourceLabel: z.string(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        maxZoom: z.number().int(),
        bytes: z.number().int().nonnegative(),
        tiles: z.number().int().nonnegative(),
      }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ])
    .optional(),
  /** Imagery and terrain packs the package would carry (when `rasterPacks` was asked for). */
  rasterPacks: z.array(PackageRasterPlan).optional(),
});

/** Embed the map region a project needs: its area plus a margin, up to a zoom. */
export const PackageMapPackRequest = z
  .object({
    maxZoom: z.number().int().min(0).max(15),
    marginKm: z.number().min(0).max(100),
  })
  .strict();

export const PackageExportOptions = z
  .object({
    projectId: z.string().min(1),
    /** Layer ids to leave out. */
    exclude: z.array(z.string()),
    readOnly: z.boolean(),
    aiPolicy: AiPolicy,
    /** Whether the holder may extract an editable copy (absent: follows `readOnly`). */
    editPolicy: EditPolicy.optional(),
    /** Embed the map region the project needs, clipped from an installed pack. */
    mapPack: PackageMapPackRequest.optional(),
    /** Imagery and terrain packs to embed, clipped to the site. */
    rasterPacks: z.array(RasterPackRef).max(32).optional(),
    exports: z.array(ExportKind),
    /** AES-256 (WinZip AE-2) for every member when set. */
    passphrase: z.string().min(8).max(256).optional(),
    welcome: z
      .object({
        message: z.string().max(2000).optional(),
        tips: z.array(z.string().min(1).max(200)).max(8).optional(),
      })
      .optional(),
  })
  .strict();

/**
 * Issue exports (PRD REV-6, ANN-11). `report-pdf` is the branded issue register report and
 * `house-pdf` the full house-format report (BLD-8), both printed from an offscreen window; the
 * others are written by the data utility process.
 */
export const EXPORT_FORMATS = [
  'csv',
  'geojson',
  'coco',
  'kit-json',
  'masks-zip',
  'report-pdf',
  'house-pdf',
  // M9 (T1): the audit trail, under the existing package kind `files` (no new ExportKind)
  'audit-csv',
  'audit-json',
  // M10 (G4): a photogrammetry run's accuracy report, under the existing kind `report-pdf`
  'photo-report-pdf',
  // M11 (G9): the survey measurement and stockpile inventory CSVs (kind `files`, checked by format)
  // and the survey sections of the house report alone (kind `report-pdf`)
  'measurements-csv',
  'stockpile-csv',
  'survey-report-pdf',
] as const;
export const ExportFormat = z.enum(EXPORT_FORMATS);

/**
 * The package export kind (`aio-package.json` `exports`) each format falls under; the same kind
 * `exportKindForFile` gives its file name (COCO is JSON, like the kit export).
 */
export const EXPORT_FORMAT_KIND = {
  csv: 'issues-csv',
  geojson: 'issues-geojson',
  coco: 'kit-json',
  'kit-json': 'kit-json',
  'masks-zip': 'masks',
  'report-pdf': 'report-pdf',
  'house-pdf': 'report-pdf',
  'audit-csv': 'files',
  'audit-json': 'files',
  'photo-report-pdf': 'report-pdf',
  'measurements-csv': 'files',
  'stockpile-csv': 'files',
  'survey-report-pdf': 'report-pdf',
} as const satisfies Record<z.infer<typeof ExportFormat>, ExportKind>;

export const ReportFile = z.object({
  /** Path relative to the project folder, for aio://project/<id>/<path>. */
  path: z.string().min(1),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export const LicenseEntry = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  homepage: z.string().optional(),
  author: z.string().optional(),
});

/**
 * One AI pick of Auto-plan (`ai:rfPlan`): equipment and one carrier for a detected unit. It has no
 * geometry field, and the renderer still validates it against the catalogue before a review.
 */
export const RfPlanAiPick = z
  .object({
    unitId: z.string().min(1),
    entryId: z.string().min(1),
    radioId: z.string().min(1).optional(),
    band: z.string().min(1),
    tech: z.enum(['lte', 'nr']),
    bandwidthMhz: z.number().positive(),
    reason: z.string().max(200),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict();
export type RfPlanAiPick = z.infer<typeof RfPlanAiPick>;

/** What Auto-plan tells the model about one unit: its measured size and what the person typed. */
export const RfPlanUnitInput = z
  .object({
    unitId: z.string().min(1).max(100),
    widthM: z.number().nonnegative().optional(),
    heightM: z.number().nonnegative().optional(),
    depthM: z.number().nonnegative().optional(),
    downtiltDeg: z.number().optional(),
    heightAboveGroundM: z.number().optional(),
    userModel: z.string().max(200).optional(),
    userFrequencies: z.string().max(200).optional(),
  })
  .strict();
export type RfPlanUnitInput = z.infer<typeof RfPlanUnitInput>;

/** One catalogue entry the model may choose from. */
export const RfPlanCatalogueInput = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(['antenna', 'radio', 'aau']),
    vendor: z.string().max(100),
    model: z.string().max(100),
    bands: z.array(z.string().min(1).max(20)).max(50),
  })
  .strict();
export type RfPlanCatalogueInput = z.infer<typeof RfPlanCatalogueInput>;

const VerifyResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Version of the installer. */
    version: z.string(),
    /** Version of the running app. */
    current: z.string(),
    /** Subject of the signing certificate. */
    signer: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** The single list of request/response channels between renderer and main. Main validates every request. */
export const ipc = {
  'app:getInfo': {
    request: Empty,
    response: z.object({
      name: z.string(),
      version: z.string(),
      platform: z.string(),
      /** OS account name, the default author of new issues. */
      user: z.string().optional(),
    }),
  },
  'library:list': { request: Empty, response: z.array(LibraryEntry) },
  /** Data folder, map packs and pipeline pack as found now (first-start welcome). */
  'app:setupStatus': { request: Empty, response: SetupStatus },
  'library:add': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), entry: LibraryEntry }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Classes saved to the class library on this computer (`userData/class-library.json`). */
  'classLibrary:list': { request: Empty, response: z.array(LibraryClass) },
  /** Save a class to the library; one with the same label (any case) is replaced. */
  'classLibrary:save': {
    request: z.object({ cls: LibraryClass }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), classes: z.array(LibraryClass) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Remove a class from the library by label (any case). */
  'classLibrary:remove': {
    request: z.object({ label: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), classes: z.array(LibraryClass) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * The menu of one project on the Projects screen (three dots or right-click). `projectId` is the
   * library entry's `id`: main finds the folder itself, so the renderer never names a path.
   *
   * `library:reveal` shows the project folder (or the `.aio` file) in the file manager.
   */
  'library:reveal': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: OkOrFailure,
  },
  /**
   * Change the name a project shows (`name` in its `manifest.json`, the previous file kept as
   * `manifest.json.bak`). The folder on disk and the project id keep their names. Only for a
   * project folder directly inside `<data folder>/projects`; packages and demo projects refuse.
   */
  'library:rename': {
    request: z.object({ projectId: ProjectId, name: z.string().trim().min(1).max(120) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), name: z.string() }),
      Failure,
    ]),
  },
  /**
   * Move a library entry to the recycle bin (never a permanent delete): a project or package in
   * the data folder, a folder or package added to the library, or a demo's working copy. Refuses
   * while a job runs in it.
   */
  'library:delete': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: OkOrFailure,
  },
  'library:remove': { request: z.object({ projectId: ProjectId }).strict(), response: OkOrFailure },
  'library:setThumbnail': {
    request: z.object({ projectId: ProjectId, data: CoverJpeg.nullable() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), thumbnail: z.string().nullable() }),
      Failure,
    ]),
  },
  'library:folders': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), folders: z.array(LibraryFolder) }),
      Failure,
    ]),
  },
  'library:createFolder': {
    request: z.object({ name: z.string().trim().min(1).max(60) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), folder: LibraryFolder }),
      Failure,
    ]),
  },
  'library:renameFolder': {
    request: z
      .object({ folderId: LibraryFolderId, name: z.string().trim().min(1).max(60) })
      .strict(),
    response: OkOrFailure,
  },
  'library:deleteFolder': {
    request: z.object({ folderId: LibraryFolderId }).strict(),
    response: OkOrFailure,
  },
  'library:move': {
    request: z.object({ projectId: ProjectId, folderId: LibraryFolderId.nullable() }).strict(),
    response: OkOrFailure,
  },
  'project:open': {
    request: z
      .object({ path: z.string().min(1), passphrase: z.string().min(1).max(256).optional() })
      .strict(),
    response: OpenResult,
  },
  'project:writeIssues': {
    request: z
      .object({
        projectId: z.string().min(1),
        issues: z.array(Issue),
        /** M9: the editor's labelled commands since the last write, for readable history. */
        commands: z.array(EditCommand).max(1000).optional(),
      })
      .strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * Write the points of a placed finding (`selections/<name>.sel`, data-conventions section 35),
   * replacing a file of that name. Refused on a package and for bytes that are not a selection
   * file. Not journalled (a binary asset, like a thumbnail). Answers the project path.
   */
  'project:writeSelection': {
    request: z
      .object({
        projectId: z.string().min(1),
        name: SelectionName,
        data: z
          .instanceof(Uint8Array)
          .refine((d) => d.byteLength <= selectionByteLength(SELECTION_MAX_POINTS), {
            message: 'A selection is at most 2 million points',
          }),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * The stockpile volumes of an open project (`volumes.json`) and the toe lines corrected by hand
   * (`edits/boundaries.json`); null when the project has none.
   */
  'project:readVolumes': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        volumes: VolumesFile.nullable(),
        edits: BoundaryEditsFile.nullable(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** The report template (`report/template.json`); null when the project has none. */
  'report:readTemplate': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: ReportTemplateFile.nullable() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Replace `report/template.json` atomically, keeping a `.bak`. */
  'report:writeTemplate': {
    request: z.object({ projectId: z.string().min(1), file: ReportTemplateFile }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Replace `<project>/edits/boundaries.json` (stockpile toe lines corrected by hand) atomically,
   * keeping a `.bak` of the previous file.
   */
  'project:writeBoundaries': {
    request: z.object({ projectId: z.string().min(1), file: BoundaryEditsFile }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * Save a road centreline drawn on the map as `<project>/road/centreline-drawn.geojson` (a
   * LineString in lon/lat, atomic replace with `.bak`), for the road builder (`road.build`).
   * Answers the project-relative path.
   */
  'project:writeCentreline': {
    request: z
      .object({
        projectId: z.string().min(1),
        coordinates: z
          .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
          .min(2)
          .max(20000),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'packs:list': { request: Empty, response: z.array(MapPackInfo) },
  /** Start downloading a region (explicit online action; refused when offline-only). */
  'packs:download': { request: PackRegion.strict(), response: Ok },
  'packs:jobs': { request: Empty, response: z.array(PackJob) },
  'packs:cancel': { request: z.object({ id: PackId }).strict(), response: Ok },
  /** Restart an interrupted, failed or cancelled download with the same planet build. */
  'packs:resume': { request: z.object({ id: PackId }).strict(), response: Ok },
  /** Forget a finished, failed or cancelled job (and its partial file). */
  'packs:dismiss': { request: z.object({ id: PackId }).strict(), response: Ok },
  'packs:remove': { request: z.object({ id: PackId }).strict(), response: Ok },
  /** Copy a `.pmtiles` file (and its optional `.json` beside it) into the packs folder. */
  'packs:import': {
    request: z
      .object({ path: z.string().min(1), label: z.string().min(1).max(80).optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), pack: MapPackInfo }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'settings:get': { request: Empty, response: Settings },
  'settings:set': { request: Settings.partial().strict(), response: Settings },
  'ai:setKey': {
    request: z.object({ provider: AiProvider, key: z.string().min(8) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
  'ai:hasKey': {
    request: z.object({ provider: AiProvider }).strict(),
    response: z.object({ present: z.boolean() }),
  },
  /**
   * Settings, Test connection: one minimal request to the provider with the model its routes use,
   * reporting the provider's exact answer or error. Calls out only when cloud AI is on.
   */
  'ai:testConnection': {
    request: z.object({ provider: AiProvider }).strict(),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      model: z.string().optional(),
      /** HTTP status of a provider error. */
      status: z.number().int().optional(),
      /** A provider error the app can offer a fix for (focus the field that fixes it). */
      code: AiErrorCode.optional(),
    }),
  },
  'ai:send': {
    request: z
      .object({
        runId: z.string().min(1),
        /** Open project: usage is metered to it and its AI policy applies. */
        projectId: z.string().min(1).optional(),
        window: WindowKind,
        /** Snapshot of the window context: selection, time, visible layers, frame info. */
        context: z.record(z.string(), z.unknown()),
        messages: z.array(ChatMessage).min(1),
        /** Optional image (data URL) such as the current video frame. */
        image: z.string().startsWith('data:image/').optional(),
        /**
         * M8: the route to answer on (the Model builder sends `build`); default `vision` with an
         * image, else `chat`.
         */
        task: AiTask.optional(),
      })
      .strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  'ai:toolResult': {
    request: z
      .object({
        runId: z.string().min(1),
        callId: z.string().min(1),
        approved: z.boolean(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      })
      .strict(),
    response: z.object({ ok: z.boolean() }),
  },
  'ai:cancel': {
    request: z.object({ runId: z.string().min(1) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
  /** Can the agent answer right now (cloud switch, key, project policy, local model)? */
  'ai:status': {
    request: z
      .object({
        projectId: z.string().min(1).optional(),
        /** The route to check; `chat` when absent (`vision` for AI detection). */
        task: AiTask.optional(),
      })
      .strict(),
    response: z.object({
      ready: z.boolean(),
      reason: z
        .enum([
          'cloud-off',
          'no-key',
          'forbidden',
          'no-provider',
          'no-route',
          'local-off',
          /** M8: the local model cannot call tools; the agent answers in text only. */
          'answer-only',
          /** The workstation is offline-only (`Settings.offlineOnly`): no cloud call is made. */
          'offline-only',
        ])
        .optional(),
      message: z.string().optional(),
      route: ModelRouteSchema.optional(),
      /** The chat route sends data off this machine. */
      cloud: z.boolean(),
    }),
  },
  /**
   * AI-assisted detection (BLD-6): one request with up to 8 images to the vision route, after the
   * person saw the preview and the estimate. Same gates as the agent (cloud switch, project
   * policy, key); usage is metered to the project. Results are proposals for the review.
   */
  'ai:detect': {
    request: z
      .object({
        runId: z.string().min(1),
        projectId: z.string().min(1),
        classes: z
          .array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict())
          .min(1)
          .max(300),
        severity: z
          .object({
            levels: z
              .array(
                z
                  .object({
                    value: z.number().int(),
                    label: z.string(),
                    criteria: z.string().optional(),
                  })
                  .strict(),
              )
              .max(20),
            uncertain: z.boolean().optional(),
          })
          .strict()
          .optional(),
        hint: z.string().max(2000).optional(),
        images: z.array(DetectImage).min(1).max(8),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        provider: z.string(),
        model: z.string(),
        promptVersion: z.string(),
        results: z.array(z.object({ key: z.string(), detections: z.array(AiDetectionResult) })),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        costUsd: z.number().nonnegative().optional(),
        warnings: z.array(z.string()),
      }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        /** HTTP status of a provider error. */
        status: z.number().int().optional(),
        stopped: z.boolean().optional(),
      }),
    ]),
  },
  /**
   * Every detection pass of the project (`<project>/detections/*.json`, `aio.detections/1`,
   * data-conventions section 11) for the review, with the pixel size of the photos whose boxes
   * are in preview space and the inspection pipeline's issues (`inspection/issues-map.json`:
   * issue id to the detection ids it was made from).
   */
  'detections:read': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        files: z.array(z.object({ name: DetectionPassName, file: DetectionsFile })),
        /** Files in detections/ the review cannot read (kit lists, COCO, invalid), left as they are. */
        problems: z.array(z.object({ name: z.string(), error: z.string() })),
        /** `<layer>/<photo>` to `[width, height]` of the photo file. */
        sizes: z.record(z.string(), z.tuple([z.number(), z.number()])),
        issuesMap: z.record(z.string(), z.array(z.string())),
        /** A package: the review can be read but not saved. */
        readOnly: z.boolean(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Replace one pass file `<project>/detections/<name>` atomically with a `.bak` (not in packages). */
  'detections:write': {
    request: z
      .object({ projectId: z.string().min(1), name: DetectionPassName, file: DetectionsFile })
      .strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Mask assist (BLD-10): available only with a SAM-class model in the pipeline pack. */
  'detections:maskAssistStatus': {
    request: Empty,
    response: z.object({
      available: z.boolean(),
      model: z.string().optional(),
      reason: z.enum(['no-model', 'no-runtime', 'failed']).optional(),
      detail: z.string().optional(),
    }),
  },
  /** Outline the object inside a box on a project photo (pixels of the photo). */
  'detections:maskAssist': {
    request: z
      .object({
        projectId: z.string().min(1),
        path: z.string().min(1),
        box: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), points: z.array(z.tuple([z.number(), z.number()])).min(3) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Per-project agent state kept on this workstation: send consent, policy, usage. */
  'ai:project': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({
      alwaysAllow: z.boolean(),
      policy: AiPolicy,
      usage: z.array(ProviderUsage),
      /** M8: the project allows plan images and drawings to go to a cloud model (default false). */
      cloudDrawings: z.boolean().optional(),
    }),
  },
  /** "Always allow for this project" in the send preview (AI-6). */
  'ai:setConsent': {
    request: z.object({ projectId: z.string().min(1), alwaysAllow: z.boolean() }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Tokens and estimated cost per project and provider (AI-7), for Settings. */
  'ai:usage': {
    request: Empty,
    response: z.object({ projects: z.array(ProjectUsage) }),
  },
  /** Saved conversations of a project, newest first (AI-8). */
  'ai:listConversations': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({
      ok: z.boolean(),
      conversations: z.array(ConversationSummary),
      error: z.string().optional(),
    }),
  },
  'ai:loadConversation': {
    request: z.object({ projectId: z.string().min(1), id: ConversationId }).strict(),
    response: z.object({
      ok: z.boolean(),
      conversation: Conversation.optional(),
      error: z.string().optional(),
    }),
  },
  'ai:saveConversation': {
    request: z.object({ projectId: z.string().min(1), conversation: Conversation }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  'dialog:openFolder': {
    request: z.object({ title: z.string().optional() }).strict(),
    response: z.object({ path: z.string().nullable() }),
  },
  /**
   * Ask where to save a file with the native dialog, then write it. Used by the exports, the
   * assistant and the accuracy report. `path` is null when the person cancels; `error` says why
   * a chosen file could not be written.
   */
  'dialog:saveFile': {
    request: z
      .object({
        /** File name only; main drops any folder part. */
        defaultName: z.string().min(1).max(255),
        data: z.union([z.string(), z.instanceof(Uint8Array)]),
        title: z.string().optional(),
      })
      .strict(),
    response: z.object({ path: z.string().nullable(), error: z.string().optional() }),
  },
  /**
   * Ask where to save with the native dialog and answer the chosen path only; nothing is written.
   * For files a pipeline job writes itself (`survey.export`, `survey.section`: their `out`), so
   * nothing is staged in the project first. `path` is null when the person cancels; `error` says
   * why the destination is refused (an open package's export limits).
   */
  'dialog:savePath': {
    request: z
      .object({
        /** File name only; main drops any folder part. */
        defaultName: z.string().min(1).max(255),
        title: z.string().max(200).optional(),
        filters: z
          .array(z.object({ name: z.string(), extensions: z.array(z.string().min(1)) }))
          .optional(),
      })
      .strict(),
    response: z.object({ path: z.string().nullable(), error: z.string().optional() }),
  },
  /** Pick one existing file (a `.aio` package, an installer) with the native dialog. */
  'dialog:openFile': {
    request: z
      .object({
        title: z.string().optional(),
        filters: z
          .array(z.object({ name: z.string(), extensions: z.array(z.string().min(1)) }))
          .optional(),
      })
      .strict(),
    response: z.object({ path: z.string().nullable() }),
  },
  /** The path the app was started with (double-clicked `.aio`), once; null afterwards. */
  'app:takeOpenPath': { request: Empty, response: z.object({ path: z.string().nullable() }) },
  /** Size report for a package of an open project, for the given layer exclusions. */
  'package:plan': {
    request: z
      .object({
        projectId: z.string().min(1),
        exclude: z.array(z.string()),
        mapPack: PackageMapPackRequest.optional(),
        rasterPacks: z.array(RasterPackRef).max(32).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), plan: PackagePlan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Ask where to save, then stream the package there. Progress arrives as `package:progress`
   * events with the same `jobId`. `path` is null when the person cancels the dialog or the job.
   */
  'package:export': {
    request: z.object({ jobId: z.string().min(1), options: PackageExportOptions }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string().nullable(), bytes: z.number().optional() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'package:cancel': {
    request: z.object({ jobId: z.string().min(1) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
  /**
   * Extract to edit: copy an open package (already unlocked) into a new editable project folder
   * in the data root, with `package-origin.json`. Refused when the package forbids editing; the
   * `.aio` file is only read. Progress arrives as `package:progress` with the same `jobId`
   * (cancel with `package:cancel`). `root` is null when cancelled.
   */
  'package:extract': {
    request: z.object({ jobId: z.string().min(1), projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), root: z.string().nullable() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Export the issues of an open project: main asks where to save with the native dialog, then
   * writes the file off the UI thread and pushes `export:progress` events for `jobId`. `path`
   * is null when the person cancels the dialog or the job.
   */
  'export:run': {
    request: z
      .object({
        jobId: z.string().min(1).max(64),
        projectId: z.string().min(1),
        format: ExportFormat,
        /** Only these issues (the register's current filter); all issues when absent. */
        issueIds: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        path: z.string().nullable(),
        /** Issues (or files, for masks) written. */
        count: z.number().int().nonnegative().optional(),
        bytes: z.number().int().nonnegative().optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Pick one or more files with the native dialog; `paths` is empty when the person cancels. */
  'dialog:openFiles': {
    request: z
      .object({
        title: z.string().optional(),
        filters: z
          .array(z.object({ name: z.string(), extensions: z.array(z.string().min(1)) }))
          .optional(),
        multi: z.boolean().optional(),
      })
      .strict(),
    response: z.object({ paths: z.array(z.string()) }),
  },
  /** Severity templates (from the projects in the library) and report brands for the wizard. */
  'builder:templates': {
    request: Empty,
    response: z.object({ severity: z.array(SeverityTemplate), brands: z.array(ReportBrand) }),
  },
  /** Create `<dataRoot>/projects/<id>/` with a valid manifest and an empty issue register. */
  'builder:createProject': {
    request: NewProjectRequest,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string(), manifest: ProjectManifest }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** GPS position and capture time of a photo (wizard: origin from the first GPS photo). */
  /**
   * Turn one project photo 90 degrees clockwise. Rewrites the file and its thumbnail, turns
   * image sightings with the pixels, and updates the lens so it still matches. Refused on a package.
   */
  'builder:rotatePhoto': {
    request: z
      .object({
        projectId: z.string().min(1),
        layerId: z.string().min(1),
        photoId: z.string().min(1),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        issues: z.array(Issue),
        manifest: ProjectManifest,
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Move one ready-made image between a photos layer and a panoramas layer of its date (created
   * when missing), keeping its file. Refused on a package and on a photo with image sightings.
   */
  'builder:convertMedia': {
    request: z
      .object({
        projectId: z.string().min(1),
        layerId: z.string().min(1),
        itemId: z.string().min(1),
        to: z.enum(['pano', 'photo']),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        layerId: z.string(),
        itemId: z.string(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'builder:photoGps': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        lon: z.number(),
        lat: z.number(),
        /**
         * Ground height for the origin: the take-off point's absolute altitude (photo absolute
         * altitude minus its height above take-off) when the photo has both, else its GPS altitude.
         */
        alt: z.number().optional(),
        /** `takeoff`: `alt` is the take-off point; `photo`: the camera's own altitude. */
        altFrom: z.enum(['takeoff', 'photo']).optional(),
        takenAt: z.string().optional(),
        /** Not a drone photo: its GPS may come from a linked phone and be kilometres out. */
        handheld: z.boolean().optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'export:cancel': {
    request: z.object({ jobId: z.string().min(1).max(64) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
  /** PDF reports delivered with the project (`report/*.pdf`). */
  /**
   * Copy a logo (PNG, JPG or SVG, at most 5 MB) into userData `branding/` and make it the report
   * logo (`Settings.reportBranding.logo`). The previous logo file is removed.
   */
  'branding:setLogo': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), settings: Settings }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Forget the report logo and delete its copy. */
  'branding:clearLogo': { request: Empty, response: Settings },
  /**
   * Store a thumbnail the renderer made of a project image (JPEG, at most 512 KB) in the
   * userData thumbnail cache, so `aio://thumb/<id>/<path>` serves it next time.
   */
  'thumbs:put': {
    request: z
      .object({
        projectId: z.string().min(1),
        path: z.string().min(1).max(1024),
        data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= 512 * 1024, {
          message: 'Thumbnail is larger than 512 KB',
        }),
      })
      .strict(),
    response: z.object({ ok: z.boolean() }),
  },
  'report:list': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({ files: z.array(ReportFile) }),
  },
  /**
   * The narrative of an open project (`report/narrative.json`, BLD-7): null when none was saved.
   * `readOnly` for a package, whose narrative can be read but not changed.
   */
  'report:readNarrative': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: NarrativeFile.nullable(), readOnly: z.boolean() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Replace `report/narrative.json` atomically, keeping a `.bak` of the previous file. */
  'report:writeNarrative': {
    request: z.object({ projectId: z.string().min(1), file: NarrativeFile }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * One text completion on a task route (the report narrative, BLD-7), without tools. The
   * renderer shows the exact `system` and `prompt` first (AI-6). Cancel with `ai:cancel`.
   */
  'ai:draftText': {
    request: z
      .object({
        runId: z.string().min(1).max(64),
        projectId: z.string().min(1),
        task: AiTask,
        system: z.string().min(1).max(20_000),
        prompt: z.string().min(1).max(200_000),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        text: z.string(),
        provider: z.string(),
        model: z.string(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'app:about': {
    request: Empty,
    response: z.object({
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
      dataRoot: z.string(),
      userData: z.string(),
      logsDir: z.string(),
      packaged: z.boolean(),
      /** Installed from the Microsoft Store (MSIX): the Store delivers updates. */
      store: z.boolean().optional(),
    }),
  },
  /** Third-party packages shipped in the app, generated from the dependency tree at build time. */
  'app:licenses': { request: Empty, response: z.array(LicenseEntry) },
  /** Write the app logs and system details into one text file the person chooses. */
  'app:exportLogs': {
    request: Empty,
    response: z.object({ path: z.string().nullable(), error: z.string().optional() }),
  },
  'app:showFolder': {
    request: z.object({ which: z.enum(['data', 'logs', 'userData']) }).strict(),
    response: Ok,
  },
  /**
   * Save a diagnostics bundle (zip: logs, versions, GPU, allow-listed settings, packs, recent jobs,
   * crash reports) where the person chooses. With `problem`, it also holds `problem.md` (Report a
   * problem). Nothing is uploaded. `path` is null when the save dialog was cancelled.
   */
  'app:exportDiagnostics': {
    request: z
      .object({
        problem: z
          .object({ what: z.string().max(8000), steps: z.string().max(8000).optional() })
          .strict()
          .optional(),
        /** Graphics tier and WebGL renderer string, known to the renderer only. */
        graphics: z
          .object({
            tier: z.string().max(20),
            detected: z.string().max(20),
            override: z.string().max(20).nullable(),
            renderer: z.string().max(500).nullable(),
            /** The renderer's graphicsReport(): tier facts, limits and memory now (numbers, no paths). */
            report: z
              .record(
                z.string().max(40),
                z.union([
                  z.string().max(500),
                  z.number(),
                  z.boolean(),
                  z.null(),
                  z.array(z.string().max(40)).max(20),
                ]),
              )
              .optional(),
          })
          .strict()
          .optional(),
        /** Id of the project on screen, marked in the bundle's project list. */
        openProject: z.string().max(200).optional(),
      })
      .strict(),
    response: z.object({ path: z.string().nullable(), error: z.string().optional() }),
  },
  /** The "closed unexpectedly" notice left by a crash, if the person has not dismissed it. */
  'app:crashNotice': { request: Empty, response: z.object({ notice: CrashNotice.nullable() }) },
  'app:dismissCrashNotice': { request: Empty, response: Ok },
  /** Check an installer file: valid signature and a newer version than this app. */
  'update:verifyFile': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: VerifyResult,
  },
  /** Verify again, run the installer and quit. */
  'update:installFile': { request: z.object({ path: z.string().min(1) }).strict(), response: Ok },
  /** Optional online check of the update feed (ADR 0003); refused when offline-only. */
  'update:check': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        available: z.boolean(),
        version: z.string().optional(),
        /** Release notes of the offered version (Markdown), when the feed carries them. */
        notes: z.string().optional(),
        /** Download size in bytes of this platform's installer. */
        size: z.number().optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Download the update found by `update:check` (resumable, SHA-256 checked), verify it, keep a
   * copy of this version for rollback, then quit and install it. Progress: `update:progress`.
   */
  'update:downloadAndInstall': { request: Empty, response: Ok },
  /** Release notes of the running version, bundled at build time. */
  'update:notes': { request: Empty, response: ReleaseNotes },
  /** Kept previous version and a pending first start (Settings, About and updates). */
  'update:status': { request: Empty, response: UpdateStatus },
  /** Return to the kept previous version: it replaces this one and starts. */
  'update:rollback': { request: Empty, response: Ok },
  'websiteUpdate:status': { request: Empty, response: WebsiteUpdateStatus },
  'websiteUpdate:signIn': {
    request: z
      .object({ email: z.email().max(320), password: z.string().min(1).max(4096) })
      .strict(),
    response: WebsiteUpdateResult,
  },
  'websiteUpdate:signOut': { request: Empty, response: WebsiteUpdateResult },
  'websiteUpdate:check': { request: Empty, response: WebsiteUpdateResult },
  'websiteUpdate:restart': { request: Empty, response: WebsiteUpdateResult },
  'websiteUpdate:rollbackKit': { request: Empty, response: WebsiteUpdateResult },
  /** The renderer has drawn its first screen; ends the first-start watch after an update. */
  'app:rendererReady': { request: Empty, response: Ok },
  /** Start a pipeline job on a project folder, or resume a cancelled, failed or interrupted one. */
  'jobs:start': {
    request: JobStartRequest,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), job: JobRecord }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Every known job (newest first) and the pipeline pack the app found. */
  'jobs:list': {
    request: Empty,
    response: z.object({ runtime: RuntimeInfo, jobs: z.array(JobRecord) }),
  },
  /** Ask the job to stop; main kills the runtime if it has not stopped after a grace period. */
  'jobs:cancel': {
    request: z.object({ jobId: JobId }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * Forget finished jobs: they leave the job index (`jobs.json`) for good. Their outputs and job
   * folders stay on disk. A job still at work is never removed; `removed` names those that went.
   */
  'jobs:remove': {
    request: z.object({ jobIds: z.array(JobId).min(1).max(500) }).strict(),
    response: z.object({ removed: z.array(JobId) }),
  },
  /** The last lines of a job's log (live lines also arrive as `jobs:event`). */
  'jobs:log': {
    request: z
      .object({ jobId: JobId, tail: z.number().int().min(1).max(5000).optional() })
      .strict(),
    response: z.object({ lines: z.array(JobLogLine) }),
  },
  /** Show a job's output (its first artifact), its log file or the project folder in the OS file browser. */
  'jobs:open': {
    request: z.object({ jobId: JobId, what: z.enum(['output', 'log', 'project']) }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * Import raw files into an open project (photos, video with DJI SRT, GLB/OBJ, GeoTIFF; point
   * clouds and large rasters go to the pipeline pack). Progress arrives as `builder:progress`.
   */
  'builder:import': {
    request: z
      .object({
        projectId: z.string().min(1),
        /** Files or folders; a folder is read recursively. */
        paths: z.array(z.string().min(1)).min(1),
        /** The aircraft clock's offset from UTC in minutes; default from the project longitude. */
        utcOffsetMin: z.number().int().min(-720).max(840).optional(),
        /** How camera heights are made (data-conventions section 3a); default `auto`. */
        altitude: AltitudeChoice.optional(),
        /**
         * Add drawing: every picture in `paths` becomes a drawing (a JPEG is not a photo, a
         * georeferenced TIFF is not an ortho). Without it only PDF, PNG, WebP, SVG and TIFF without
         * a georeference do.
         */
        drawings: z.boolean().optional(),
        /**
         * Survey day chosen in Add data for each cloud (absolute path to YYYY-MM-DD, null = Not
         * dated), passed to `pointcloud.to_copc` as `surveyDate` (15 Oct 2026).
         */
        cloudDates: z.record(z.string().min(1).max(2048), IsoDate.nullable()).optional(),
        /**
         * "Add 360 video": an MP4 or MOV is taken as a stitched equirectangular video and stored
         * as a walk (`walks/<id>/`), not as a drone clip that needs its SRT.
         */
        as360: z.boolean().optional(),
        /**
         * Files to leave out, absolute (Add data leaves out the frames of drone panoramas that the
         * person imports as panoramas instead).
         */
        exclude: z.array(z.string().min(1).max(2048)).max(20_000).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        items: z.array(ImportItem),
        /** The height rule applied, when any file got a camera height. */
        heights: ImportHeights.optional(),
        /**
         * The survey dates the import itself created (0 or 1 id), so the import card can tidy
         * them up: not a date another save added meanwhile, nor one the day already had.
         */
        createdCaptures: z.array(z.string().min(1)).optional(),
        /**
         * The files the import read, absolute: `paths` with every folder expanded (rows name a
         * file only), so the app can process a 360 walk from its original.
         */
        files: z.array(z.string().min(1)).optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string(), items: z.array(ImportItem).optional() }),
    ]),
  },
  /**
   * What the files of an import carry for camera heights (absolute and relative altitude, the
   * lowest logged position), so the import UI can propose the height rule before `builder:import`.
   */
  'builder:altitudePlan': {
    request: z
      .object({
        projectId: z.string().min(1),
        /** Files or folders; a folder is read recursively. */
        paths: z.array(z.string().min(1)).min(1),
        /**
         * Files to leave out, absolute, as `builder:import` takes them (the frames of drone
         * panoramas that go to the panorama import, so they do not ask for camera heights).
         */
        exclude: z.array(z.string().min(1).max(2048)).max(20_000).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), plan: AltitudePlan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * The `.zpc` clouds under `paths` with the day their LAS headers carry (the export day, not the
   * flight day), so Add data can ask for the survey day before `builder:import` (15 Oct 2026).
   */
  'builder:cloudDates': {
    request: z
      .object({
        projectId: z.string().min(1),
        /** Files or folders; a folder is read recursively. */
        paths: z.array(z.string().min(1)).min(1),
        /** Files to leave out, absolute, as `builder:import` takes them. */
        exclude: z.array(z.string().min(1).max(2048)).max(20_000).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        clouds: z.array(
          z.object({ path: z.string(), name: z.string(), headerDay: IsoDate.nullable() }),
        ),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * One page of a drawing the app window drew (`ImportItem.drawing`: PDF, WebP, SVG), as a PNG:
   * written to `drawings/<stem>/plan.png` (`drawings/<stem>-p<page>/plan.png` when the file has
   * several `pages`) with its provisional placement and a hidden `raster` layer (`role: 'plan'`,
   * `format: 'image'`). Only a drawing that an import of this session staged and that is not
   * closed yet (`builder:closeDrawing`) takes pages. Refused on a package.
   */
  'builder:addDrawingPage': {
    request: z
      .object({
        projectId: z.string().min(1),
        stem: DrawingStem,
        /** The original's file name, for the layer name. */
        name: z.string().min(1).max(255),
        /** 1-based page number, and how many pages the file has (absent: a one page drawing). */
        page: z.number().int().min(1).max(9999).optional(),
        pages: z.number().int().min(1).max(9999).optional(),
        png: z.instanceof(Uint8Array).refine((d) => d.byteLength <= 64 * 1024 * 1024, {
          message: 'A drawing page is at most 64 MB',
        }),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, layerId: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * The app window is done with a staged drawing: all its pages are in, the person cancelled, or
   * the file could not be drawn. No more pages are taken for `stem`. When it got none, the copy
   * the import made (`drawings/<stem>.<ext>`) is removed (`removed`), and only that copy.
   */
  'builder:closeDrawing': {
    request: z.object({ projectId: z.string().min(1), stem: DrawingStem }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), removed: z.boolean() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Save an alignment: a mesh layer `transform` (georeference) or a video layer's `offsetMs` and
   * `lens` (calibration), to one or more layers. The manifest is backed up and validated first.
   */
  'builder:updateLayers': {
    request: z
      .object({
        projectId: z.string().min(1),
        layerIds: z.array(z.string().min(1)).min(1),
        patch: LayerPatch,
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Where each placed layer lies, read from its files (local frame boxes), and what would stop a
   * re-centre (`builder:recentre`). Layers without an extent are left out. Reads only. `full`
   * also reads the kinds Properties reads (a kit pyramid's `tiles.json` corners, a COG, ...).
   */
  'builder:layerExtents': {
    request: z.object({ projectId: z.string().min(1), full: z.boolean().optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        extents: z.array(z.object({ layerId: z.string().min(1), min: Vec3, max: Vec3 })),
        recentre: z.object({ blockers: z.array(z.string()) }),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * The Properties of one dataset, read from its files (`LayerInfo`). Reads only. A package
   * answers a failure: its files stay inside the `.aio`.
   */
  'layer:info': {
    request: z.object({ projectId: ProjectId, layerId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), info: LayerInfo }),
      Failure,
    ]),
  },
  /**
   * Copy each layer's own files unchanged into `<dir>/<layer name>/`, with `<layer name>.crs.json`
   * for a layer in the local frame. A folder that is already there is never overwritten (the
   * layer is named in `skipped`). Progress arrives as `export:progress` with `jobId`;
   * `export:cancel` with the same id stops it. Refused for a package.
   */
  'layer:export': {
    request: z
      .object({
        projectId: ProjectId,
        jobId: z.string().min(1).max(64),
        layerIds: z.array(z.string().min(1)).min(1),
        dir: z.string().min(1),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [LayerExportResult, Failure]),
  },
  /** Show the layer's main file in the file manager; main finds the path. */
  'layer:reveal': {
    request: z.object({ projectId: ProjectId, layerId: z.string().min(1) }).strict(),
    response: OkOrFailure,
  },
  /**
   * Move the project origin to `at` (E, N in the project CRS; height kept) and shift the local
   * positions the manifest holds so nothing moves on the ground (data-conventions section 1).
   * Refused, writing nothing, while the project holds anything else placed against the origin.
   */
  'builder:recentre': {
    request: z
      .object({ projectId: z.string().min(1), at: z.tuple([z.number(), z.number()]) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Re-read the photos of one photos layer from their files with the fixed XMP reader (photo
   * position edit, 21 Oct 2026): each item's imported `pos` (height by the project's height rule)
   * and `q` (gimbal angles) are rewritten; pinned items are left alone; a photo with a hand
   * correction keeps its corrected place (its `offsetM` in `orientation.json` is re-anchored); a
   * thermal `_R` photo without DJI XMP takes its visual twin's place again. A review copy without
   * metadata is read from `folder` (the originals); without one, `needsFolder` names how many.
   * `dryRun` writes nothing and answers the counts it would give. `refined`: processing gave the
   * layer refined poses, which a re-read replaces.
   */
  'builder:rereadPhotos': {
    request: z
      .object({
        projectId: z.string().min(1),
        layerId: z.string().min(1),
        folder: z.string().min(1).max(2048).optional(),
        dryRun: z.boolean().optional(),
      })
      .strict(),
    response: z.union([
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        reread: z.number().int().nonnegative(),
        kept: z.number().int().nonnegative(),
        twins: z.number().int().nonnegative(),
        notFound: z.number().int().nonnegative(),
        refined: z.boolean(),
      }),
      z.object({
        ok: z.literal(false),
        needsFolder: z.literal(true),
        missing: z.number().int().nonnegative(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Rename a survey date (`Capture.label`) or set the colour and icon of its folder. Only the
   * manifest's `captures` entry changes: no layer, no file and no date. Backed up and validated
   * like `builder:updateLayers`.
   */
  'builder:updateCapture': {
    request: z
      .object({
        projectId: z.string().min(1),
        captureId: z.string().min(1),
        patch: CapturePatch,
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Replace the project's class catalogues: add, rename, recolour, set a hotkey or a severity
   * model, delete (ANN-7). Validated in main (unique catalogue and class ids, unique hotkeys,
   * one letter a-z, not `a` or `u`, known severity models, no class removed while `issues.json` uses it),
   * backed up and journaled like `builder:updateCapture`.
   */
  'builder:updateClasses': {
    request: z
      .object({
        projectId: z.string().min(1),
        catalogues: z.array(ClassCatalogue),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Append one severity scale. Validated (unique id and name, at least one grade in order),
   * backed up and journaled like `builder:updateClasses`. Scales already in the project stay.
   */
  'builder:addSeverityModel': {
    request: z.object({ projectId: z.string().min(1), model: SeverityModel }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * The survey date of a day: the project's capture with that date, or a new one (`capture-<date>`,
   * label "Survey") added in date order. Nothing is written when the date exists.
   */
  'builder:ensureCapture': {
    request: z.object({ projectId: z.string().min(1), date: IsoDate }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        captureId: Id,
        created: z.boolean(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Remove a survey date that no layer names (`Layer.capture`): only `manifest.captures` changes.
   * Refused while a layer names it, for an unknown id and on a package. Backed up and validated.
   */
  'builder:removeCapture': {
    request: z.object({ projectId: z.string().min(1), captureId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * What removing `targets` takes along (delete and start over, 13 Oct 2026): read from disk, no
   * change. `plan.refused` says why the removal cannot happen (a package, a live job, an unknown
   * target).
   */
  'builder:removePlan': {
    request: z
      .object({ projectId: z.string().min(1), targets: z.array(RemoveTarget).min(1).max(5000) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), plan: RemovalPlan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Remove `targets` and what they take along: files to `.trash/`, one manifest save. */
  'builder:remove': {
    request: z
      .object({ projectId: z.string().min(1), targets: z.array(RemoveTarget).min(1).max(5000) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, plan: RemovalPlan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** What the project trash holds (0 and 0 for a package or an unknown project). */
  'builder:trash': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({
      bytes: z.number().int().nonnegative(),
      entries: z.number().int().nonnegative(),
    }),
  },
  /** Delete the project trash for good; `held` entries were in use and stay. */
  'builder:emptyTrash': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        freed: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },

  // ---------------------------------------------------------------- M8 change (C1)
  /** Every change set of the project (`<project>/change/*.json`), newest first. */
  'change:list': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        sets: z.array(ChangeSetSummary),
        /** Files in change/ that are not valid change sets, left as they are. */
        problems: z.array(z.object({ name: z.string(), error: z.string() })),
        /** A package: reviews can be read but not saved. */
        readOnly: z.boolean(),
      }),
      Failure,
    ]),
  },
  'change:read': {
    request: z.object({ projectId: ProjectId, id: ChangeSetId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), set: ChangeSet, readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /** Replace `change/<id>.json` atomically with a `.bak`; refused for packages. */
  'change:write': {
    request: z.object({ projectId: ProjectId, set: ChangeSet }).strict(),
    response: OkOrFailure,
  },
  /**
   * Run the in-app producers (issues, detections, map vectors) for a date pair and write their
   * change sets, merging earlier reviews by item id. Progress: `change:progress` with `jobId`.
   */
  'change:compute': {
    request: z
      .object({
        jobId: z.string().min(1).max(64),
        projectId: ProjectId,
        from: z.string().min(1),
        to: z.string().min(1),
        kinds: z.array(ChangeKind).min(1),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), ids: z.array(ChangeSetId) }),
      Failure,
    ]),
  },
  'change:cancel': {
    request: z.object({ jobId: z.string().min(1).max(64) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },

  // ---------------------------------------------------------------- M8 procedural models (C5)
  'model:list': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), models: z.array(ProcModelSummary), readOnly: z.boolean() }),
      Failure,
    ]),
  },
  'model:read': {
    request: z.object({ projectId: ProjectId, id: ProcModelId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), model: ProcModel, readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /** Replace `models/<id>.procmodel.json` atomically with a `.bak`; refused for packages. */
  'model:write': {
    request: z.object({ projectId: ProjectId, model: ProcModel }).strict(),
    response: OkOrFailure,
  },
  /**
   * Mesh the accepted parts into `models/<id>.glb` (or every part into `models/draft-<id>.glb` for
   * a preview) and add or update its mesh layer (`derived: { kind: 'model' }`).
   */
  'model:build': {
    request: z
      .object({ projectId: ProjectId, id: ProcModelId, draft: z.boolean().optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        layer: z.string(),
        glb: z.string(),
        /** Triangles written (engineering and parts models). */
        triangles: z.number().int().nonnegative().optional(),
        /** How an engineering GLB was meshed (absent for a parts-only model). */
        report: GlbBuildReport.optional(),
      }),
      Failure,
    ]),
  },
  /** Set the project policy `aiCloudDrawings` (manifest, backed up); refused for packages. */
  'ai:setCloudDrawings': {
    request: z.object({ projectId: ProjectId, allow: z.boolean() }).strict(),
    response: OkOrFailure,
  },

  // ---------------------------------------------------------------- engineering model (S2)
  /**
   * Export an engineering model into `<folder>/<modelId>/`: `<id>.glb` (with
   * `asset.extras.aioGeoref`), `<id>.procmodel.json`, `<id>.components.json` and
   * `<id>.georeference.json`, written into a staging folder renamed when complete. Accepted
   * components only. `files` are the absolute paths written; `report` says what was coarsened for
   * the budget or could not be built.
   */
  'model:exportEngineering': {
    request: z
      .object({
        projectId: ProjectId,
        modelId: ProcModelId,
        /** An absolute folder (a drive or UNC path on Windows, `/...` elsewhere). */
        folder: z
          .string()
          .min(1)
          .max(1000)
          .regex(
            /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/)/,
            'The export folder must be an absolute path.',
          ),
        detail: Detail,
        replace: z.boolean().optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), files: z.array(z.string()), report: GlbBuildReport }),
      Failure,
    ]),
  },
  /**
   * The files of an engineering run (`engineering/<run>/run.json`, `evidence.json`,
   * `proposal.json`); null for each one not there (and for every one in a package, which leaves
   * run files out). A file that is there but not valid is an error naming it.
   */
  'engineer:runRead': {
    request: z.object({ projectId: ProjectId, runId: RunId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        run: EngineerRun.nullable(),
        evidence: EvidencePack.nullable(),
        proposal: EngineerProposal.nullable(),
      }),
      Failure,
    ]),
  },
  'engineer:runList': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        runs: z.array(EngineerRun.pick({ id: true, modelId: true, createdAt: true })).max(100),
      }),
      Failure,
    ]),
  },
  /** Write `engineering/<run.id>/run.json` atomically with a `.bak`; refused for packages. */
  'engineer:runWrite': {
    request: z
      .object({
        projectId: ProjectId,
        run: EngineerRun,
        /** Also write `engineering/<run.id>/proposal.json` (atomic, `.bak`) when given. */
        proposal: EngineerProposal.optional(),
      })
      .strict(),
    response: OkOrFailure,
  },
  /**
   * Check a model's built GLB as written (`models/<id>.glb`, or the draft): the Khronos glTF
   * validator in main, finite positions, index ranges, unit normals, degenerate and duplicate
   * triangles, closed solids except declared openings, and the triangle budget of `detail`.
   */
  'engineer:validate': {
    request: z
      .object({ projectId: ProjectId, modelId: ProcModelId, draft: z.boolean(), detail: Detail })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), report: GlbCheckReport }),
      Failure,
    ]),
  },
  /**
   * Accept an engineering model: build `models/<id>.glb`, check the written bytes (the Khronos
   * validator, finite positions, index ranges; refused with the reasons when they fail, nothing
   * changed), then its one layer `model-<id>` (the draft preview goes). The layer keeps a placement
   * the person made (Place model); otherwise it takes the model's georeference, placed from it.
   * Writes `models/<id>.georeference.json` and `models/<id>.components.json`. Idempotent:
   * accepting again replaces that one layer. Refused for packages.
   */
  'engineer:accept': {
    request: z.object({ projectId: ProjectId, modelId: ProcModelId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        layer: z.string(),
        files: z.array(z.string()),
        report: GlbBuildReport.optional(),
        /** The checks of the accepted GLB as written (the Khronos validator included). */
        check: GlbCheckReport,
      }),
      Failure,
    ]),
  },
  /**
   * One evidence image of a run (listed in its `evidence.json`, under `engineering/<run>/img/`) as
   * a data URL at most 1568 px on its long side, for the send preview. Never a cloud or a file
   * outside the run's images.
   */
  'engineer:evidenceImage': {
    request: z
      .object({
        projectId: ProjectId,
        runId: RunId,
        imageId: z.string().regex(/^img-[a-z0-9-]{1,40}$/),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), dataUrl: z.string() }),
      Failure,
    ]),
  },
  /**
   * Set the project policies `aiCloudPhotos` and `aiCloudScans` (manifest, backed up; false
   * removes the flag, so absent means off); refused for packages.
   */
  'ai:setCloudEvidence': {
    request: z
      .object({
        projectId: ProjectId,
        photos: z.boolean().optional(),
        scans: z.boolean().optional(),
      })
      .strict()
      .refine((r) => r.photos !== undefined || r.scans !== undefined, {
        message: 'Give photos or scans',
      }),
    response: OkOrFailure,
  },
  /**
   * What the engineer step would send for this request, built in main by the same function as
   * the request (images cut to the model's limit, downscaled, metadata stripped; the request
   * text), with the route, the project's photo and scan consents read from disk, the cost
   * estimate (absent when the model has no price) and a one-time consent token for exactly this
   * content. Nothing is sent and no key is read.
   */
  'ai:engineerPreview': {
    request: EngineerCallRequest,
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        route: ModelRouteSchema,
        cloud: z.boolean(),
        flags: z.object({ photos: z.boolean(), scans: z.boolean() }),
        estimateUsd: z.number().nonnegative().optional(),
        content: EvidencePreviewContent,
        /** Valid once, for this project and this content, for a few minutes. */
        consent: z.string().max(100),
      }),
      Failure,
    ]),
  },
  'engineer:sourceStamp': {
    request: z.object({ projectId: z.string().min(1), setup: EngineerSetup }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), signature: z.string() }),
      Failure,
    ]),
  },
  /**
   * One engineer request (structured, cached, budgeted). Gates in main: offline-only, the model's
   * capabilities, the project policy, the photo and scan consents re-read from the manifest (a
   * one-time consent counts only with a token from `ai:engineerPreview` for the same content),
   * key, cache, the run's cost cap and its 10 minute AI time, one request in flight per run.
   * `runId` is the IPC run, cancelled with `ai:cancel`; usage goes out as `ai:event` usage.
   */
  'ai:engineer': {
    request: EngineerCallRequest.extend({
      runId: z.string().min(1).max(100),
      costConfirmed: z.boolean().optional(),
      consent: z
        .object({ token: z.string().max(100), photos: z.boolean(), scans: z.boolean() })
        .strict()
        .optional(),
    }).strict(),
    response: EngineerOutcomeSchema,
  },

  // ---------------------------------------------------------------- telecom antenna inventory
  /** Read `telecom/antennas.json`; `file` is null when no run has written one yet. */
  'telecom:readAntennas': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: AntennasFile.nullable(), readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /** Write `telecom/antennas.json` atomically (`.bak`, journaled); refused for packages. */
  'telecom:writeAntennas': {
    request: z.object({ projectId: ProjectId, file: AntennasFile }).strict(),
    response: OkOrFailure,
  },
  /**
   * What an AI labelling request would send: the unit crops, the provider and the estimate. The
   * token is valid once, for these units, for a few minutes.
   */
  'ai:antennaLabelPreview': {
    request: z
      .object({ projectId: ProjectId, unitIds: z.array(z.string().min(1)).min(1).max(200) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        provider: z.string(),
        model: z.string(),
        cloud: z.boolean(),
        photosAllowed: z.boolean(),
        crops: z.array(z.object({ unitId: z.string(), path: z.string() }).strict()),
        missing: z.array(z.string()),
        estimate: z
          .object({
            images: z.number().int().nonnegative(),
            inputTokens: z.number().nonnegative(),
            costUsd: z.number().nonnegative().optional(),
          })
          .strict(),
        token: z.string().max(100),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Label antenna crops with the vision route. AI changes only kind, kindBasis and ai, never a
   * number. Gates in main: `check('vision')`, the photo consent or `photos`, and the preview token
   * for every cloud request.
   */
  'ai:labelAntennas': {
    request: z
      .object({
        runId: z.string().min(1),
        projectId: ProjectId,
        unitIds: z.array(z.string().min(1)).min(1).max(200),
        token: z.string().max(100).optional(),
        photos: z.boolean().optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        provider: z.string(),
        model: z.string(),
        promptVersion: z.string(),
        labels: z.array(
          z
            .object({ unitId: z.string(), label: AntennaAiLabel, reason: z.string().max(200) })
            .strict(),
        ),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        costUsd: z.number().nonnegative().optional(),
        warnings: z.array(z.string()),
      }),
      Failure,
    ]),
  },
  /**
   * What an Auto-plan AI request would send: the route (vision when photos are allowed and crops
   * exist, else chat), the crops that go with it and the estimate. The token is valid once, for
   * this project and these units, for a few minutes, and binds whether photos go, the crop files
   * and the route. The text payload (unit sizes, the model and frequency text a person typed, the
   * catalogue) is not bound: the renderer composes it at send time in `ai:rfPlan`.
   */
  'ai:rfPlanPreview': {
    request: z
      .object({ projectId: ProjectId, unitIds: z.array(z.string().min(1)).min(1).max(200) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        provider: z.string(),
        model: z.string(),
        cloud: z.boolean(),
        photosAllowed: z.boolean(),
        crops: z.array(z.object({ unitId: z.string(), path: z.string() }).strict()),
        estimate: z
          .object({
            inputTokens: z.number().nonnegative(),
            costUsd: z.number().nonnegative().optional(),
          })
          .strict(),
        token: z.string().max(100),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Auto-plan's AI step: one request for the whole site, which proposes equipment and one carrier
   * per unit (LTE and NR only). The AI never sets azimuth, tilt or height. Gates in main: the
   * route, the project policy, the photo consent or `photos`, and the preview token for every
   * cloud request.
   */
  'ai:rfPlan': {
    request: z
      .object({
        runId: z.string().min(1),
        projectId: ProjectId,
        units: z.array(RfPlanUnitInput).min(1).max(200),
        catalogue: z.array(RfPlanCatalogueInput).min(1).max(400),
        token: z.string().max(100).optional(),
        photos: z.boolean().optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        provider: z.string(),
        model: z.string(),
        promptVersion: z.string(),
        picks: z.array(RfPlanAiPick),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        costUsd: z.number().nonnegative().optional(),
        warnings: z.array(z.string()),
      }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- M8 local detection (C6)
  /**
   * Installed detector models and the onnxruntime execution provider. A model whose licence is
   * copyleft, non-commercial or unknown carries `licenceWarning` (its kind).
   */
  'inference:models': {
    request: Empty,
    response: z.object({ runtime: InferenceRuntime, models: z.array(DetectorModelInfo) }),
  },
  /**
   * Copy a model folder or `model.onnx` with its `model.json` card into the models folder after a
   * SHA-256 check, a layout probe and the person's licence acknowledgement. Only an empty licence
   * is refused; a copyleft, non-commercial or unknown one imports with `model.licenceWarning`.
   */
  'inference:importModel': {
    request: z.object({ path: z.string().min(1), acceptLicence: z.boolean() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), model: DetectorModelInfo }),
      Failure,
    ]),
  },
  'inference:removeModel': {
    request: z.object({ id: DetectorModelId }).strict(),
    response: OkOrFailure,
  },
  /**
   * Run a detector on photos or frames; writes `detections/model-<run>.json` (draft, `source:
   * 'model'`). Progress: `inference:progress` with `runId`; cancel keeps the finished items. An
   * item that cannot be read is `skipped`; a run where every item it tried was skipped fails.
   */
  'inference:run': {
    request: z
      .object({
        runId: z.string().min(1).max(64),
        projectId: ProjectId,
        model: DetectorModelId,
        items: z.array(InferenceItem).min(1).max(100_000),
        /** Model class name to project class id; unmapped classes keep the model's name as label. */
        classMap: z.record(z.string(), z.string()),
        minConfidence: z.number().min(0).max(1),
        tile: z
          .object({
            size: z.number().int().min(64).max(8192),
            overlap: z.number().int().min(0).max(4096),
          })
          .strict()
          .optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        file: z.string(),
        count: z.number().int().nonnegative(),
        /** Items that could not be read (decode failed); not assessed, so a resume retries them. */
        skipped: z.number().int().nonnegative().optional(),
        /** Why the first skipped item could not be read. */
        reason: z.string().max(2000).optional(),
      }),
      Failure,
    ]),
  },
  'inference:cancel': {
    request: z.object({ runId: z.string().min(1).max(64) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },

  // ---------------------------------------------------------------- M8 local agent (C7)
  /** Find the models of a local server (loopback unless the person accepted the cloud warning). */
  'ai:localModels': {
    request: z.object({ baseUrl: z.url({ protocol: /^https?$/ }).optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        server: z
          .object({
            kind: z.enum(['ollama', 'openai-compatible']),
            version: z.string().optional(),
          })
          .optional(),
        models: z.array(LocalModelInfo),
      }),
      Failure,
    ]),
  },
  /** One tiny tool-call request (and an image request when vision is claimed), with latency. */
  'ai:localProbe': {
    request: z
      .object({
        model: z.string().min(1).max(200),
        baseUrl: z.url({ protocol: /^https?$/ }).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        tools: z.boolean(),
        vision: z.boolean(),
        contextTokens: z.number().int().positive().optional(),
        latencyMs: z.number().nonnegative(),
      }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- launch screen
  /** The launch screen preference, userData `launch.json` (missing file: the defaults, shown). */
  'launch:get': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), settings: LaunchSettings }),
      Failure,
    ]),
  },
  /** Settings, Appearance, Show launch screen. Answers the file as written. */
  'launch:set': {
    request: z.object({ show: z.boolean() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), settings: LaunchSettings }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- M9 identity and members (T2)
  /** This person's identity (moved once from the renderer's stored author) and device id. */
  'identity:get': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        identity: Identity,
        /** Null until the device key is made (first need). */
        device: DeviceId.nullable(),
        /** The vault failed: ops are written unsigned and Verify says so. */
        unsigned: z.boolean(),
      }),
      Failure,
    ]),
  },
  /**
   * Set name, initials or email. `migrateFrom` carries the old `stratlas.author` value on first
   * start (once); main never reads renderer storage.
   */
  'identity:set': {
    request: z
      .object({
        name: PersonName.optional(),
        initials: Initials.optional(),
        email: z.union([z.email().max(254), z.literal('')]).optional(),
        migrateFrom: z.string().max(80).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), identity: Identity }),
      Failure,
    ]),
  },
  /** Save this person's identity card (`.aioid`) through a save dialog. */
  'identity:exportCard': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string().nullable() }),
      Failure,
    ]),
  },
  /** Read and check a card (signature, ids) without adding anyone. */
  'identity:importCard': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        actor: ActorId,
        name: PersonName,
        initials: Initials,
        device: DeviceId,
      }),
      Failure,
    ]),
  },
  'members:list': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        members: z.array(Member),
        /** This person's role; absent when the project is not shared. */
        me: Role.optional(),
      }),
      Failure,
    ]),
  },
  /** Add a person from an identity card (owner only; the owner's device certifies the card). */
  'members:add': {
    request: z
      .object({ projectId: ProjectId, card: z.string().min(1), role: Role, certify: z.boolean() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), member: Member }),
      Failure,
    ]),
  },
  'members:setRole': {
    request: z.object({ projectId: ProjectId, actor: ActorId, role: Role }).strict(),
    response: OkOrFailure,
  },
  'members:remove': {
    request: z.object({ projectId: ProjectId, actor: ActorId }).strict(),
    response: OkOrFailure,
  },
  /** Ops by the device after its revocation are quarantined; earlier ones stay valid. */
  'members:revokeDevice': {
    request: z
      .object({ projectId: ProjectId, device: DeviceId, reason: z.string().max(500).optional() })
      .strict(),
    response: OkOrFailure,
  },

  // ---------------------------------------------------------------- M9 journal and audit (T1)
  /** History of one record, or the project's audit (filters), newest first. */
  'journal:history': {
    request: z
      .object({
        projectId: ProjectId,
        filter: AuditFilter.optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        cursor: z.string().max(4096).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        entries: z.array(AuditEntry),
        cursor: z.string().nullable(),
        /** The journal is switched off for this private project (decision 8). */
        off: z.boolean().optional(),
      }),
      Failure,
    ]),
  },
  /** Verify chains, signatures, gaps, forks and redactions (in the data process). */
  'journal:verify': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), report: VerifyReport }),
      Failure,
    ]),
  },
  /** Owner only: remove an op's payload (an `op.redact` op); the chain still verifies. */
  'journal:redact': {
    request: z
      .object({ projectId: ProjectId, op: OpId, reason: z.string().max(500).optional() })
      .strict(),
    response: OkOrFailure,
  },
  /**
   * M9 integration (decision 8): switch the journal of a private project off or on; the switch is
   * recorded (`journal.off`, `journal.on`). A team project keeps its journal on.
   */
  'journal:setEnabled': {
    request: z
      .object({ projectId: ProjectId, on: z.boolean(), reason: z.string().max(500).optional() })
      .strict(),
    response: OkOrFailure,
  },
  /** CSV (UTF-8 with BOM) or signed JSON with the device keys and checkpoints, via a save dialog. */
  'audit:export': {
    request: z
      .object({ projectId: ProjectId, format: AuditExportFormat, filter: AuditFilter.optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        path: z.string().nullable(),
        count: z.number().int().nonnegative(),
      }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- M9 review workflow (T3)
  /** Comments, assignments, approvals and policy of the project or of one target. */
  'collab:read': {
    request: z.object({ projectId: ProjectId, target: CollabTarget.optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), state: CollabState }),
      Failure,
    ]),
  },
  'collab:comment': {
    request: z
      .object({
        projectId: ProjectId,
        target: CollabTarget,
        text: z.string().trim().min(1).max(10_000),
        visibility: z.enum(['team', 'client']).optional(),
        mentions: z.array(ActorId).max(50).optional(),
        replyTo: CommentId.optional(),
        view: SavedView.optional(),
        /** M9 integration: how the comment was made (the agent's tool call); main stamps it. */
        via: Via.optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), id: CommentId }),
      Failure,
    ]),
  },
  'collab:editComment': {
    request: z
      .object({ projectId: ProjectId, id: CommentId, text: z.string().trim().min(1).max(10_000) })
      .strict(),
    response: OkOrFailure,
  },
  'collab:deleteComment': {
    request: z.object({ projectId: ProjectId, id: CommentId }).strict(),
    response: OkOrFailure,
  },
  /** M9 integration, owner only: remove the text of a comment from every copy (`comment.redact`). */
  'collab:redactComment': {
    request: z
      .object({ projectId: ProjectId, id: CommentId, reason: z.string().max(500).optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), removed: z.number().int().nonnegative() }),
      Failure,
    ]),
  },
  'collab:assign': {
    request: z
      .object({
        projectId: ProjectId,
        target: CollabTarget,
        assignee: ActorId.nullable(),
        due: z.iso.date().optional(),
        note: z.string().max(2000).optional(),
        /** M9 integration: how the assignment was made (the agent's tool call). */
        via: Via.optional(),
      })
      .strict(),
    response: OkOrFailure,
  },
  /**
   * Approve, request changes (a comment is required) or accept. Main computes the content hash;
   * the agent has no route to this channel (decision 6).
   */
  'collab:approve': {
    request: z
      .object({
        projectId: ProjectId,
        target: CollabTarget,
        decision: ApprovalDecision,
        comment: z.string().max(10_000).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        /** The approval completed the policy and the status op was written. */
        approved: z.boolean(),
      }),
      Failure,
    ]),
  },
  'collab:withdraw': {
    request: z.object({ projectId: ProjectId, id: z.string().min(1).max(64) }).strict(),
    response: OkOrFailure,
  },
  /** Change the team policy (owner only): approvals, verification level, package history. */
  'collab:policy': {
    request: z.object({ projectId: ProjectId, policy: PolicySetPayload }).strict(),
    response: OkOrFailure,
  },

  // ---------------------------------------------------------------- M9 sharing and sync (T4, T5)
  /** Share the project: exchange files only, a hub folder, or a team server. */
  'team:share': {
    request: z
      .object({
        projectId: ProjectId,
        mode: SyncMode.exclude(['off']),
        name: z.string().min(1).max(200).optional(),
        hubPath: z.string().min(1).optional(),
        serverId: z.string().min(1).max(64).optional(),
        /** M9 integration: join this team project found on the hub or server instead of a new one. */
        teamProjectId: TeamProjectId.optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), status: TeamStatus }),
      Failure,
    ]),
  },
  /** M9 integration: the team projects a hub folder holds (to join one). */
  'team:hubProjects': {
    request: z.object({ hubPath: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        projects: z.array(z.object({ teamProjectId: TeamProjectId, name: z.string() })),
      }),
      Failure,
    ]),
  },
  'team:status': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), status: TeamStatus }),
      Failure,
    ]),
  },
  /** Stop syncing this copy (the journal and the data stay). */
  'team:leave': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: OkOrFailure,
  },
  /** Sync with the hub or server now; progress on `sync:progress`. */
  'sync:now': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        pulled: z.number().int().nonnegative(),
        pushed: z.number().int().nonnegative(),
        conflicts: z.number().int().nonnegative(),
      }),
      Failure,
    ]),
  },
  'sync:conflicts': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), conflicts: z.array(Conflict) }),
      Failure,
    ]),
  },
  /** Keep ours, take theirs or restore a value from history (a `conflict.resolve` op). */
  'sync:resolve': {
    request: z
      .object({
        projectId: ProjectId,
        conflict: z.string().min(1).max(300),
        choice: z.enum(['ours', 'theirs', 'restore', 'edit']),
        op: OpId.optional(),
        /** M9 integration: the value typed with choice `edit`. */
        value: z.unknown().optional(),
      })
      .strict(),
    response: OkOrFailure,
  },
  'sync:quarantine': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), entries: z.array(QuarantineEntry) }),
      Failure,
    ]),
  },
  /** Owner only: apply a quarantined op anyway (recorded as an op). */
  'sync:release': {
    request: z.object({ projectId: ProjectId, op: OpId }).strict(),
    response: OkOrFailure,
  },

  // ---------------------------------------------------------------- M9 exchange files (T5)
  /** M9 integration: the other devices of the team project, for "Export changes for ...". */
  'exchange:peers': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        peers: z.array(
          z.object({
            device: DeviceId,
            actor: ActorId,
            name: PersonName,
            initials: Initials,
            /** What this copy last sent them or received from them. */
            heads: Heads.optional(),
          }),
        ),
      }),
      Failure,
    ]),
  },
  /** What a patch or bundle for a peer (or since a date) would carry, before writing it. */
  'exchange:plan': {
    request: z
      .object({
        projectId: ProjectId,
        kind: ExchangeKind.exclude(['reply']),
        peer: DeviceId.optional(),
        since: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        ops: z.number().int().nonnegative(),
        blobs: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
        heads: Heads,
      }),
      Failure,
    ]),
  },
  'exchange:export': {
    request: z
      .object({
        jobId: z.string().min(1).max(64),
        projectId: ProjectId,
        kind: ExchangeKind.exclude(['reply']),
        peer: DeviceId.optional(),
        since: z.iso.datetime({ offset: true }).optional(),
        passphrase: z.string().min(8).max(256).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string().nullable(), bytes: z.number().int() }),
      Failure,
    ]),
  },
  /** Read an `.aiosync` and say what applying it would do; nothing is written. */
  'exchange:preview': {
    request: z
      .object({
        projectId: ProjectId,
        path: z.string().min(1),
        passphrase: z.string().min(1).max(256).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), preview: ExchangePreview }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        code: FailureCode.optional(),
        needsPassphrase: z.boolean().optional(),
      }),
    ]),
  },
  /** Apply an exchange file atomically and idempotently (ops dedupe by id); progress on `exchange:progress`. */
  'exchange:import': {
    request: z
      .object({
        jobId: z.string().min(1).max(64),
        projectId: ProjectId,
        path: z.string().min(1),
        passphrase: z.string().min(1).max(256).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        applied: z.number().int().nonnegative(),
        duplicates: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
        conflicts: z.number().int().nonnegative(),
      }),
      Failure,
    ]),
  },
  /** Player mode: save the client's comments and acceptance as a signed reply file. */
  'exchange:reply': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string().nullable() }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- M9 binaries by content (T6)
  'blobs:status': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        layers: z.array(LayerBlobStatus),
        cache: z.object({
          bytes: z.number().int().nonnegative(),
          capBytes: z.number().int().nonnegative(),
        }),
      }),
      Failure,
    ]),
  },
  /** Download a layer's (or one blob's) files; progress on `blobs:progress`. */
  'blobs:fetch': {
    request: z
      .object({
        jobId: z.string().min(1).max(64),
        projectId: ProjectId,
        layer: z.string().min(1).optional(),
        sha256: Sha256Hex.optional(),
      })
      .strict(),
    response: OkOrFailure,
  },
  'blobs:cancel': {
    request: z.object({ jobId: z.string().min(1).max(64) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
  'blobs:policy': {
    request: z
      .object({ projectId: ProjectId, layer: z.string().min(1), policy: FetchPolicy })
      .strict(),
    response: OkOrFailure,
  },
  /** Hash and register the project's binaries (resumable, in the data process). */
  'blobs:index': {
    request: z.object({ jobId: z.string().min(1).max(64), projectId: ProjectId }).strict(),
    response: OkOrFailure,
  },
  /**
   * M9 integration: free cache space. Only blobs held elsewhere (hub or server) and not used by an
   * open project are removed; `targetBytes` absent frees down to the cap.
   */
  'blobs:free': {
    request: z.object({ targetBytes: z.number().int().nonnegative().optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        removed: z.number().int().nonnegative(),
        freed: z.number().int().nonnegative(),
      }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- M9 team server (T7, preview)
  /** Enrol this device with an invite code; the fingerprint must match the one the person accepted. */
  'server:enrol': {
    request: z
      .object({
        url: z.url({ protocol: /^https$/ }),
        code: z.string().min(6).max(128),
        fingerprint: Sha256Hex.optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), server: ServerInfo }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        code: FailureCode.optional(),
        /** First contact: the certificate fingerprint to show and confirm before enrolling. */
        fingerprint: Sha256Hex.optional(),
      }),
    ]),
  },
  'server:list': {
    request: Empty,
    response: z.object({ servers: z.array(ServerInfo) }),
  },
  /** M9 integration: is an enrolled server reachable now (health with a signed request). */
  'server:check': {
    request: z.object({ id: z.string().min(1).max(64) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), server: ServerInfo }),
      Failure,
    ]),
  },
  /** Remove an enrolled server and its vault entry from this machine. */
  'server:forget': {
    request: z.object({ id: z.string().min(1).max(64) }).strict(),
    response: OkOrFailure,
  },

  // ---------------------------------------------------------------- M10 photogrammetry (G4)
  // Runs live in `<project>/photogrammetry/<run>/` (data-conventions section 21). The jobs
  // themselves start through `jobs:start` (`photo.align`, `photo.georef`, `photo.products`).
  /** CPU, memory, free disk, GPUs and whether processing can run on this computer (cached). */
  'photo:probe': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), probe: HardwareProbe }),
      Failure,
    ]),
  },
  /** Time, disk and memory a run would need here, before it starts. */
  'photo:estimate': {
    request: z
      .object({
        projectId: ProjectId.optional(),
        photos: PhotoSource,
        preset: PhotoPreset,
        products: z.array(PhotoProduct),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), estimate: PhotoEstimate }),
      Failure,
    ]),
  },
  /** The project's runs, newest first. */
  'photo:runs': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), runs: z.array(PhotoRunSummary) }),
      Failure,
    ]),
  },
  /** One run's `run.json` and its accuracy report when there is one. */
  'photo:readRun': {
    request: z.object({ projectId: ProjectId, run: PhotoRunId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        run: PhotoRun,
        accuracy: AccuracyReport.nullable(),
        /** Folders of a `{ folders }` source that are not there any more (Start over). */
        missingFolders: z.array(z.string()).optional(),
      }),
      Failure,
    ]),
  },
  /** A run's `gcp.json`; null when no points were imported yet. */
  'photo:readGcp': {
    request: z.object({ projectId: ProjectId, run: PhotoRunId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), gcp: GcpFile.nullable() }),
      Failure,
    ]),
  },
  /** Write `gcp.json` atomically with a `.bak`; refused (`read-only`) for packages. */
  'photo:writeGcp': {
    request: z.object({ projectId: ProjectId, run: PhotoRunId, gcp: GcpFile }).strict(),
    response: OkOrFailure,
  },
  /**
   * **Use refined poses**: with `apply: false`, how far each camera of the photos layer would move;
   * with `apply: true`, swap in the run's refined cameras (`cameras.json` kept as `.bak`).
   */
  'photo:applyPoses': {
    request: z
      .object({ projectId: ProjectId, run: PhotoRunId, layer: Id, apply: z.boolean() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        cameras: z.number().int().nonnegative(),
        medianMoveM: z.number().nonnegative(),
        maxMoveM: z.number().nonnegative(),
        applied: z.boolean(),
      }),
      Failure,
    ]),
  },
  /**
   * One source photo of a run, for marking ground control when the photos are read in place
   * (`PhotoSource.folders`, outside the project). Read-only, and only below the run's recorded photo
   * folders: `photo` is the key of `sparse/photos.json` (or a photos layer photo id); any other path
   * is refused (`not-found`).
   */
  'photo:readPhoto': {
    request: z
      .object({ projectId: ProjectId, run: PhotoRunId, photo: z.string().min(1).max(1024) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        mime: z.enum(['image/jpeg', 'image/png', 'image/tiff']),
        data: z.instanceof(Uint8Array),
      }),
      Failure,
    ]),
  },
  /** Move a run's `work/` folder to the recycle bin (never its outputs); asks first in the UI. */
  'photo:cleanWork': {
    request: z.object({ projectId: ProjectId, run: PhotoRunId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), freedBytes: z.number().int().nonnegative() }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- M10 Globe (G6)
  /** Every library project as a site on the Earth (computed in the data process). */
  'globe:sites': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), sites: z.array(GlobeSite) }),
      Failure,
    ]),
  },
  /** The installed imagery and terrain packs, for the Globe's Imagery and Terrain menus. */
  'globe:packs': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        imagery: z.array(RasterPackInfo),
        terrain: z.array(RasterPackInfo),
      }),
      Failure,
    ]),
  },
  /** userData `globe.json`; the defaults when there is none. */
  'globe:getSettings': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), settings: GlobeSettings }),
      Failure,
    ]),
  },
  'globe:setSettings': {
    request: z.object({ settings: GlobeSettings }).strict(),
    response: OkOrFailure,
  },

  // ---------------------------------------------------------------- M10 3D Tiles and raster packs (G7)
  /** The project's `tilesets.json`; an empty list when there is none. */
  'tilesets:list': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: TilesetsFile }),
      Failure,
    ]),
  },
  /** Write `tilesets.json` atomically with a `.bak`; refused (`read-only`) for packages. */
  'tilesets:write': {
    request: z.object({ projectId: ProjectId, file: TilesetsFile }).strict(),
    response: OkOrFailure,
  },
  /**
   * **Import 3D Tiles**: copy a 3D Tiles 1.0/1.1 tileset from another program (its root
   * `tileset.json` and every file below that folder) into `tiles/<id>/` and list it as `imported`
   * (not visible until its placement is confirmed). Refused (`read-only`) for packages.
   */
  'tilesets:import': {
    request: z
      .object({
        projectId: ProjectId,
        /** The root `tileset.json` on disk. */
        path: z.string().min(1).max(1024),
        name: z.string().min(1).max(200).optional(),
        attribution: z.string().max(500).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), entry: TilesetEntry }),
      Failure,
    ]),
  },
  'imageryPacks:list': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), packs: z.array(RasterPackInfo) }),
      Failure,
    ]),
  },
  /** **Import imagery**: starts a `packs.imagery` job. */
  'imageryPacks:import': {
    request: ImageryImportRequest,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), jobId: JobId }),
      Failure,
    ]),
  },
  'imageryPacks:remove': {
    request: z.object({ id: RasterPackId }).strict(),
    response: OkOrFailure,
  },
  'terrainPacks:list': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), packs: z.array(RasterPackInfo) }),
      Failure,
    ]),
  },
  /** **Import terrain**: starts a `packs.terrain` job. */
  'terrainPacks:import': {
    request: TerrainImportRequest,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), jobId: JobId }),
      Failure,
    ]),
  },
  'terrainPacks:remove': {
    request: z.object({ id: RasterPackId }).strict(),
    response: OkOrFailure,
  },

  // ------------------------------------------- Online maps (ADR 0007, amended 10 and 14 Oct 2026)
  /**
   * Whether online maps are switched on and which online satellite this workstation uses
   * (userData `online.json`), and the Sentinel-2 cache. Whether tiles are requested also depends
   * on `Settings.offlineOnly`; main enforces both.
   */
  'onlineTiles:status': { request: Empty, response: OnlineTilesStatus },
  /** Switch online maps on or off, or choose the online satellite. Off counts at once. */
  'onlineTiles:set': {
    request: z
      .object({ enabled: z.boolean().optional(), source: OnlineSourceId.optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), enabled: z.boolean(), source: OnlineSourceId }),
      Failure,
    ]),
  },
  /** **Clear saved satellite tiles**: deletes every Sentinel-2 tile on disk; answers the empty cache. */
  'onlineTiles:clearCache': { request: Empty, response: OnlineTileCache },
  /** Which map keys this computer holds (never a key). */
  'mapKeys:status': { request: Empty, response: MapKeysStatus },
  /** Check a key with one tile request through main, then keep it in the OS credential store. */
  'mapKeys:set': {
    request: z.object({ provider: MapKeyProvider, key: z.string().min(8).max(512) }).strict(),
    response: OkOrFailure,
  },
  /** Check the saved key with one tile request through main. */
  'mapKeys:test': {
    request: z.object({ provider: MapKeyProvider }).strict(),
    response: OkOrFailure,
  },
  /** Remove the saved key from the OS credential store. */
  'mapKeys:clear': {
    request: z.object({ provider: MapKeyProvider }).strict(),
    response: OkOrFailure,
  },

  /** Open the provider's own feedback page in the browser (main uses a fixed address). */
  'onlineTiles:openFeedback': {
    request: z.object({ provider: z.literal('mapbox') }).strict(),
    response: Empty,
  },

  // ---------------------------------------------------------------- M11 surveying (G0 stubs)
  /**
   * The site's `survey/settings.json`; `exists: false` with the defaults when there is none (G1).
   */
  'survey:readSettings': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        settings: SurveySettings,
        exists: z.boolean(),
        /** Whether `survey/geodesy/site-transform.json` exists (only then is it fetched). */
        tables: z.boolean().optional(),
      }),
      Failure,
    ]),
  },
  /** Write `survey/settings.json` atomically (`.bak`, journaled `survey.settings`); refused for packages. */
  'survey:writeSettings': {
    request: z.object({ projectId: ProjectId, settings: SurveySettings }).strict(),
    response: OkOrFailure,
  },
  /** `survey/measurements.json`; an empty list when there is none (G3). */
  'survey:readMeasurements': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: MeasurementsFile, readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /** Write `survey/measurements.json` atomically (`.bak`, journaled `measurement.*`); refused for packages. */
  'survey:writeMeasurements': {
    request: z.object({ projectId: ProjectId, file: MeasurementsFile }).strict(),
    response: OkOrFailure,
  },
  /** The project's templates (`survey/templates.json`) and the user library (userData). */
  'survey:readTemplates': {
    request: z.object({ projectId: ProjectId.optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        project: SurveyTemplatesFile.nullable(),
        user: SurveyTemplatesFile,
      }),
      Failure,
    ]),
  },
  'survey:writeTemplates': {
    request: z
      .object({
        scope: z.enum(['project', 'user']),
        projectId: ProjectId.optional(),
        file: SurveyTemplatesFile,
      })
      .strict(),
    response: OkOrFailure,
  },
  /** `survey/designs.json`; an empty list when there is none (G6). */
  'survey:readDesigns': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: DesignsFile }),
      Failure,
    ]),
  },
  /** Write `survey/designs.json` (journaled `design.*`); refused for packages. */
  'survey:writeDesigns': {
    request: z.object({ projectId: ProjectId, file: DesignsFile }).strict(),
    response: OkOrFailure,
  },
  /**
   * A quick look at a design file before **Import design** (no job): the format, the units the
   * file states and its source layer names, read in main from a file the person picked. `partial`
   * when the file is too large to read whole (the layers may then be incomplete).
   */
  'survey:probeDesign': {
    request: z.object({ path: z.string().min(1).max(1024) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        format: DesignFormat.nullable(),
        units: DesignSourceUnits.nullable(),
        layers: z.array(z.string().max(200)).max(1000),
        partial: z.boolean(),
      }),
      Failure,
    ]),
  },
  /** Prepared surfaces (`tiles.json` in each `survey/surfaces/<id>/`), for the From and To pickers (G2). */
  'survey:surfaces': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), surfaces: z.array(HeightTiles) }),
      Failure,
    ]),
  },
  /**
   * QA results (`survey/qa/<capture>.json`): every survey's, or one capture's (an empty list when
   * it has none). Packages are read in place (G8).
   */
  'survey:readQa': {
    request: z.object({ projectId: ProjectId, capture: Id.optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), files: z.array(SurveyQa), readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /**
   * **Release** a survey on hold with a person's note: status `released`, journaled `survey.hold`
   * (action `release`), written atomically with a `.bak`; refused for packages (G8).
   */
  'survey:releaseHold': {
    request: z
      .object({ projectId: ProjectId, capture: Id, note: z.string().trim().min(1).max(2000) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), qa: SurveyQa }),
      Failure,
    ]),
  },
  /** `survey/cleanups.json`; an empty list when there is none (G8). */
  'survey:readTerrainEdits': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: TerrainEditsFile, readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /** Write `survey/cleanups.json` atomically (`.bak`, journaled); refused for packages (G8). */
  'survey:writeTerrainEdits': {
    request: z.object({ projectId: ProjectId, file: TerrainEditsFile }).strict(),
    response: OkOrFailure,
  },
  /**
   * Every cleanup recipe of a project (`edits/pointcloud/<layer>.json`, `aio.pccleanup/1`); with
   * `noiseRun`, also the record a `pointcloud.clean` noise job wrote beside its working copy
   * (null when it is missing). `readOnly` for a package.
   */
  'pointcloud:readCleanup': {
    request: z
      .object({
        projectId: ProjectId,
        noiseRun: z.object({ layerId: CleanupLayerId, runId: JobId }).strict().optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        recipes: z.array(PointcloudCleanup),
        noise: NoiseRun.nullable().optional(),
        readOnly: z.boolean(),
      }),
      Failure,
    ]),
  },
  /**
   * Write one layer's recipe atomically (`.bak`, journaled), or with `recipe: null` remove it
   * (kept as `.bak`). Noise working copies of the layer named neither by the recipe nor in `keep`
   * (the renderer's undo history) move to the project trash; `trashed` names them. Refused for
   * packages.
   */
  'pointcloud:writeCleanup': {
    request: z
      .object({
        projectId: ProjectId,
        layerId: CleanupLayerId,
        recipe: PointcloudCleanup.nullable(),
        keep: z.array(ProjectPath).max(200).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), trashed: z.array(z.string()) }),
      Failure,
    ]),
  },
  /**
   * `rf/sectors.json` (`aio.rf-sectors/1`); `file` is null when the project has none. A file saved
   * by a newer version answers a failure with the update message and is left unchanged.
   * `readOnly` for a package. `orphans` are the antenna ids in the file that the antenna
   * inventory no longer has as a usable unit (removed, rejected or not found in the latest run);
   * they are flagged, never deleted (D9). Empty when `telecom/antennas.json` does not exist.
   * `origins`: who set each value, from `rf/sectors.origins.json` (`aio.rf-origins/1`); absent
   * when that sidecar is missing, unreadable or describes another sectors file (every value is
   * then the person's). Never a reason to fail the read.
   */
  'rf:readSectors': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        file: RfSectorsFile.nullable(),
        readOnly: z.boolean(),
        orphans: z.array(AntennaId),
        origins: RfOriginsMap.optional(),
      }),
      Failure,
    ]),
  },
  /**
   * Write `rf/sectors.json` atomically (`.bak`, journaled); copies the catalogue entries it uses
   * into `rf/catalogue.json`. Refused for packages and when the file on disk is newer. `file`
   * carries no origin (`splitRfOrigins`); `origins`, when given, replace `rf/sectors.origins.json`
   * (atomic, `.bak`), bound to the sectors file just written. Absent: the sidecar is left as it is.
   */
  'rf:writeSectors': {
    request: z
      .object({ projectId: ProjectId, file: RfSectorsFile, origins: RfOriginsMap.optional() })
      .strict(),
    /** `warnings`: pattern files that could not be copied into the project. */
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), warnings: z.array(z.string()).optional() }),
      Failure,
    ]),
  },
  /**
   * Catalogue entries: built in (read only), the person's own (userData `rf-catalogue/`) and, with
   * a project, those copied into `rf/catalogue.json`.
   */
  'rf:listCatalogue': {
    request: z.object({ projectId: ProjectId.optional() }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        entries: z.array(z.object({ origin: CatalogueOrigin, entry: RfCatalogueEntry }).strict()),
        /** Catalogue files that could not be read (the rest are still listed). */
        warnings: z.array(z.string()),
      }),
      Failure,
    ]),
  },
  /**
   * Import into the person's catalogue: an MSI / Planet pattern file attached to one port of an
   * antenna entry (`attach`), or a catalogue JSON file (`aio.rf-catalogue/1`). `path` comes from
   * `dialog:openFile`. Answers the entries that were added or changed.
   */
  'rf:importCatalogue': {
    request: z
      .object({
        path: z.string().min(1).max(1024),
        format: z.enum(['msi', 'catalogue']),
        attach: z
          .object({ entryId: CatalogueId, portId: z.string().min(1).max(40) })
          .strict()
          .optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        entries: z.array(RfCatalogueEntry),
        warnings: z.array(z.string()),
      }),
      Failure,
    ]),
  },
  /** Coverage runs (`rf/runs/<runId>/run.json`), newest first; packages read in place. */
  'rf:listRuns': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), runs: z.array(RfRun) }),
      Failure,
    ]),
  },
  /** One run's `run.json`. */
  'rf:readRun': {
    request: z.object({ projectId: ProjectId, runId: RfRunId }).strict(),
    response: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), run: RfRun }), Failure]),
  },
  /**
   * Export a run through the save dialog: a GeoTIFF of a grid, GeoJSON coverage polygons per
   * threshold, or the CSV of per-sector summaries. `path` is null when the person cancelled.
   */
  'rf:export': {
    request: z
      .object({
        projectId: ProjectId,
        runId: RfRunId,
        format: z.enum(['geotiff', 'geojson', 'csv']),
        /** The grid for `geotiff` and `geojson`; ignored for `csv`. */
        view: z.enum(['rsrp', 'bestServer', 'overlap']).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string().nullable() }),
      Failure,
    ]),
  },
  /** `survey/overlays.json`; an empty list when there is none; `readOnly` for a package (G5). */
  'survey:readOverlays': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: SurveyOverlaysFile, readOnly: z.boolean() }),
      Failure,
    ]),
  },
  /**
   * Write `survey/overlays.json` atomically (`.bak`): visibility, names and removals of overlays
   * `survey.overlay` made (a removed overlay's folder is deleted); refused for packages (G5).
   */
  'survey:writeOverlays': {
    request: z.object({ projectId: ProjectId, file: SurveyOverlaysFile }).strict(),
    response: OkOrFailure,
  },
  /** Hydrology runs (`survey/hydro/<run>/run.json`), newest first; packages read in place (G10). */
  'survey:readHydroRuns': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), runs: z.array(HydroRun) }),
      Failure,
    ]),
  },
  /** Haul-road compliance runs (`survey/haul/<run>/run.json`, newest first); packages read in place (G11). */
  'survey:readHaulRuns': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), runs: z.array(HaulRun) }),
      Failure,
    ]),
  },
  /** Search the EPSG catalogue by code, name or area; `near` ranks CRSs whose area holds it (G1). */
  'geodesy:searchCrs': {
    request: z
      .object({
        query: z.string().max(200),
        /** Longitude and latitude, degrees. */
        near: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
        kinds: z.array(z.enum(['projected', 'geographic', 'vertical', 'compound'])).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), results: z.array(CrsCatalogueEntry) }),
      Failure,
    ]),
  },
  /** `survey/calibration.json`, null when the site has none (G1). */
  'geodesy:readCalibration': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), calibration: SiteCalibration.nullable() }),
      Failure,
    ]),
  },
  /**
   * **Apply** (or remove) the site calibration a person confirmed: journaled
   * (`survey.calibration`), marks dependent results stale; refused for packages.
   */
  'geodesy:applyCalibration': {
    request: z
      .object({ projectId: ProjectId, calibration: SiteCalibration, apply: z.boolean() })
      .strict(),
    response: OkOrFailure,
  },
  /** Geoid packs in the data folder's `packs/geoid/` plus the global ones in the pipeline pack. */
  'geoidPacks:list': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), packs: z.array(GeoidPackMeta) }),
      Failure,
    ]),
  },
  /** **Import geoid grid**: a GeoTIFF or GTX with the licence and attribution the person states. */
  'geoidPacks:import': {
    request: z
      .object({
        path: z.string().min(1).max(1024),
        name: z.string().min(1).max(200),
        licence: z.string().min(1).max(200),
        attribution: z.string().max(1000),
        verticalEpsg: z.number().int().positive().optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), pack: GeoidPackMeta }),
      Failure,
    ]),
  },
  'geoidPacks:remove': {
    request: z.object({ id: GeoidPackId }).strict(),
    response: OkOrFailure,
  },
  /**
   * Whether **Suggest boundaries** can run (G12): the segmentation model is the pipeline pack's
   * `models/sam/` (ADR 0011). `no-pack`: no pipeline pack; `no-model`: a pack without the model;
   * `licence`: the model card's licence is refused by the model licence gate.
   */
  'surveyAi:status': {
    request: Empty,
    response: z.object({
      available: z.boolean(),
      model: z.string().optional(),
      reason: z.enum(['no-pack', 'no-model', 'no-runtime', 'licence', 'failed']).optional(),
      detail: z.string().optional(),
    }),
  },
  /**
   * **Suggest boundaries** (G12): a draft outline around a click on an ortho layer, from the
   * local segmentation model; a draft until a person accepts it.
   *
   * The renderer sends a square crop of the ortho around the click (`crop`, RGB, north up, made
   * from the layer's own tiles), placed in the project CRS by its top-left corner and pixel size.
   * Main keeps the model's embeddings of the last crop by `crop.key`: a request with the same key
   * may leave `rgb` out (a second click, a new buffer or vertex count), and is answered with code
   * `stale` when main no longer holds it. `touchesEdge` says the outline reached the crop's edge
   * (the renderer asks again with a larger crop).
   */
  'surveyAi:suggest': {
    request: z
      .object({
        projectId: ProjectId,
        /** The ortho raster layer. */
        layer: Id,
        click: SitePoint2,
        crop: z
          .object({
            /** Names this crop (layer, place, size): equal keys are equal pixels. */
            key: z.string().min(1).max(300),
            /** Pixels per side (the model's input is 1024). */
            size: z.number().int().min(64).max(1024),
            /** Project CRS easting of the crop's left edge and northing of its top edge. */
            x0: z.number(),
            y1: z.number(),
            /** Ground size of one pixel, project CRS units. */
            res: z.number().positive(),
            /** `size` x `size` x 3 bytes, row 0 north. */
            rgb: z.instanceof(Uint8Array).optional(),
          })
          .strict(),
        /**
         * Further clicks on the same crop that steer the outline: `include` true adds what is
         * under the click to the object (**Add area**), false takes it away (**Remove area**, a
         * touching pile the model took along). A click outside the crop is ignored.
         */
        refine: z
          .array(z.object({ at: SitePoint2, include: z.boolean() }).strict())
          .max(20)
          .optional(),
        /** Grow or shrink the outline, pixels (keys U and I). */
        bufferPx: z.number().int().min(-50).max(50).optional(),
        /** Target vertex count (keys J and K). */
        vertices: z.number().int().min(4).max(500).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        ring: z.array(SitePoint2),
        score: z.number().min(0).max(1),
        touchesEdge: z.boolean(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        /** The usual failure codes, or: `stale` (send the crop's pixels again), `unavailable` (no model), `nothing` (no outline here). */
        code: z.union([FailureCode, z.enum(['stale', 'unavailable', 'nothing'])]).optional(),
      }),
    ]),
  },
  /**
   * The open project's `orientation.json` (`aio.orientation/1`: video direction keyframes and
   * photo corrections set by hand): null when none was saved; `readOnly` for a package.
   */
  'orientation:read': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), file: OrientationFile.nullable(), readOnly: z.boolean() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Replace `orientation.json` atomically (journalled, a `.bak` of the previous file). */
  'orientation:write': {
    request: z.object({ projectId: z.string().min(1), file: OrientationFile }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * Settings, Processing tools: the pipeline pack in use, what it lacks for this app version and
   * the other pack folders in `<data folder>/runtime/`.
   */
  'pipelinePack:status': { request: Empty, response: PipelinePackStatus },
  /**
   * Look for a pack archive for this computer (`pipeline-pack-<version>-<platform>.tar.gz`) beside
   * the app, in Downloads and in `runtime`: file names and the archive's manifest only. `offer` is
   * the newest one worth installing (newer than the pack in use), `startDir` where the file dialog
   * of `pipelinePack:choose` opens.
   */
  'pipelinePack:find': {
    request: Empty,
    response: z.object({ offer: PackArchive.nullable(), startDir: z.string().nullable() }),
  },
  /** Pick a pack archive (`.tar.gz`) with the native dialog, opened where one is most likely. */
  'pipelinePack:choose': { request: Empty, response: z.object({ path: z.string().nullable() }) },
  /**
   * Install a pack archive into `<data folder>/runtime/`: unpacked into a temporary folder there,
   * checked (paths, links, size, manifest, platform, app range, Python, every file's SHA-256), then
   * renamed into place. Nothing changes on a failure or a cancel. A version already installed
   * answers `exists` until the request says `replace`. Progress: `pipelinePack:progress`.
   */
  'pipelinePack:install': {
    request: z
      .object({ path: z.string().min(1).max(2048), replace: z.boolean().optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), version: z.string(), status: PipelinePackStatus }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        /** `exists`: that version is installed (ask, then send `replace`); `busy`: an install is running. */
        code: z.enum(['exists', 'cancelled', 'busy']).optional(),
        version: z.string().optional(),
      }),
    ]),
  },
  /** Stop the running install; its temporary folder is removed. */
  'pipelinePack:cancel': { request: Empty, response: z.object({ ok: z.boolean() }) },
  /** Move a pack folder that is not in use (`InstalledPack.name`) to the bin (Recycle Bin, Trash). */
  'pipelinePack:remove': {
    request: z
      .object({ name: z.string().regex(/^pipeline-pack-[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), status: PipelinePackStatus }),
      Failure,
    ]),
  },

  // ---------------------------------------------------------------- ODM engine (Settings, Processing tools)
  /** What is installed: the pinned ODM, another ODM on this computer, the GPU line (ADR 0012). */
  'odm:status': { request: Empty, response: OdmStatus },
  /**
   * Download, verify and install the pinned ODM per user. `replaceOther` lets ODM's setup replace
   * another ODM it finds. Progress: `odm:progress`.
   */
  'odm:install': {
    request: z.object({ replaceOther: z.boolean().optional() }).strict(),
    response: OdmInstallResult,
  },
  /** Stop the running install; a partial download is kept for the next try. */
  'odm:cancel': { request: Empty, response: z.object({ ok: z.boolean() }) },
  /** Uninstall the ODM this app installed. */
  'odm:remove': { request: Empty, response: OdmInstallResult },
  /** Write `settings.processing.odm.gpu`. */
  'odm:setGpu': { request: z.object({ gpu: OdmGpuSetting }).strict(), response: OdmInstallResult },

  // ---------------------------------------------------------------- 360 video (walks, W1 front)
  /**
   * The 360 videos of an open project or package: every `walks/<id>/walk.json` that reads, newest
   * first. Read only; a project without the folder answers with an empty list. `processed` maps a
   * walk id to the summary of its `process.json` (`walk.process`), for walks that have one.
   */
  'walks:list': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({
      walks: z.array(WalkFile),
      processed: z.record(z.string(), WalkProcessSummary).optional(),
    }),
  },
  /**
   * Remove a walk from the project: its layer leaves the manifest and its folder `walks/<id>/`
   * moves to `.trash/` (kept seven days). Answers with the saved manifest.
   */
  'walks:remove': {
    request: z.object({ projectId: z.string().min(1), layerId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Cancel the `builder:import` running for a project, as a whole: a 360 video being stitched is
   * stopped and removed, files whose turn had not come are answered as skipped, and what was
   * already imported is saved. `builder:import` itself then answers with the rows. `ok` is false
   * when no import is running for the project.
   */
  'builder:cancelImport': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
  // ---------------------------------------------------------------- drone panoramas (P1)
  /**
   * Read the JPEGs under `paths` (folders recursively) and group them into drone spheres, wide
   * panoramas and ready-made panoramas; everything else is listed with its reason. Progress
   * arrives as `panos:progress` (`phase: 'scan'`). Main keeps the result for `panos:import`.
   */
  'panos:scan': {
    request: z
      .object({
        projectId: z.string().min(1),
        paths: z.array(z.string().min(1).max(2048)).min(1).max(20_000),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), scan: PanoScan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Import the chosen spheres and ready-made panoramas of a scan as one `panoramas` layer: frames
   * copied (progress `phase: 'copy'`), the layer saved with every sphere queued, one `pano.stitch`
   * job started per sphere. `notStarted` says why no job started (no or an old pipeline pack).
   */
  'panos:import': {
    request: z
      .object({
        projectId: z.string().min(1),
        scanId: z.string().min(1).max(64),
        keys: z.array(z.string().min(1).max(40)).min(1).max(1000),
        layerName: z.string().min(1).max(120),
        date: IsoDate.optional(),
        quality: PanoQuality,
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        layerId: z.string().min(1),
        started: z.number().int().nonnegative(),
        notStarted: z.string().optional(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        code: z.enum(['space', 'cancelled', 'stale-scan']).optional(),
      }),
    ]),
  },
  /** Stop the copy of a running `panos:import`; what it copied is removed. */
  'panos:cancelImport': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

/** Events pushed from main to the renderer. */
export const ipcEvents = {
  'jobs:event': JobEvent,
  'ai:event': z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), runId: z.string(), delta: z.string() }),
    z.object({
      type: z.literal('tool-call'),
      runId: z.string(),
      callId: z.string(),
      name: z.string(),
      input: z.unknown(),
      risk: ToolRisk,
    }),
    z.object({
      type: z.literal('usage'),
      runId: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
    }),
    z.object({ type: z.literal('done'), runId: z.string() }),
    z.object({
      type: z.literal('error'),
      runId: z.string(),
      message: z.string(),
      /** A provider error the agent panel offers a fix for in place (see AiErrorCode). */
      code: AiErrorCode.optional(),
    }),
  ]),
  'package:progress': z.object({
    jobId: z.string(),
    bytesDone: z.number().nonnegative(),
    bytesTotal: z.number().nonnegative(),
    filesDone: z.number().int().nonnegative(),
    filesTotal: z.number().int().nonnegative(),
    current: z.string().optional(),
  }),
  /** Help, Report a problem (app menu): open the Report a problem dialog. */
  'app:reportProblem': z.object({}).strict(),
  /** A second launch (double-clicked `.aio`) handed its path to this instance. */
  'app:openPath': z.object({ path: z.string().min(1) }),
  /** An application menu item the renderer carries out (Settings…, Search Commands…, User guide, Export diagnostics…). */
  'app:menu': z.object({
    action: z.enum(['settings', 'palette', 'guide', 'exportDiagnostics']),
  }),
  /** Download progress of `update:downloadAndInstall`. */
  'websiteUpdate:status': WebsiteUpdateStatus,
  'update:progress': z.object({
    received: z.number().nonnegative(),
    total: z.number().nonnegative(),
    phase: z.enum(['download', 'verify', 'keep', 'install']),
  }),
  /** Progress of an `export:run` job; `phase` is a short sentence for the toast. */
  'export:progress': z.object({
    jobId: z.string(),
    phase: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /** A pack download job changed (progress, state). */
  'packs:job': PackJob,
  'builder:progress': z.object({
    projectId: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    file: z.string(),
    /** 0 to 1 inside the file being imported, for one long file (a 360 video playback copy). */
    part: z.number().min(0).max(1).optional(),
  }),
  /** Progress of `panos:scan` and of the frame copy of `panos:import`. */
  'panos:progress': z.object({
    projectId: z.string(),
    phase: z.enum(['scan', 'copy']),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    file: z.string(),
  }),
  /** Progress of a `change:compute` run (M8). */
  'change:progress': z.object({
    jobId: z.string(),
    phase: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /** Progress of an `inference:run` (M8): items done, detections found so far. */
  'inference:progress': z.object({
    runId: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    found: z.number().int().nonnegative(),
    current: z.string().optional(),
    /** Items so far that could not be read, and why the first one could not. */
    skipped: z.number().int().nonnegative().optional(),
    reason: z.string().max(2000).optional(),
  }),
  /**
   * M9: records of an open project changed under the renderer (merge, import, external edit): reload
   * their projections, keeping selection and camera.
   */
  'journal:changed': z.object({
    projectId: z.string(),
    records: z.array(RecordRef),
  }),
  /** Progress of a hub or server sync (M9). */
  'sync:progress': z.object({
    projectId: z.string(),
    phase: z.enum(['pull', 'merge', 'push', 'blobs', 'done', 'offline']),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /** Progress of an exchange file export or import (M9). */
  'exchange:progress': z.object({
    jobId: z.string(),
    phase: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /** Progress of a blob fetch or index job (M9), bytes. */
  'blobs:progress': z.object({
    jobId: z.string(),
    projectId: z.string(),
    layer: z.string().optional(),
    done: z.number().nonnegative(),
    total: z.number().nonnegative(),
    state: z.enum(['running', 'done', 'failed', 'cancelled']),
    /** M9 integration: why a fetch failed, in a sentence. */
    error: z.string().optional(),
  }),
  /**
   * M9 integration: notices after a sync or import: a device whose clock is ahead (5 minutes: a
   * notice; 24 hours: its ops wait in quarantine), and issue codes renumbered because two copies
   * made the same code apart.
   */
  'sync:notice': z.object({
    projectId: z.string(),
    notices: z.array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('clock-ahead'),
          device: DeviceId,
          actor: ActorId,
          name: z.string().optional(),
          aheadMs: z.number().nonnegative(),
          level: z.enum(['notice', 'hold']),
        }),
        z.object({
          kind: z.literal('recode'),
          issue: z.string(),
          from: z.string(),
          to: z.string(),
          /** Packages already delivered with the old code (so the person can reissue). */
          delivered: z.array(z.string()).optional(),
        }),
      ]),
    ),
  }),
  /** Progress of `pipelinePack:install` (Settings, Processing tools). */
  'pipelinePack:progress': PackInstallProgress,
  /** Progress of `odm:install` (Settings, Processing tools). */
  'odm:progress': OdmInstallProgress,
} as const satisfies Record<string, z.ZodType>;

export type IpcChannel = keyof typeof ipc;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipc)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipc)[C]['response']>;
export type IpcEventName = keyof typeof ipcEvents;
export type IpcEvent<E extends IpcEventName> = z.output<(typeof ipcEvents)[E]>;
export type LibraryEntry = z.infer<typeof LibraryEntry>;
export type SetupStatus = z.infer<typeof SetupStatus>;
export type Settings = z.infer<typeof Settings>;
export type MapPackInfo = z.infer<typeof MapPackInfo>;
export type CrashNotice = z.infer<typeof CrashNotice>;
export type PackRegion = z.infer<typeof PackRegion>;
export type PackJob = z.infer<typeof PackJob>;
export type LicenseEntry = z.infer<typeof LicenseEntry>;
export type ThemeSetting = Settings['theme'];
export type ChatMessage = z.infer<typeof ChatMessage>;
export type LocalModelSettings = z.infer<typeof LocalModelSettings>;
export type LocalModelInfo = z.infer<typeof LocalModelInfo>;
export type FailureCode = z.infer<typeof FailureCode>;
export type ProviderUsage = z.infer<typeof ProviderUsage>;
export type ProjectUsage = z.infer<typeof ProjectUsage>;
export type PackagePlan = z.infer<typeof PackagePlan>;
export type PackageExportOptions = z.infer<typeof PackageExportOptions>;
export type PackageMapPackRequest = z.infer<typeof PackageMapPackRequest>;
export type RasterPackRef = z.infer<typeof RasterPackRef>;
export type PackageRasterPlan = z.infer<typeof PackageRasterPlan>;
export type ExportFormat = z.infer<typeof ExportFormat>;
export type ReportFile = z.infer<typeof ReportFile>;
export type ReportBrandingSettings = z.infer<typeof ReportBrandingSettings>;
export type TeamSettings = z.infer<typeof TeamSettings>;

/** The typed bridge the preload exposes as window.aio. */
export interface AioBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvent<E>) => void): () => void;
  /**
   * Absolute path of a file dropped on the window (Electron `webUtils.getPathForFile`), or an
   * empty string for files that do not come from disk. Optional: absent outside Electron.
   */
  pathForFile?(file: File): string;
  /**
   * Installed and free system memory, bytes (graphics tier detection, diagnostics). Synchronous;
   * null where unknown. Optional: absent outside Electron.
   */
  systemMemory?(): { total: number; free: number } | null;
  /** This renderer process's memory, bytes (diagnostics, the memory watch). */
  processMemory?(): Promise<{ residentSet: number; private: number } | null>;
  /**
   * Whether this run may show the launch screen, read before the first frame: `skip` for an
   * automated run (QUADRION_E2E=1 without QUADRION_SHOW_GATE=1, or QUADRION_SHOW_GATE=0), else
   * `auto` (then `Settings.launchScreen` decides). Optional: absent outside Electron means `auto`.
   */
  launchGate?(): LaunchGateMode;
  /**
   * Switches for this run, read before the first frame. `autoFold`: the left sidebar may fold to
   * its rail on its own in a narrow window; false when main started the window with
   * `--quadrion-autofold=0` (an e2e run, unless QUADRION_E2E_AUTOFOLD=1). Optional: absent outside
   * Electron means false.
   */
  flags?: { autoFold: boolean };
}

/** See `AioBridge.launchGate`. */
export type LaunchGateMode = 'auto' | 'skip';
