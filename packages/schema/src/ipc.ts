import { z } from 'zod';
import { AiErrorCode, AiProvider, AiTask, ToolRisk, WindowKind } from './agent';
import { Issue } from './annotation';
import { Conversation, ConversationId, ConversationSummary } from './conversation';
import { JobEvent, JobId, JobLogLine, JobRecord, JobStartRequest, RuntimeInfo } from './jobs';
import {
  AltitudeChoice,
  AltitudePlan,
  ImportHeights,
  ImportItem,
  LayerPatch,
  NewProjectRequest,
  ReportBrand,
  SeverityTemplate,
} from './builder';
import { ProjectManifest } from './manifest';
import { HexColor } from './common';
import { AiPolicy, EditPolicy, ExportKind, PackageInfo, PackageOrigin } from './package';
import { BoundaryEditsFile, VolumesFile } from './volumes';
import { DetectionsFile } from './detections';
import { NarrativeFile, ReportContentsSettings } from './report';

const Empty = z.object({}).strict();

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
});

/** An OpenAI-compatible model server on this machine (for example Ollama). Off by default. */
export const LocalModelSettings = z.object({
  enabled: z.boolean(),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().min(1).max(200),
});

export const ModelRouteSchema = z.object({
  task: AiTask,
  provider: AiProvider,
  model: z.string().min(1),
});

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
  /**
   * Offline-only workstation: every online action (map pack download, update check) is disabled.
   * Default false; the app still makes no request unless the person starts one.
   */
  offlineOnly: z.boolean().optional(),
  /** Allow the "Check for updates" button (electron-updater, generic provider). Default false. */
  updateCheck: z.boolean().optional(),
  /** Base URL of the update feed (`latest.yml` lives there). Empty when not set. */
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
  'library:add': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), entry: LibraryEntry }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  'project:open': {
    request: z
      .object({ path: z.string().min(1), passphrase: z.string().min(1).max(256).optional() })
      .strict(),
    response: OpenResult,
  },
  'project:writeIssues': {
    request: z.object({ projectId: z.string().min(1), issues: z.array(Issue) }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
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
        .enum(['cloud-off', 'no-key', 'forbidden', 'no-provider', 'no-route', 'local-off'])
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
   * Ask where to save a file with the native dialog, then write it. Used by the legacy viewer
   * host for `window.claude.use('downloads')`. `path` is null when the person cancels; `error`
   * says why a chosen file could not be written.
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
  /** Check an installer file: valid signature and a newer version than this app. */
  'update:verifyFile': {
    request: z.object({ path: z.string().min(1) }).strict(),
    response: VerifyResult,
  },
  /** Verify again, run the installer and quit. */
  'update:installFile': { request: z.object({ path: z.string().min(1) }).strict(), response: Ok },
  /** Optional online check (electron-updater, generic provider); refused when offline-only. */
  'update:check': {
    request: Empty,
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), available: z.boolean(), version: z.string().optional() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Download the update found by `update:check`, then quit and install it. */
  'update:downloadAndInstall': { request: Empty, response: Ok },
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
        paths: z.array(z.string().min(1)).min(1),
        /** The aircraft clock's offset from UTC in minutes; default from the project longitude. */
        utcOffsetMin: z.number().int().min(-720).max(840).optional(),
        /** How camera heights are made (data-conventions section 3a); default `auto`. */
        altitude: AltitudeChoice.optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        items: z.array(ImportItem),
        /** The height rule applied, when any file got a camera height. */
        heights: ImportHeights.optional(),
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
      .object({ projectId: z.string().min(1), paths: z.array(z.string().min(1)).min(1) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), plan: AltitudePlan }),
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
  /** A second launch (double-clicked `.aio`) handed its path to this instance. */
  'app:openPath': z.object({ path: z.string().min(1) }),
  /** An application menu item the renderer carries out (macOS Settings…, Search Commands…). */
  'app:menu': z.object({ action: z.enum(['settings', 'palette']) }),
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
  }),
} as const satisfies Record<string, z.ZodType>;

export type IpcChannel = keyof typeof ipc;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipc)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipc)[C]['response']>;
export type IpcEventName = keyof typeof ipcEvents;
export type IpcEvent<E extends IpcEventName> = z.output<(typeof ipcEvents)[E]>;
export type LibraryEntry = z.infer<typeof LibraryEntry>;
export type Settings = z.infer<typeof Settings>;
export type MapPackInfo = z.infer<typeof MapPackInfo>;
export type PackRegion = z.infer<typeof PackRegion>;
export type PackJob = z.infer<typeof PackJob>;
export type LicenseEntry = z.infer<typeof LicenseEntry>;
export type ThemeSetting = Settings['theme'];
export type ChatMessage = z.infer<typeof ChatMessage>;
export type LocalModelSettings = z.infer<typeof LocalModelSettings>;
export type ProviderUsage = z.infer<typeof ProviderUsage>;
export type ProjectUsage = z.infer<typeof ProjectUsage>;
export type PackagePlan = z.infer<typeof PackagePlan>;
export type PackageExportOptions = z.infer<typeof PackageExportOptions>;
export type PackageMapPackRequest = z.infer<typeof PackageMapPackRequest>;
export type ExportFormat = z.infer<typeof ExportFormat>;
export type ReportFile = z.infer<typeof ReportFile>;
export type ReportBrandingSettings = z.infer<typeof ReportBrandingSettings>;

/** The typed bridge the preload exposes as window.aio. */
export interface AioBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvent<E>) => void): () => void;
  /**
   * Absolute path of a file dropped on the window (Electron `webUtils.getPathForFile`), or an
   * empty string for files that do not come from disk. Optional: absent outside Electron.
   */
  pathForFile?(file: File): string;
}
