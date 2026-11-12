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
 * Whether outside agents may read the open project. `cloud`: served, as a cloud provider would
 * be (cloud AI on, not offline-only, the policy allows). `allowed`: served, the person allowed
 * outside apps for this project. `policy`: never, the package or manifest forbids cloud AI.
 * `cloud-off`: not served, cloud AI is off or offline-only is on and the project is not allowed.
 */
export const McpProjectAccess = z.enum(['cloud', 'allowed', 'policy', 'cloud-off']);
export type McpProjectAccess = z.infer<typeof McpProjectAccess>;

export const McpStatus = z.object({
  /** The switch (off by default). */
  enabled: z.boolean(),
  /** Listening now. */
  running: z.boolean(),
  /** `http://127.0.0.1:<port>/mcp` while running. */
  url: z.string().nullable(),
  /** The bearer token, once the server was first switched on. */
  token: z.string().nullable(),
  /** Why the server could not start. */
  error: z.string().optional(),
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
