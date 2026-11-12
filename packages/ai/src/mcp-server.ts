/**
 * The local MCP server (intelligence review Wave 3, X1), main process only. Streamable HTTP on
 * 127.0.0.1 and nowhere else: every request needs the bearer token, a Host header naming the
 * loopback address and port, and no browser Origin. Each client session gets its own MCP server
 * whose `tools/list` is `mcpToolList()` (the agent's read tools, mcp-tools.ts) and whose
 * `tools/call` validates the input against the agent spec and hands it to the host (`call`), which
 * runs the agent's own executor in the renderer. The host decides whether the open project may be
 * read; this module knows nothing about projects.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mcpToolList, parseMcpInput } from './mcp-tools';

export { mcpToolList } from './mcp-tools';

/** The only address the server ever listens on. */
export const MCP_HOST = '127.0.0.1';
export const MCP_PATH = '/mcp';
const MAX_BODY = 1024 * 1024;

/** A fresh token: 32 random bytes, base64url. */
export function newMcpToken(): string {
  return randomBytes(32).toString('base64url');
}

export type McpCallOutcome = { ok: true; text: string } | { ok: false; error: string };

export interface McpClient {
  /** The MCP session id. */
  id: string;
  name: string;
  version?: string;
  connectedAt: string;
  lastSeenAt: string;
  calls: number;
}

export interface McpHttpServerOptions {
  /**
   * The port to listen on; absent: any free port. A taken port fails the start with
   * `McpPortInUseError` (the host asks the person before moving: a pasted setup names it).
   */
  port?: number;
  token: string;
  serverInfo: { name: string; version: string };
  /** Shown to the client at initialize. */
  instructions?: string;
  /** Run one validated read tool call. */
  call(name: string, input: unknown): Promise<McpCallOutcome>;
  /** A client connected, called, or went away. */
  onChange?(): void;
  now?(): Date;
  /** Sessions kept at most; a new one ends the least recently seen (default 16). */
  maxSessions?: number;
  /** A session unseen this long is ended (default 30 minutes): many clients never say goodbye. */
  idleMs?: number;
  /** Tool calls running at once, across all sessions (default 4); more are refused as busy. */
  maxInFlight?: number;
}

/** The kept port is taken by another program. */
export class McpPortInUseError extends Error {
  override name = 'McpPortInUseError';
  constructor(readonly port: number) {
    super(`Port ${String(port)} is in use by another program.`);
  }
}

export const MCP_BUSY = 'The app is busy with other calls. Try again in a moment.';

export interface McpHttpServer {
  readonly port: number;
  readonly url: string;
  clients(): McpClient[];
  /** End one client's session; it must initialize again. False when there is none. */
  disconnect(id: string): Promise<boolean>;
  /** Use another token from now on and end every session. */
  setToken(token: string): Promise<void>;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  client: McpClient;
}

