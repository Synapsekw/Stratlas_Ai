/**
 * The local MCP server (intelligence review Wave 3, X1): what Settings shows of it and what the
 * renderer runs for it. The server lives in main (`@aio/ai/mcp`), listens on 127.0.0.1 only and
 * offers the agent's read tools; its settings stay on this computer (`userData/mcp.json`).
 */
import { z } from 'zod';

/** One outside agent with an open session: its name and version from MCP `initialize`. */
export const McpClientInfo = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.string().optional(),
  connectedAt: z.string(),
  lastSeenAt: z.string(),
  calls: z.number().int().nonnegative(),
});
export type McpClientInfo = z.infer<typeof McpClientInfo>;

/**
 * Whether outside agents may read the open project. `allowed`: served, the person let outside
 * apps read this project. `not-allowed`: not served until they do (the default). `policy`: never,
 * the package or manifest forbids cloud AI. `offline`: not served, offline-only is on (outside
 * apps usually pass what they read to a cloud model).
 */
export const McpProjectAccess = z.enum(['allowed', 'not-allowed', 'policy', 'offline']);
export type McpProjectAccess = z.infer<typeof McpProjectAccess>;

export const McpStatus = z.object({
  /** The switch (off by default). */
  enabled: z.boolean(),
  /** Listening now. */
  running: z.boolean(),
  /** `http://127.0.0.1:<port>/mcp` while running. */
  url: z.string().nullable(),
  /** A token exists; the token itself only comes through `mcp:revealToken`. */
  hasToken: z.boolean(),
  /** Why the server could not start. */
  error: z.string().optional(),
  /** The kept port is taken by another program: "Use a new port" (`mcp:newPort`) moves it. */
  portInUse: z.boolean().optional(),
  /** Offline-only is on: every call is refused. */
  offlineOnly: z.boolean(),
  clients: z.array(McpClientInfo),
  /** How many tools outside agents get. */
  tools: z.number().int().nonnegative(),
  /** The open project and whether it is served; null without one. */
  project: z
    .object({
      id: z.string().min(1),
      name: z.string(),
      allowed: z.boolean(),
      access: McpProjectAccess,
    })
    .nullable(),
});
export type McpStatus = z.infer<typeof McpStatus>;

/** Main asks the renderer to run one validated read tool for an outside agent. */
export const McpCall = z.object({
  callId: z.string().min(1),
  /** The project main checked; the renderer refuses when another one is open. */
  projectId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export type McpCall = z.infer<typeof McpCall>;

/** The renderer's answer to `mcp:call`: the tool result as JSON text, or why it failed. */
export const McpCallResult = z.discriminatedUnion('ok', [
  z.object({ callId: z.string().min(1), ok: z.literal(true), text: z.string() }).strict(),
  z.object({ callId: z.string().min(1), ok: z.literal(false), error: z.string() }).strict(),
]);
export type McpCallResult = z.infer<typeof McpCallResult>;
