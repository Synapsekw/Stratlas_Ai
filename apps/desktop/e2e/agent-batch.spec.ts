/**
 * A3 batch approvals end to end with the scripted test model (QUADRION_AI_TEST_PROVIDER, isolated
 * profile, no network) on the tiny project: one message whose `#batch` line makes three
 * `create_issue_draft` calls in one model step. The dock shows one card for the three, each
 * ticked; one is unticked and "Approve 2" runs the other two in order while the third is
 * declined. Each done step keeps its own Undo, and Undo takes one draft back.
 */
import { ProjectManifest } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { rm, writeFile } from 'node:fs/promises';
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

const SHOTS = process.env.QUADRION_E2E_SHOTS;

/** The tiny project with an issue class, so the agent can draft issues in it. */
function manifest() {
  return ProjectManifest.parse({
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
  });
}

/** How each step of the panel ended, in order (runs in the renderer). */
const stepStates = () =>
  [...document.querySelectorAll('.aio-agent .step')].map((el) =>
    `${el.className.replace(/\bstep\b/, '').trim()}: ${el.textContent}`.trim(),
  );

const draft = (title: string, x: number) =>
  `#tool create_issue_draft ${JSON.stringify({
    title,
    severity: 3,
    at: { kind: 'point', p: [x, 0, -0.5] },
  })}`;

const BATCH = `Draft these three #batch ${draft('Batch one', 0.2)} ${draft('Batch two', 0.5)} ${draft('Batch three', 0.8)}`;

/** Titles of the issues in the open project (runs in the renderer). */
const issueTitles = () =>
  (
    window as unknown as {
      __stratlas: { workspace: { getState(): { issues: { title: string }[] } } };
    }
  ).__stratlas.workspace
    .getState()
    .issues.map((i) => i.title);

const agent = (win: Page) => win.getByRole('region', { name: 'Ask AI chat' });

let app: ElectronApplication | null = null;
let data: DataRoot | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
  if (data) await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  data = null;
});

test('agent: several writes of one step are approved from one card, each with its own Undo', async () => {
  test.setTimeout(120_000);
  data = await createDataRoot();
  await writeFile(join(data.projectDir, 'manifest.json'), JSON.stringify(manifest()));
  app = await launchApp(data, { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_AI_TEST_PROVIDER: '1' });
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');

  // one message, three write calls in one model step
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(BATCH);
  await box.press('Enter');
  const preview = win.getByRole('dialog', { name: /Send to/ });
  await preview.getByRole('button', { name: 'Send' }).click();

  // one card for the three, each ticked; each step keeps its row
  const card = agent(win).locator('.approve.batch');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('3 actions waiting for you');
  await expect(agent(win).locator('.approve')).toHaveCount(1);
  await expect(agent(win).locator('.step.awaiting')).toHaveCount(3);
  const items = card.getByRole('checkbox');
  await expect(items).toHaveCount(3);
  for (const i of [0, 1, 2]) await expect(items.nth(i)).toBeChecked();
  await expect(card).toContainText('Adds draft issue "Batch two", severity 3');
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'agent-batch-card.png') });

  // untick the second; Approve 2 runs the others in order and declines it
  await card.getByRole('checkbox', { name: /Batch two/ }).uncheck();
  await card.getByRole('button', { name: 'Approve 2' }).click();
  await expect
    .poll(async () => (await win.evaluate(stepStates)).map((s) => s.split(':')[0]))
    .toEqual(['done', 'rejected', 'done']);
  await expect(
    agent(win).locator('.step.done'),
    (await win.evaluate(stepStates)).join(' | '),
  ).toHaveCount(2);
  await expect(agent(win).locator('.step.rejected')).toHaveCount(1);
  await expect(agent(win).locator('.approve')).toHaveCount(0);
  expect(await win.evaluate(issueTitles)).toEqual(['Batch one', 'Batch three']);
  // the model hears the results and answers
  await expect(agent(win).getByText(/^Tool create_issue_draft returned/)).toBeVisible();

  // each done step has its own Undo; one Undo takes one draft back
  const undos = agent(win).locator('.step.done').getByRole('button', { name: 'Undo' });
  await expect(undos).toHaveCount(2);
  await undos.first().click();
  await expect(agent(win).locator('.step.undone')).toHaveCount(1);
  await expect(agent(win).locator('.step.done')).toHaveCount(1);
  expect(await win.evaluate(issueTitles)).toEqual(['Batch three']);
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'agent-batch-done.png') });

  const outbound = await network.outbound();
  expect(outbound, 'the app made network requests').toEqual([]);
});
