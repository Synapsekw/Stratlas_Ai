/**
 * The agent end to end with the scripted test model (STRATLAS_AI_TEST_PROVIDER, isolated profile
 * only): the send preview before the first cloud send (AI-6), conversation history saved in the
 * project and resumed (AI-8), an approval that survives a restart, Markdown export, the per-project
 * cost meter (AI-7) and the package AI policy. Zero network throughout.
 */
import { ProjectManifest } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyManifest,
  type DataRoot,
} from './fixtures';

const SHOTS = process.env.STRATLAS_E2E_SHOTS;

/** The tiny project with an issue class, so the agent can draft issues in it. */
function agentManifest(extra: Record<string, unknown> = {}) {
  return {
    ...ProjectManifest.parse({
      ...tinyManifest(),
      severityModels: [
        {
          id: 'sev',
          name: 'Severity 1 to 5',
          levels: [1, 2, 3, 4, 5].map((value) => ({
            value,
            label: `S${String(value)}`,
            color: '#e8c547',
            criteria: 'Test',
          })),
        },
      ],
      classCatalogues: [
        {
          id: 'cat',
          name: 'Test',
          assetType: 'tank',
          classes: [{ id: 'rust', label: 'Rust', color: '#aa5500', severityModel: 'sev' }],
        },
      ],
    }),
    ...extra,
  };
}

/** Apps still open, closed by `cleanup` when a test fails half way. */
const open = new Set<ElectronApplication>();

