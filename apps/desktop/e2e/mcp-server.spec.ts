/**
 * The local MCP server (intelligence review Wave 3, X1) in the real app at 1100 x 720: an outside
 * agent, here the official MCP TypeScript SDK client in the test process, reads the quarry survey
 * demo over Streamable HTTP on 127.0.0.1. The spec switches the server on in Settings > AI
 * providers > Outside apps (MCP), reads the address and token there, lists the tools (the agent's
 * read tools, no write tool), sees a call refused while cloud AI is off for the project, lets
 * outside apps read it, calls query_facts for "Stockpile SP1" from the fact index, sees the client
 * listed with its call count, disconnects it, and makes a new token that shuts the old one out.
 * The quarry ships three volume measurements named "Stockpile SP1" to "SP3"
 * (python/tests/survey_synth.py, `quarry_site`). Built by `pnpm demo:build --quick` (needs the
 * pipeline Python; skipped without it).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openSection } from './panel';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

const PILE = 'Stockpile SP1';
const INDEXED = { timeout: 120_000 };

const block = (win: Page) => win.getByTestId('mcp-server');

async function indexReady(win: Page): Promise<void> {
  const body = await openSection(win, 'project', 'project.search');
  const search = body.getByTestId('project-search');
  await expect(search.getByTestId('project-search-state')).toHaveCount(0, INDEXED);
  await expect(search.getByTestId('project-search-count')).toContainText('indexed', INDEXED);
}

async function openAiSettings(win: Page): Promise<Locator> {
  await win.getByRole('button', { name: 'Settings' }).first().click();
  await win.locator('.set-nav button', { hasText: 'AI providers' }).click();
  const b = block(win);
  await b.scrollIntoViewIfNeeded();
  await expect(b).toBeVisible();
  return b;
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-client', version: '1.2.3' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

test('an outside agent reads the open project over the local MCP server', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(360_000);
  // cloud AI off: outside apps are treated like cloud AI, so the project is not served at first
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: false }));
  await openDemo(win, quarryProject.name, quarryProject.id);
  await indexReady(win);

  // Step 1: off by default; switched on, it shows the 127.0.0.1 address
  const mcp = await openAiSettings(win);
  const toggle = mcp.getByTestId('mcp-switch').getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const urlText = mcp.getByTestId('mcp-url');
  await expect(urlText).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const url = await urlText.innerText();
  // the token is hidden until shown; the setup snippets name the address
  await expect(mcp.getByTestId('mcp-token')).toHaveText('Hidden');
  await mcp.getByRole('button', { name: 'Show' }).click();
  const token = await mcp.getByTestId('mcp-token').innerText();
  expect(token.length).toBeGreaterThan(40);
  await expect(mcp.locator('.mcp-setup pre').first()).toContainText(
    `claude mcp add --transport http`,
  );
  await expect(mcp.locator('.mcp-setup pre').first()).toContainText(url);

  // no token, no access
  const refused = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
  });
  expect(refused.status).toBe(401);

  // Step 2: the agent's read tools, and no write tool
  const client = await connect(url, token);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(['query_facts', 'history_of', 'list_issues']));
  for (const write of ['create_issue_draft', 'run_action', 'capture_frame', 'fly_to'])
    expect(names).not.toContain(write);

  // Step 3: not served while cloud AI is off for the project
  await expect(mcp.getByTestId('mcp-access')).toContainText('Not served');
  const blocked = await client.callTool({ name: 'query_facts', arguments: { text: PILE } });
  expect(blocked.isError).toBe(true);
  expect(textOf(blocked)).toContain('not shared with outside apps');

  // Step 4: allowed for this project, query_facts answers from the fact index
  await mcp.getByTestId('mcp-project').getByRole('switch').click();
  await expect(mcp.getByTestId('mcp-access')).toContainText('you let outside apps read');
  const answer = await client.callTool({ name: 'query_facts', arguments: { text: PILE } });
  expect(answer.isError, textOf(answer)).toBeFalsy();
  const body = JSON.parse(textOf(answer)) as { facts: { label: string; subject: string }[] };
  expect(body.facts.some((f) => f.label.includes(PILE))).toBe(true);
  // a write tool is refused even now, and never runs
  const write = await client.callTool({ name: 'create_issue_draft', arguments: {} });
  expect(write.isError).toBe(true);

  // Step 5: the client is listed with its calls, and Disconnect ends its session
  const clients = mcp.getByTestId('mcp-clients');
  await expect(clients).toContainText('e2e-client 1.2.3');
  await expect(clients).toContainText(/\d+ calls?/);
  await clients.getByRole('button', { name: 'Disconnect e2e-client' }).click();
  await expect(clients).toContainText('No app is connected.');
  await expect(client.listTools()).rejects.toThrow();
  await client.close().catch(() => undefined);

  // Step 6: a new token shuts the old one out
  await mcp.getByRole('button', { name: 'New token' }).click();
  await expect(mcp.getByTestId('mcp-token')).not.toHaveText(token);
  await expect(connect(url, token)).rejects.toThrow();
  const next = await mcp.getByTestId('mcp-token').innerText();
  const again = await connect(url, next);
  expect((await again.listTools()).tools.length).toBeGreaterThan(10);
  await again.close();

  // switched off: the port closes
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
});
