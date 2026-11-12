import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpCall, McpStatus } from '@aio/schema';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHost, mcpAccess, type McpHost, type McpHostDeps } from './mcp';

let dir: string;
let host: McpHost | null = null;
const clients: Client[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-host-'));
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await host?.stop();
  host = null;
  await rm(dir, { recursive: true, force: true });
});

const project = { id: 'p1', name: 'Quarry', root: 'C:/projects/quarry' };

function make(over: Partial<McpHostDeps> = {}) {
  const sent: McpCall[] = [];
  const emitted: McpStatus[] = [];
  const gate = { policyForbids: false, cloudAi: false, offlineOnly: false };
  const deps: McpHostDeps = {
    file: join(dir, 'mcp.json'),
    serverInfo: { name: 'Quadrion AI', version: '0.0.0' },
    openProject: () => project,
    gate: () => Promise.resolve(gate),
    send: (c) => {
      sent.push(c);
      queueMicrotask(() =>
        host?.result({ callId: c.callId, ok: true, text: `{"ran":"${c.name}"}` }),
      );
      return true;
    },
    emit: (s) => emitted.push(s),
    warn: () => undefined,
    ...over,
  };
  host = createMcpHost(deps);
  return { host, sent, emitted, gate };
}

async function connect(s: McpStatus) {
  const client = new Client({ name: 'Claude Code', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.url ?? ''), {
      requestInit: { headers: { Authorization: `Bearer ${s.token ?? ''}` } },
    }),
  );
  clients.push(client);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

describe('mcpAccess', () => {
  it('follows the cloud gate, the per-project choice, and never overrides a forbidding policy', () => {
    const g = { policyForbids: false, cloudAi: true, offlineOnly: false, allowed: false };
    expect(mcpAccess(g)).toBe('cloud');
    expect(mcpAccess({ ...g, cloudAi: false })).toBe('cloud-off');
    expect(mcpAccess({ ...g, offlineOnly: true })).toBe('cloud-off');
    expect(mcpAccess({ ...g, cloudAi: false, allowed: true })).toBe('allowed');
    expect(mcpAccess({ ...g, offlineOnly: true, allowed: true })).toBe('allowed');
    expect(mcpAccess({ ...g, policyForbids: true, allowed: true })).toBe('policy');
  });
});

describe('the MCP host', () => {
  it('is off by default and starts nothing', async () => {
    const { host } = make();
    await host.start();
    const s = await host.status();
    expect(s).toMatchObject({ enabled: false, running: false, url: null, token: null });
    expect(s.project).toMatchObject({ id: 'p1', allowed: false, access: 'cloud-off' });
  });

  it('switched on: listens on 127.0.0.1 with a token kept in the settings file', async () => {
    const { host, emitted } = make();
    const s = await host.setEnabled(true);
    expect(s.running).toBe(true);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(s.token?.length).toBeGreaterThan(40);
    expect(emitted.at(-1)?.running).toBe(true);
    const file = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(file).toMatchObject({ schema: 'aio.mcp/1', enabled: true, token: s.token });
    expect(s.tools).toBeGreaterThan(10);
  });

  it('keeps the token and port across a restart, and starts when left on', async () => {
    const { host: first } = make();
    const a = await first.setEnabled(true);
    await first.stop();
    const { host: second } = make();
    await second.start();
    const b = await second.status();
    expect(b.running).toBe(true);
    expect(b.token).toBe(a.token);
    expect(b.url).toBe(a.url);
  });

  it('refuses a project cloud AI could not read, until the person allows it', async () => {
    const { host, sent } = make();
    const s = await host.setEnabled(true);
    const client = await connect(s);
    const refused = await client.callTool({ name: 'list_issues', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/not shared with outside apps/);
    expect(sent).toEqual([]);

    const allowed = await host.setProjectAllowed('p1', true);
    expect(allowed.project).toMatchObject({ allowed: true, access: 'allowed' });
    const ok = await client.callTool({ name: 'query_facts', arguments: { text: 'pile' } });
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toBe('{"ran":"query_facts"}');
    expect(sent[0]).toMatchObject({
      projectId: 'p1',
      name: 'query_facts',
      input: { text: 'pile', limit: 20 },
    });

    const back = await host.setProjectAllowed('p1', false);
    expect(back.project?.allowed).toBe(false);
  });

  it('serves a project when cloud AI is on, never one whose policy forbids it', async () => {
    const { host, gate } = make();
    gate.cloudAi = true;
    const client = await connect(await host.setEnabled(true));
    expect((await client.callTool({ name: 'list_layers', arguments: {} })).isError).toBeFalsy();
    gate.policyForbids = true;
    await host.setProjectAllowed('p1', true);
    const r = await client.callTool({ name: 'list_layers', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/does not allow AI outside the app/);
  });

  it('answers without a project, without a window, and when the renderer is silent', async () => {
    let open: typeof project | null = null;
    const first = make({
      openProject: () => open,
      gate: () => Promise.resolve({ policyForbids: false, cloudAi: true, offlineOnly: false }),
      send: () => false,
      timeoutMs: 50,
    });
    const client = await connect(await first.host.setEnabled(true));
    expect(text(await client.callTool({ name: 'list_layers', arguments: {} }))).toMatch(
      /No project is open/,
    );
    open = project;
    expect(text(await client.callTool({ name: 'list_layers', arguments: {} }))).toMatch(
      /window is not open/,
    );
    await first.host.stop();
    const silent = make({
      gate: () => Promise.resolve({ policyForbids: false, cloudAi: true, offlineOnly: false }),
      send: () => true,
      timeoutMs: 50,
    });
    const c2 = await connect(await silent.host.setEnabled(true));
    expect(text(await c2.callTool({ name: 'list_layers', arguments: {} }))).toMatch(/in time/);
  });

  it('shows the connected client, disconnects it, and a new token shuts the old one out', async () => {
    const { host } = make();
    const s = await host.setEnabled(true);
    const client = await connect(s);
    await client.listTools();
    const [c] = (await host.status()).clients;
    expect(c).toMatchObject({ name: 'Claude Code', version: '1.0.0' });
    expect((await host.disconnect(c?.id ?? '')).clients).toEqual([]);

    const again = await connect(s);
    await again.listTools();
    const next = await host.newToken();
    expect(next.token).not.toBe(s.token);
    expect(next.clients).toEqual([]);
    await expect(connect(s)).rejects.toThrow();
  });

  it('switched off: stops listening', async () => {
    const { host } = make();
    const s = await host.setEnabled(true);
    const off = await host.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, running: false, url: null });
    await expect(fetch(s.url ?? '', { method: 'POST' })).rejects.toThrow();
  });

  it('ignores an unknown result', () => {
    const { host } = make();
    expect(host.result({ callId: 'x', ok: true, text: '' })).toBe(false);
  });
});
