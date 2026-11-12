/**
 * The local MCP server's host in main (intelligence review Wave 3, X1). It keeps the switch, the
 * token, the port and the per-project "let outside apps read this project" choices in
 * `userData/mcp.json` (this computer's profile, never the project folder), starts and stops the
 * 127.0.0.1 server (`@aio/ai/mcp`), decides whether the open project may be read, and has the
 * renderer run each read tool with the agent's own executor (`mcp:call`, answered by
 * `mcp:result`). Off by default.
 *
 * Privacy: an outside agent is treated like a cloud provider. The open project is served when a
 * cloud provider could read it (cloud AI on, offline-only off, the policy allows), or when the
 * person allowed outside apps for it. A package or manifest that forbids cloud AI is never served.
 */
import { mcpToolList, newMcpToken, startMcpHttpServer, type McpHttpServer } from '@aio/ai/mcp';
import type { McpCall, McpCallResult, McpProjectAccess, McpStatus } from '@aio/schema';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectKey } from './aiProjects';
import { readJson, writeJsonAtomic } from './fsutil';

const McpFile = z.object({
  schema: z.literal('aio.mcp/1'),
  enabled: z.boolean(),
  token: z.string().min(16).nullable(),
  port: z.number().int().min(0).max(65535).nullable(),
  /** Project folder keys (`projectKey`) whose owner allowed outside apps. */
  allowedProjects: z.array(z.string()),
});
type McpFile = z.infer<typeof McpFile>;

const BLANK: McpFile = {
  schema: 'aio.mcp/1',
  enabled: false,
  token: null,
  port: null,
  allowedProjects: [],
};

/** A renderer that does not answer in this time gets the call refused. */
export const MCP_CALL_TIMEOUT_MS = 30_000;

export interface McpOpenProject {
  id: string;
  name: string;
  root: string;
}

/** What decides whether the open project is served, besides the per-project choice. */
export interface McpGateInput {
  /** The package or manifest policy forbids cloud AI. */
  policyForbids: boolean;
  cloudAi: boolean;
  offlineOnly: boolean;
  allowed: boolean;
}

/** Served (`cloud`, `allowed`) or why not (`policy`, `cloud-off`). */
export function mcpAccess(g: McpGateInput): McpProjectAccess {
  if (g.policyForbids) return 'policy';
  if (g.allowed) return 'allowed';
  return g.cloudAi && !g.offlineOnly ? 'cloud' : 'cloud-off';
}

export const served = (a: McpProjectAccess) => a === 'cloud' || a === 'allowed';

/** What an outside agent reads when the project is not served, in words it can pass on. */
export const ACCESS_REFUSED: Record<'policy' | 'cloud-off', string> = {
  policy:
    'This project does not allow AI outside the app (its package or manifest forbids cloud AI).',
  'cloud-off':
    'This project is not shared with outside apps. In the app, open Settings > AI providers > Outside apps (MCP) and allow this project, or turn on cloud AI.',
};

export interface McpHostDeps {
  file: string;
  serverInfo: { name: string; version: string };
  /** The project open in the app window, or null. */
  openProject(): McpOpenProject | null;
  /** Everything but the per-project choice; read fresh for every call. */
  gate(project: McpOpenProject): Promise<Omit<McpGateInput, 'allowed'>>;
  /** Send `mcp:call` to the app window; false when there is no window. */
  send(call: McpCall): boolean;
  /** Tell the renderer the status changed. */
  emit(status: McpStatus): void;
  timeoutMs?: number;
  warn?(message: string): void;
}

export interface McpHost {
  status(): Promise<McpStatus>;
  /** Start the server if it was left on (app start). */
  start(): Promise<void>;
  setEnabled(enabled: boolean): Promise<McpStatus>;
  setProjectAllowed(projectId: string, allowed: boolean): Promise<McpStatus>;
  disconnect(clientId: string): Promise<McpStatus>;
  newToken(): Promise<McpStatus>;
  result(r: McpCallResult): boolean;
  /** The project changed: tell Settings. */
  projectChanged(): void;
  stop(): Promise<void>;
}

