import { z } from 'zod';
import { AiProvider, AiTask, ToolRisk, WindowKind } from './agent';
import { Issue } from './annotation';
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

/** An http(s) URL, or empty for "not set". */
const OptionalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ })]);

export const Settings = z.object({
  cloudAi: z.boolean(),
  /** `system` follows the operating system's light or dark preference. */
  theme: z.enum(['dark', 'light', 'system']),
  sidebarCollapsed: z.boolean(),
  /** Folder that holds projects and map packs, e.g. E:\Stratlas Data. */
  dataRoot: z.string(),
  routes: z.array(z.object({ task: AiTask, provider: AiProvider, model: z.string().min(1) })),
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
  /** How the pack arrived: the in-app download, a file import, or tools/maps/build-packs.mjs. */
  source: z.enum(['download', 'import', 'build-tool']).optional(),
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
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

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
  'project:open': { request: z.object({ path: z.string().min(1) }).strict(), response: OpenResult },
  'project:writeIssues': {
    request: z.object({ projectId: z.string().min(1), issues: z.array(Issue) }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
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
  /** Pick one existing file with the native dialog. */
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
  /** A pack download job changed (progress, state). */
  'packs:job': PackJob,
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

/** The typed bridge the preload exposes as window.aio. */
export interface AioBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvent<E>) => void): () => void;
}