async function cleanup(data: DataRoot) {
  for (const app of open) await app.close().catch(() => undefined);
  open.clear();
  await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function start(data: DataRoot, env: Record<string, string> = {}) {
  const app = await launchApp(data, { STRATLAS_AI_TEST_PROVIDER: '1', ...env });
  open.add(app);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
}

/** Issues in the open project (runs in the renderer). */
const issueCount = () =>
  (
    window as unknown as {
      __stratlas: { workspace: { getState(): { issues: unknown[] } } };
    }
  ).__stratlas.workspace.getState().issues.length;

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function close(app: ElectronApplication, network: NetworkGuard) {
  const outbound = await network.outbound();
  await app.close();
  open.delete(app);
  expect(outbound, 'the app made network requests').toEqual([]);
}

test('agent: preview, history, restored approval, export and meter', async () => {
  test.setTimeout(120_000);
  const data = await createDataRoot();
  try {
    await writeFile(join(data.projectDir, 'manifest.json'), JSON.stringify(agentManifest()));
    let run = await start(data);
    let { win } = run;
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openTiny(win);

    // AI-6: the first send in the project stops at a preview of exactly what leaves the machine.
    await ask(win, 'Hello agent');
    const dialog = win.getByRole('dialog', { name: 'Send to Anthropic?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('claude-sonnet-5-5');
    await expect(dialog).toContainText('Hello agent');
    await expect(dialog).toContainText('"name": "E2E tiny project"');
    await shot(win, 'agent-preview');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog).toBeHidden();
    await expect(agent(win)).toContainText('Scripted reply to: Hello agent');

    // Later sends in this project go straight out; a read tool runs at once.
    await ask(win, 'measure from the origin');
    await expect(agent(win)).toContainText('Tool measure_distance returned');
    await expect(agent(win).locator('.step.done')).toContainText('5.00 m');
    await expect(agent(win)).toContainText('This project4.0k tok');

    // A write step waits for approval and is saved waiting.
    await ask(win, 'please draft an issue here');
    await expect(agent(win).locator('.step.awaiting')).toContainText('create_issue_draft');
    await shot(win, 'agent-awaiting');
    const dir = join(data.projectDir, 'ai', 'conversations');
    await expect
      .poll(async () => {
        const files = await readdir(dir).catch(() => []);
        // an atomic write's temp file can be renamed away between the listing and the read
        const texts = await Promise.all(
          files
            .filter((f) => f.endsWith('.json'))
            .map((f) => readFile(join(dir, f), 'utf8').catch(() => '')),
        );
        return texts.some((t) => t.includes('"status": "awaiting"'));
      })
      .toBe(true);
    await close(run.app, run.network);

    // After a restart: the conversation is listed with its waiting approval and resumes waiting.
    run = await start(data);
    win = run.win;
    await openTiny(win);
    await agent(win).getByRole('button', { name: 'Conversations in this project' }).click();
    const item = agent(win).getByRole('list', { name: 'Saved conversations' }).getByRole('button');
    await expect(item).toContainText('Hello agent');
    await expect(item).toContainText('1 approval waiting');
    await shot(win, 'agent-history');
    await item.click();
    const waiting = agent(win).locator('.step.awaiting');
    await expect(waiting).toContainText('create_issue_draft');
    // Nothing ran on its own.
    expect(await win.evaluate(issueCount)).toBe(0);
    await agent(win).getByRole('button', { name: 'Approve' }).click();
    await expect(agent(win).locator('.step.done').last()).toContainText('AG01 drafted');
    await expect(agent(win)).toContainText('Approved later and run: create_issue_draft');
    expect(await win.evaluate(issueCount)).toBe(1);
    await shot(win, 'agent-approved-after-restart');

    // AI-8: export as Markdown through the save dialog.
    const md = join(data.base, 'chat.md');
    await run.app.evaluate(({ dialog: d }, path) => {
      d.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
    }, md);
    await agent(win).getByRole('button', { name: 'Export this conversation as Markdown' }).click();
    await expect.poll(() => readFile(md, 'utf8').catch(() => '')).toContain('## You');
    const text = await readFile(md, 'utf8');
    expect(text).toContain('Hello agent');
    expect(text).toContain('`create_issue_draft` (done): AG01 drafted');

    // AI-7: Settings lists tokens and cost per project and provider.
    await win.getByRole('button', { name: 'Settings' }).first().click();
    await win.getByRole('button', { name: 'Usage and cost' }).click();
    const table = win.getByRole('table', { name: 'Agent usage by project and provider' });
    await expect(table).toContainText('E2E tiny project');
    await expect(table).toContainText('Anthropic');
    await shot(win, 'settings-usage');
    await win.getByRole('button', { name: 'AI providers' }).click();
    await expect(win.getByText('Use a local model')).toBeVisible();
    await shot(win, 'settings-local-model');
    await close(run.app, run.network);
  } finally {
    await cleanup(data);
  }
});

test('agent: a package that forbids cloud AI keeps the agent off', async () => {
  const data = await createDataRoot();
  try {
    await writeFile(
      join(data.projectDir, 'manifest.json'),
      JSON.stringify(agentManifest({ aiPolicy: 'forbid' })),
    );
    const run = await start(data);
    await run.win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openTiny(run.win);
    await expect(agent(run.win)).toContainText(
      'This project does not allow sending its data to cloud AI',
    );
    await expect(agent(run.win).getByRole('textbox', { name: 'Message the agent' })).toBeDisabled();
    const sent = await run.win.evaluate(() =>
      window.aio.invoke('ai:send', {
        runId: 'x',
        projectId: 'e2e-tiny',
        window: 'scene3d',
        context: {},
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(sent.ok).toBe(false);
    await close(run.app, run.network);
  } finally {
    await cleanup(data);
  }
});

test('agent: Settings tests the connection and keeps the Anthropic workspace ID', async () => {
  const data = await createDataRoot();
  try {
    const run = await start(data);
    const { win } = run;
    const testConnection = () =>
      win.evaluate(() => window.aio.invoke('ai:testConnection', { provider: 'anthropic' }));
    // Cloud AI is off by default: the test does not call out.
    expect(await testConnection()).toEqual({
      ok: false,
      message: 'Cloud AI is off. Turn it on in Settings, AI providers, to use the agent.',
    });
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    expect(await testConnection()).toEqual({
      ok: true,
      message: 'Scripted test model answered with claude-sonnet-5-5: "OK".',
      model: 'claude-sonnet-5-5',
    });

    await win.getByRole('button', { name: 'Settings' }).first().click();
    await win.getByRole('button', { name: 'AI providers' }).click();
    const field = win.getByRole('textbox', { name: 'Anthropic workspace ID' });
    await field.fill('wrkspc_01E2ETest');
    await field.press('Enter');
    await expect
      .poll(async () => {
        const text = await readFile(join(data.userData, 'settings.json'), 'utf8').catch(() => '');
        return (JSON.parse(text || '{}') as { anthropicWorkspaceId?: string }).anthropicWorkspaceId;
      })
      .toBe('wrkspc_01E2ETest');
    await field.fill('not a workspace!');
    await field.press('Enter');
    await expect(win.getByRole('alert')).toContainText('A workspace ID has only letters');
    // A typo is refused in place: the stored ID stays and Settings keep saving.
    await expect(win.getByText('Settings are not being saved')).toHaveCount(0);
    expect(
      (
        JSON.parse(await readFile(join(data.userData, 'settings.json'), 'utf8')) as {
          anthropicWorkspaceId?: string;
        }
      ).anthropicWorkspaceId,
    ).toBe('wrkspc_01E2ETest');
    await shot(win, 'settings-anthropic-workspace');
    await close(run.app, run.network);
  } finally {
    await cleanup(data);
  }
});

test('agent: the Anthropic workspace error is fixed in the panel and the message is sent again', async () => {
  test.setTimeout(120_000);
  const data = await createDataRoot();
  try {
    await writeFile(join(data.projectDir, 'manifest.json'), JSON.stringify(agentManifest()));
    // The scripted Anthropic stands in for a key that is not scoped to a workspace.
    const run = await start(data, { STRATLAS_AI_TEST_SCRIPT: 'workspace-400' });
    const { win } = run;
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    // Test connection reports the error with its code (Settings focuses the field on it).
    const tested = await win.evaluate(() =>
      window.aio.invoke('ai:testConnection', { provider: 'anthropic' }),
    );
    expect(tested).toMatchObject({ ok: false, status: 400, code: 'anthropic-workspace' });
    expect(tested.message).toContain('This API key is not scoped to a workspace');
    await openTiny(win);

    await ask(win, 'Hello agent');
    await win
      .getByRole('dialog', { name: 'Send to Anthropic?' })
      .getByRole('button', { name: 'Send' })
      .click();
    await expect(agent(win).locator('.ag-err')).toContainText(
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header',
    );
    await expect(agent(win).locator('.ag-err')).toContainText('(HTTP 400)');
    const card = agent(win).getByRole('group', { name: 'Workspace ID needed' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('This Anthropic API key is not tied to a workspace');
    const field = card.getByRole('textbox', { name: 'Anthropic workspace ID' });
    await expect(field).toBeFocused();
    await expect(card.getByRole('button', { name: 'Open AI settings' })).toBeVisible();

    // The same rule as Settings: a typo is refused in place.
    await field.fill('not a workspace!');
    await card.getByRole('button', { name: 'Test and retry' }).click();
    await expect(card.getByRole('alert')).toContainText('A workspace ID has only letters');
    await shot(win, 'agent-workspace-card');

    // Saved to the same setting, tested, and the failed message goes again.
    await field.fill('wrkspc_01E2EFix');
    await card.getByRole('button', { name: 'Test and retry' }).click();
    await expect(card).toBeHidden();
    await expect(agent(win)).toContainText('Scripted reply to: Hello agent');
    await expect(agent(win).locator('.ag-err')).toHaveCount(0);
    await expect(agent(win).locator('.ag-msg.user', { hasText: 'Hello agent' })).toHaveCount(1);
    expect(
      (
        JSON.parse(await readFile(join(data.userData, 'settings.json'), 'utf8')) as {
          anthropicWorkspaceId?: string;
        }
      ).anthropicWorkspaceId,
    ).toBe('wrkspc_01E2EFix');
    await shot(win, 'agent-workspace-fixed');

    // Without the ID again: "Open AI settings" lands on the field in Settings.
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'AI providers' }).click();
    const settingsField = win.getByRole('textbox', { name: 'Anthropic workspace ID' });
    await expect(settingsField).toHaveValue('wrkspc_01E2EFix');
    await settingsField.fill('');
    await settingsField.press('Enter');
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await ask(win, 'Second message');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Open AI settings' }).click();
    await expect(win.locator('.set-page h1')).toHaveText('AI providers');
    await expect(settingsField).toBeFocused();
    await expect(win.getByTestId('workspace-needed')).toBeVisible();
    await shot(win, 'agent-workspace-settings');
    await close(run.app, run.network);
  } finally {
    await cleanup(data);
  }
});