export function createMcpHost(deps: McpHostDeps): McpHost {
  const warn = (m: string) => {
    if (deps.warn) deps.warn(m);
    else console.warn(m);
  };
  let cache: McpFile | null = null;
  let server: McpHttpServer | null = null;
  let startError: string | undefined;
  let starting: Promise<void> | null = null;
  const pending = new Map<string, (r: McpCallResult) => void>();

  async function load(): Promise<McpFile> {
    if (cache) return cache;
    try {
      const r = McpFile.safeParse(await readJson(deps.file));
      cache = r.success ? r.data : { ...BLANK };
    } catch {
      cache = { ...BLANK };
    }
    return cache;
  }

  async function save(next: McpFile): Promise<void> {
    cache = next;
    await writeJsonAtomic(deps.file, next).catch((e: unknown) => {
      warn(`Could not save ${deps.file}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async function status(): Promise<McpStatus> {
    const f = await load();
    const p = deps.openProject();
    let project: McpStatus['project'] = null;
    if (p) {
      const allowed = f.allowedProjects.includes(projectKey(p.root));
      const g = await deps.gate(p).catch(() => ({
        policyForbids: true,
        cloudAi: false,
        offlineOnly: true,
      }));
      project = { id: p.id, name: p.name, allowed, access: mcpAccess({ ...g, allowed }) };
    }
    return {
      enabled: f.enabled,
      running: server !== null,
      url: server?.url ?? null,
      token: f.token,
      ...(startError ? { error: startError } : {}),
      clients: server?.clients() ?? [],
      tools: mcpToolList().length,
      project,
    };
  }

  const notify = () => {
    void status()
      .then((s) => {
        deps.emit(s);
      })
      .catch(() => undefined);
  };

  async function call(name: string, input: unknown) {
    const p = deps.openProject();
    if (!p)
      return {
        ok: false as const,
        error: 'No project is open in the app. Open one, then ask again.',
      };
    const f = await load();
    const allowed = f.allowedProjects.includes(projectKey(p.root));
    const access = mcpAccess({ ...(await deps.gate(p)), allowed });
    if (!served(access)) return { ok: false as const, error: ACCESS_REFUSED[access as 'policy'] };
    const callId = randomUUID();
    return new Promise<{ ok: true; text: string } | { ok: false; error: string }>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        resolve({ ok: false, error: 'The app did not answer in time.' });
      }, deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS);
      pending.set(callId, (r) => {
        clearTimeout(timer);
        pending.delete(callId);
        // another project opened meanwhile: its data must not go out under this one's gate
        if (deps.openProject()?.id !== p.id)
          resolve({
            ok: false,
            error: 'The project in the app changed during the call. Ask again.',
          });
        else resolve(r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error });
      });
      if (!deps.send({ callId, projectId: p.id, name, input })) {
        pending.get(callId)?.({ callId, ok: false, error: 'The app window is not open.' });
      }
    });
  }

  async function run(): Promise<void> {
    const f = await load();
    if (server || !f.enabled) return;
    const token = f.token ?? newMcpToken();
    try {
      server = await startMcpHttpServer({
        token,
        ...(f.port ? { port: f.port } : {}),
        serverInfo: deps.serverInfo,
        instructions:
          'Read-only access to the project open in the app: issues, measurements, volumes, survey dates, detections and the fact index (query_facts, history_of). Nothing here changes the project.',
        call,
        onChange: notify,
      });
      startError = undefined;
      // read again: the switch, the token or a project choice may have changed while starting
      const now = await load();
      if (!now.enabled) {
        const s = server;
        server = null;
        await s.close();
        return;
      }
      if (now.token === null || now.port !== server.port)
        await save({ ...now, token: now.token ?? token, port: server.port });
      if (now.token !== null && now.token !== token) await server.setToken(now.token);
    } catch (e) {
      startError = `The server could not start: ${e instanceof Error ? e.message : String(e)}`;
      warn(startError);
    }
  }

  async function ensure(): Promise<void> {
    starting ??= run().finally(() => {
      starting = null;
    });
    await starting;
  }

  async function halt(): Promise<void> {
    // a start under way finishes first, so the server it makes is closed too
    await starting?.catch(() => undefined);
    const s = server;
    server = null;
    for (const resolve of [...pending.values()])
      resolve({ callId: 'stopped', ok: false, error: 'The server was switched off.' });
    await s?.close();
  }

  return {
    status,
    async start() {
      await ensure();
      notify();
    },
    async setEnabled(enabled) {
      const f = await load();
      await save({ ...f, enabled });
      if (enabled) await ensure();
      else {
        startError = undefined;
        await halt();
      }
      const s = await status();
      deps.emit(s);
      return s;
    },
    async setProjectAllowed(projectId, allowed) {
      const p = deps.openProject();
      if (p?.id === projectId) {
        const f = await load();
        const key = projectKey(p.root);
        const rest = f.allowedProjects.filter((k) => k !== key);
        await save({ ...f, allowedProjects: allowed ? [...rest, key] : rest });
      }
      const s = await status();
      deps.emit(s);
      return s;
    },
    async disconnect(clientId) {
      await server?.disconnect(clientId);
      return status();
    },
    async newToken() {
      const f = await load();
      const token = newMcpToken();
      await save({ ...f, token });
      await server?.setToken(token);
      const s = await status();
      deps.emit(s);
      return s;
    },
    result(r) {
      const resolve = pending.get(r.callId);
      if (!resolve) return false;
      resolve(r);
      return true;
    },
    projectChanged: notify,
    stop: halt,
  };
}
