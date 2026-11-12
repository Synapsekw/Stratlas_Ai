import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_HOST,
  newMcpToken,
  startMcpHttpServer,
  tokenMatches,
  type McpHttpServer,
  type McpHttpServerOptions,
} from './mcp-server';

let server: McpHttpServer | null = null;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await server?.close();
  server = null;
});

async function start(over: Partial<McpHttpServerOptions> = {}) {
  const token = over.token ?? newMcpToken();
  const call = vi.fn<McpHttpServerOptions['call']>((name, input) =>
    Promise.resolve({ ok: true as const, text: JSON.stringify({ name, input }) }),
  );
  server = await startMcpHttpServer({
    token,
    serverInfo: { name: 'test', version: '1.0.0' },
    call,
    ...over,
  });
  return { token, call, server };
}

async function connect(url: string, token: string, name = 'test-client') {
  const client = new Client({ name, version: '2.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
});

function post(url: string, headers: Record<string, string>) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: initBody,
  });
}

describe('tokenMatches', () => {
  it('takes only the exact bearer token', () => {
    expect(tokenMatches('Bearer abc', 'abc')).toBe(true);
    expect(tokenMatches('Bearer abd', 'abc')).toBe(false);
    expect(tokenMatches('Bearer ab', 'abc')).toBe(false);
    expect(tokenMatches('abc', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });
  it('makes long random tokens', () => {
    const a = newMcpToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(newMcpToken());
  });
});

describe('the local MCP server', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { server: s } = await start();
    expect(s.url).toBe(`http://${MCP_HOST}:${s.port}/mcp`);
    expect(s.port).toBeGreaterThan(0);
  });

  it('refuses a request without the token, with a wrong one, or from a browser', async () => {
    const { server: s, token } = await start();
    expect((await post(s.url, {})).status).toBe(401);
    expect((await post(s.url, { authorization: 'Bearer nope' })).status).toBe(401);
    expect(
      (await post(s.url, { authorization: `Bearer ${token}`, origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    const other = await fetch(s.url.replace('/mcp', '/other'), { method: 'POST' });
    expect(other.status).toBe(404);
    expect((await post(s.url, { authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('refuses a Host header that is not the loopback address (DNS rebinding)', async () => {
    const { server: s, token } = await start();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: MCP_HOST,
          port: s.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: `attacker.example:${s.port}`,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(initBody);
    });
    expect(status).toBe(403);
  });

  it('lists the read tools and runs a call through the host', async () => {
    const { server: s, token, call } = await start();
    const client = await connect(s.url, token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('query_facts');
    expect(names).not.toContain('create_issue_draft');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const r = await client.callTool({ name: 'query_facts', arguments: { text: 'pile' } });
    expect(r.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith('query_facts', { text: 'pile', limit: 20 });
    expect(JSON.parse((r.content as { text: string }[])[0]?.text ?? '')).toEqual({
      name: 'query_facts',
      input: { text: 'pile', limit: 20 },
    });
  });

  it('answers a write tool, a bad input and a failed call as tool errors, never running them', async () => {
    const {
      server: s,
      token,
      call,
    } = await start({
      call: vi.fn(() => Promise.resolve({ ok: false as const, error: 'No project is open.' })),
    });
    const client = await connect(s.url, token);
    const write = await client.callTool({ name: 'create_issue_draft', arguments: {} });
    expect(write.isError).toBe(true);
    const bad = await client.callTool({ name: 'query_facts', arguments: { limit: 0 } });
    expect(bad.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    const failed = await client.callTool({ name: 'list_issues', arguments: {} });
    expect(failed.isError).toBe(true);
    expect((failed.content as { text: string }[])[0]?.text).toBe('No project is open.');
  });

  it('knows the connected client, and a disconnect ends its session', async () => {
    const onChange = vi.fn();
    const { server: s, token } = await start({ onChange });
    const client = await connect(s.url, token, 'Claude Code');
    await client.listTools();
    const [c] = s.clients();
    expect(c).toMatchObject({ name: 'Claude Code', version: '2.0.0', calls: 0 });
    expect(onChange).toHaveBeenCalled();
    await client.callTool({ name: 'list_layers', arguments: {} });
    expect(s.clients()[0]?.calls).toBe(1);

    expect(await s.disconnect(c?.id ?? '')).toBe(true);
    expect(s.clients()).toEqual([]);
    await expect(client.listTools()).rejects.toThrow();
    expect(await s.disconnect('nope')).toBe(false);
  });

  it('a new token ends every session and refuses the old one', async () => {
    const { server: s, token } = await start();
    const client = await connect(s.url, token);
    await client.listTools();
    const next = newMcpToken();
    await s.setToken(next);
    expect(s.clients()).toEqual([]);
    expect((await post(s.url, { authorization: `Bearer ${token}` })).status).toBe(401);
    const again = await connect(s.url, next);
    expect((await again.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('takes a free port when the one asked for is taken', async () => {
    const first = await start();
    const second = await startMcpHttpServer({
      port: first.server.port,
      token: 't',
      serverInfo: { name: 'x', version: '1' },
      call: () => Promise.resolve({ ok: true as const, text: '' }),
    });
    expect(second.port).not.toBe(first.server.port);
    await second.close();
  });
});
