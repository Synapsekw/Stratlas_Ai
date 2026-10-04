import { z } from 'zod';
import { AiProvider, AiTask, ToolRisk, WindowKind } from './agent';
import { Issue } from './annotation';
import {
  ImportItem,
  LayerPatch,
  NewProjectRequest,
  ReportBrand,
  SeverityTemplate,
} from './builder';
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
        alt: z.number().optional(),
        takenAt: z.string().optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
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
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, items: z.array(ImportItem) }),
      z.object({ ok: z.literal(false), error: z.string(), items: z.array(ImportItem).optional() }),
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
export type ChatMessage = z.infer<typeof ChatMessage>;

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
