import { z } from 'zod';
import { AiProvider, AiTask } from './agent';
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
  thumbnail: z.string().optional(),
});

export const Settings = z.object({
  cloudAi: z.boolean(),
  theme: z.enum(['dark', 'light']),
  sidebarCollapsed: z.boolean(),
  routes: z.array(z.object({ task: AiTask, provider: AiProvider, model: z.string().min(1) })),
});

const OpenResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), root: z.string(), manifest: ProjectManifest }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** The single list of channels between renderer and main. Main validates every request. */
export const ipc = {
  'app:getInfo': {
    request: Empty,
    response: z.object({ name: z.string(), version: z.string(), platform: z.string() }),
  },
  'library:list': { request: Empty, response: z.array(LibraryEntry) },
  'project:open': { request: z.object({ path: z.string().min(1) }).strict(), response: OpenResult },
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
  'dialog:openFolder': {
    request: z.object({ title: z.string().optional() }).strict(),
    response: z.object({ path: z.string().nullable() }),
  },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type IpcChannel = keyof typeof ipc;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipc)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipc)[C]['response']>;
export type LibraryEntry = z.infer<typeof LibraryEntry>;
export type Settings = z.infer<typeof Settings>;
