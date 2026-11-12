import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpCall, McpStatus } from '@aio/schema';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowKey, createMcpHost, mcpAccess, type McpHost, type McpHostDeps } from './mcp';

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
  const secrets: string[] = [];
  const gate = { policyForbids: false, offlineOnly: false };
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
    secret: (t) => secrets.push(t),
    warn: () => undefined,
    ...over,
  };
  host = createMcpHost(deps);
  return { host, sent, emitted, gate, secrets };
}

async function connect(h: McpHost, s: McpStatus, token?: string) {
  const client = new Client({ name: 'Claude Code', version: '1.0.0' });
  const t = token ?? (await h.revealToken()) ?? '';
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.url ?? ''), {
      requestInit: { headers: { Authorization: `Bearer ${t}` } },
    }),
  );
  clients.push(client);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

describe('mcpAccess', () => {
  it('serves only an allowed project; a forbidding policy wins, then offline-only', () => {
    const g = { policyForbids: false, offlineOnly: false, allowed: false };
    expect(mcpAccess(g)).toBe('not-allowed');
    expect(mcpAccess({ ...g, allowed: true })).toBe('allowed');
    expect(mcpAccess({ ...g, allowed: true, offlineOnly: true })).toBe('offline');
    expect(mcpAccess({ ...g, allowed: true, policyForbids: true })).toBe('policy');
  });
  it('keys the allow by folder and project id', () => {
    expect(allowKey(project)).not.toBe(allowKey({ ...project, id: 'p2' }));
  });
});

describe('the MCP host', () => {
  it('is off by default and starts nothing', async () => {
    const { host } = make();
    await host.start();
    const s = await host.status();
    expect(s).toMatchObject({ enabled: false, running: false, url: null, hasToken: false });
    expect(s.project).toMatchObject({ id: 'p1', allowed: false, access: 'not-allowed' });
  });

  it('switched on: listens on 127.0.0.1; the token is kept, registered as a secret and never in a status', async () => {
    const { host, emitted, secrets } = make();
    const s = await host.setEnabled(true);
    expect(s.running).toBe(true);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(s.hasToken).toBe(true);
    const token = await host.revealToken();
    expect(token?.length).toBeGreaterThan(40);
    expect(secrets).toContain(token);
    for (const e of [s, ...emitted]) expect(JSON.stringify(e)).not.toContain(token);
    const file = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(file).toMatchObject({ schema: 'aio.mcp/1', enabled: true, token });
    expect(s.tools).toBeGreaterThan(10);
  });

  it('keeps the token and port across a restart, and starts when left on', async () => {
    const { host: first } = make();
    const a = await first.setEnabled(true);
    const ta = await first.revealToken();
    await first.stop();
    const { host: second } = make();
    await second.start();
    const b = await second.status();
    expect(b.running).toBe(true);
    expect(await second.revealToken()).toBe(ta);
    expect(b.url).toBe(a.url);
  });

  it('a taken port is not moved silently: the error says so, and a new port moves it with a new token', async () => {
    const { host: first } = make();
    const a = await first.setEnabled(true);
    const oldToken = await first.revealToken();
    await first.stop();
    const port = Number(new URL(a.url ?? '').port);
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', r));
    try {
      const { host: second } = make();
      await second.start();
      const s = await second.status();
      expect(s).toMatchObject({ running: false, portInUse: true });
      expect(s.error).toMatch(/in use by another program/);
      const moved = await second.newPort();
      expect(moved.running).toBe(true);
      expect(moved.portInUse).toBeUndefined();
      expect(moved.url).not.toBe(a.url);
      expect(await second.revealToken()).not.toBe(oldToken);
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });

  it('refuses a project until the person allows it, then serves it', async () => {
    const { host, sent, gate } = make();
    const s = await host.setEnabled(true);
    const client = await connect(host, s);
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

    // offline-only refuses every call, even for an allowed project
    gate.offlineOnly = true;
    const offline = await client.callTool({ name: 'list_layers', arguments: {} });
    expect(offline.isError).toBe(true);
    expect(text(offline)).toMatch(/offline only/);
    expect((await host.status()).offlineOnly).toBe(true);
    expect((await host.status()).project?.access).toBe('offline');
    gate.offlineOnly = false;

    const back = await host.setProjectAllowed('p1', false);
    expect(back.project?.allowed).toBe(false);
  });

  it('never serves a project whose policy forbids cloud AI, even when allowed', async () => {
    const { host, gate } = make();
    const client = await connect(host, await host.setEnabled(true));
    gate.policyForbids = true;
    await host.setProjectAllowed('p1', true);
    const r = await client.callTool({ name: 'list_layers', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/does not allow AI outside the app/);
  });

  it('answers without a project, without a window, and when the renderer is silent', async () => {
    let open: typeof project | null = null;
    const first = make({ openProject: () => open, send: () => false, timeoutMs: 50 });
    const client = await connect(first.host, await first.host.setEnabled(true));
    expect(text(await client.callTool({ name: 'list_layers', arguments: {} }))).toMatch(
      /No project is open/,
    );
    open = project;
    await first.host.setProjectAllowed('p1', true);
    expect(text(await client.callTool({ name: 'list_layers', arguments: {} }))).toMatch(
      /window is not open/,
    );
    await first.host.stop();
    const silent = make({ send: () => true, timeoutMs: 50 });
    const s2 = await silent.host.setEnabled(true);
    await silent.host.setProjectAllowed('p1', true);
    const c2 = await connect(silent.host, s2);
    expect(text(await c2.callTool({ name: 'list_layers', arguments: {} }))).toMatch(/in time/);
  });

  it('shows the connected client, disconnects it, and a new token shuts the old one out', async () => {
    const { host } = make();
    const s = await host.setEnabled(true);
    const old = (await host.revealToken()) ?? '';
    const client = await connect(host, s);
    await client.listTools();
    const [c] = (await host.status()).clients;
    expect(c).toMatchObject({ name: 'Claude Code', version: '1.0.0' });
    expect((await host.disconnect(c?.id ?? '')).clients).toEqual([]);

    const again = await connect(host, s);
    await again.listTools();
    const next = await host.newToken();
    expect(await host.revealToken()).not.toBe(old);
    expect(next.clients).toEqual([]);
    await expect(connect(host, s, old)).rejects.toThrow();
  });

  it('switched off while starting: the server it was starting closes too', async () => {
    const { host } = make();
    const on = host.setEnabled(true);
    const off = host.setEnabled(false);
    await on;
    const s = await off;
    expect(s).toMatchObject({ enabled: false, running: false, url: null });
  });

  it('refuses a result when another project opened during the call', async () => {
    let open = project;
    const { host } = make({
      openProject: () => open,
      send: (c) => {
        open = { ...project, id: 'p2' };
        queueMicrotask(() => host.result({ callId: c.callId, ok: true, text: '{}' }));
        return true;
      },
    });
    const client = await connect(host, await host.setEnabled(true));
    await host.setProjectAllowed('p1', true);
    const r = await client.callTool({ name: 'list_layers', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/project in the app changed/);
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
