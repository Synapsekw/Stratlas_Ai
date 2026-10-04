import { z } from 'zod';
import { AiProvider, AiTask, ToolRisk, WindowKind } from './agent';
import { Issue } from './annotation';
import { JobEvent, JobId, JobLogLine, JobRecord, JobStartRequest, RuntimeInfo } from './jobs';
import { ProjectManifest } from './manifest';

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
});

export const Settings = z.object({
  cloudAi: z.boolean(),
  theme: z.enum(['dark', 'light']),
  sidebarCollapsed: z.boolean(),
  /** Folder that holds projects and map packs, e.g. E:\Stratlas Data. */
  dataRoot: z.string(),
  routes: z.array(z.object({ task: AiTask, provider: AiProvider, model: z.string().min(1) })),
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
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

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
  'project:open': { request: z.object({ path: z.string().min(1) }).strict(), response: OpenResult },
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
    }),
    z.object({ type: z.literal('done'), runId: z.string() }),
    z.object({ type: z.literal('error'), runId: z.string(), message: z.string() }),
  ]),
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

/** The typed bridge the preload exposes as window.aio. */
export interface AioBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvent<E>) => void): () => void;
}
