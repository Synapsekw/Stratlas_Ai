import { z } from 'zod';
import { AiProvider, AiTask, ToolRisk, WindowKind } from './agent';
import { Issue } from './annotation';
import { Conversation, ConversationId, ConversationSummary } from './conversation';
import { ProjectManifest } from './manifest';
import { AiPolicy, ExportKind, PackageInfo } from './package';

const Empty = z.object({}).strict();

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

export const Settings = z.object({
  cloudAi: z.boolean(),
  theme: z.enum(['dark', 'light']),
  sidebarCollapsed: z.boolean(),
  /** Folder that holds projects and map packs, e.g. E:\Stratlas Data. */
  dataRoot: z.string(),
  routes: z.array(ModelRouteSchema),
  /** Optional so settings written before the local provider existed stay valid. */
  localModel: LocalModelSettings.optional(),
});

export const MapPackInfo = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  maxZoom: z.number().int(),
  sizeBytes: z.number().int().nonnegative(),
});

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
});

export const PackageExportOptions = z
  .object({
    projectId: z.string().min(1),
    /** Layer ids to leave out. */
    exclude: z.array(z.string()),
    readOnly: z.boolean(),
    aiPolicy: AiPolicy,
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

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

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
  'packs:list': { request: Empty, response: z.array(MapPackInfo) },
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
    request: z.object({ projectId: z.string().min(1).optional() }).strict(),
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
  /** Pick a file (a `.aio` package) with the native dialog. */
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
    request: z.object({ projectId: z.string().min(1), exclude: z.array(z.string()) }).strict(),
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
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

/** Events pushed from main to the renderer. */
export const ipcEvents = {
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
    z.object({ type: z.literal('error'), runId: z.string(), message: z.string() }),
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
} as const satisfies Record<string, z.ZodType>;

export type IpcChannel = keyof typeof ipc;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipc)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipc)[C]['response']>;
export type IpcEventName = keyof typeof ipcEvents;
export type IpcEvent<E extends IpcEventName> = z.output<(typeof ipcEvents)[E]>;
export type LibraryEntry = z.infer<typeof LibraryEntry>;
export type Settings = z.infer<typeof Settings>;
export type MapPackInfo = z.infer<typeof MapPackInfo>;
export type ChatMessage = z.infer<typeof ChatMessage>;
export type LocalModelSettings = z.infer<typeof LocalModelSettings>;
export type ProviderUsage = z.infer<typeof ProviderUsage>;
export type ProjectUsage = z.infer<typeof ProjectUsage>;
export type PackagePlan = z.infer<typeof PackagePlan>;
export type PackageExportOptions = z.infer<typeof PackageExportOptions>;

/** The typed bridge the preload exposes as window.aio. */
export interface AioBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvent<E>) => void): () => void;
}