/** Constant time compare of the Authorization header with the token. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim());
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, message: string, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, MCP_HOST);
  });
}

export async function startMcpHttpServer(opts: McpHttpServerOptions): Promise<McpHttpServer> {
  const now = () => (opts.now ? opts.now() : new Date());
  let token = opts.token;
  const sessions = new Map<string, Session>();
  let port = 0;
  const changed = () => opts.onChange?.();
  let inFlight = 0;

  function mcpFor(client: McpClient): McpServer {
    const mcp = new McpServer(opts.serverInfo, {
      capabilities: { tools: { listChanged: false } },
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    });
    const low = mcp.server;
    low.oninitialized = () => {
      const info = low.getClientVersion();
      if (info) {
        client.name = info.name;
        client.version = info.version;
      }
      changed();
    };
    low.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpToolList() }));
    low.setRequestHandler(CallToolRequestSchema, async (req) => {
      client.calls += 1;
      client.lastSeenAt = now().toISOString();
      changed();
      const parsed = parseMcpInput(req.params.name, req.params.arguments);
      let outcome: McpCallOutcome;
      if (!parsed.ok) outcome = parsed;
      else if (inFlight >= (opts.maxInFlight ?? 4)) outcome = { ok: false, error: MCP_BUSY };
      else {
        inFlight += 1;
        try {
          outcome = await opts
            .call(req.params.name, parsed.input)
            .catch((e: unknown): McpCallOutcome => ({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            }));
        } finally {
          inFlight -= 1;
        }
      }
      return outcome.ok
        ? { content: [{ type: 'text' as const, text: outcome.text }] }
        : { content: [{ type: 'text' as const, text: outcome.error }], isError: true };
    });
    return mcp;
  }

  async function open(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const at = now().toISOString();
    const client: McpClient = {
      id: '',
      name: 'Unknown client',
      connectedAt: at,
      lastSeenAt: at,
      calls: 0,
    };
    const hosts = [`${MCP_HOST}:${port}`, `localhost:${port}`];
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      onsessioninitialized: (id) => {
        client.id = id;
        const oldest = [...sessions.values()].sort((a, b) =>
          a.client.lastSeenAt.localeCompare(b.client.lastSeenAt),
        );
        const over = sessions.size + 1 - (opts.maxSessions ?? 16);
        for (const s of oldest.slice(0, Math.max(0, over))) void end(s);
        sessions.set(id, { transport, server, client });
      },
    });
    const server = mcpFor(client);
    transport.onclose = () => {
      if (client.id && sessions.delete(client.id)) changed();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${MCP_HOST}`);
    if (url.pathname !== MCP_PATH) {
      send(res, 404, 'Not found.');
      return;
    }
    // a web page may reach a loopback port; it always sends an Origin, MCP clients never do
    if (req.headers.origin !== undefined) {
      send(res, 403, 'Browsers may not call this server.');
      return;
    }
    const host = req.headers.host ?? '';
    if (host !== `${MCP_HOST}:${port}` && host !== `localhost:${port}`) {
      send(res, 403, 'Wrong host.');
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      send(res, 401, 'Missing or wrong token.', { 'www-authenticate': 'Bearer' });
      return;
    }

    const sid = req.headers['mcp-session-id'];
    const id = Array.isArray(sid) ? sid[0] : sid;
    if (id !== undefined) {
      const s = sessions.get(id);
      if (!s) {
        send(res, 404, 'Session not found: initialize again.');
        return;
      }
      s.client.lastSeenAt = now().toISOString();
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST') {
      send(res, 400, 'Initialize first.');
      return;
    }
    const body = await readBody(req);
    if (!isInitializeRequest(body)) {
      send(res, 400, 'Initialize first.');
      return;
    }
    await open(req, res, body);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 400, e instanceof Error ? e.message : 'Bad request.');
      else res.end();
    });
  });
  try {
    port = await listen(http, opts.port ?? 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && opts.port)
      throw new McpPortInUseError(opts.port);
    throw e;
  }

  async function end(s: Session): Promise<void> {
    sessions.delete(s.client.id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  }

  const idleMs = opts.idleMs ?? 30 * 60_000;
  const sweep = setInterval(
    () => {
      const cutoff = now().getTime() - idleMs;
      const idle = [...sessions.values()].filter((s) => Date.parse(s.client.lastSeenAt) < cutoff);
      if (idle.length) void Promise.all(idle.map(end)).then(changed);
    },
    Math.min(60_000, idleMs),
  );
  sweep.unref();

  return {
    get port() {
      return port;
    },
    get url() {
      return `http://${MCP_HOST}:${port}${MCP_PATH}`;
    },
    clients: () => [...sessions.values()].map((s) => ({ ...s.client })),
    async disconnect(id) {
      const s = sessions.get(id);
      if (!s) return false;
      await end(s);
      changed();
      return true;
    },
    async setToken(next) {
      token = next;
      await Promise.all([...sessions.values()].map(end));
      changed();
    },
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(end));
      http.closeAllConnections();
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
    },
  };
}
