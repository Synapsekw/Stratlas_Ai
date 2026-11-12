/**
 * A3 view-capture consent per project end to end with the scripted test model
 * (QUADRION_AI_TEST_PROVIDER, isolated profile, no network) on the tiny project's 3D view. The
 * first `capture_frame` asks with "Allow for this project", "Just this once" and "Reject";
 * "Allow for this project" stores the choice on this computer (`ai:project` says so) and runs
 * the capture. The next capture runs without a card and says why. Turned off again through
 * `ai:setViewCapture` (the dock's project panel does the same), the card comes back.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataRoot, expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

const SHOTS = process.env.QUADRION_E2E_SHOTS;
const CAPTURE = 'Look at this #tool capture_frame';
const NOTE = 'Ran without asking: view capture is allowed for this project.';

const agent = (win: Page) => win.getByRole('region', { name: 'Ask AI chat' });
const captures = (win: Page) =>
  agent(win)
    .locator('.step')
    .filter({ has: win.locator('code', { hasText: /^capture_frame$/ }) });

async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

let app: ElectronApplication | null = null;
let data: DataRoot | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
  if (data) await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  data = null;
});

test('agent: view capture asks once per project, then runs without a card until turned off', async () => {
  test.setTimeout(120_000);
  data = await createDataRoot();
  const projectId = data.projectId;
  app = await launchApp(data, { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_AI_TEST_PROVIDER: '1' });
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
  const viewCapture = () =>
    win.evaluate(
      async (id) => (await window.aio.invoke('ai:project', { projectId: id })).viewCapture ?? false,
      projectId,
    );
  expect(await viewCapture()).toBe(false);

  // the first capture asks, with the three choices
  await ask(win, CAPTURE);
  await win
    .getByRole('dialog', { name: /Send to/ })
    .getByRole('button', { name: 'Send' })
    .click();
  const card = agent(win).locator('.approve');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Sends the current frame to the AI provider');
  await expect(card.getByRole('button')).toHaveText([
    'Reject',
    'Just this once',
    'Allow for this project',
  ]);
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'agent-view-consent-card.png') });
  await card.getByRole('button', { name: 'Allow for this project' }).click();
  await expect(captures(win).first()).toHaveClass(/\bdone\b/);
  await expect(captures(win).first()).toContainText(/Frame at \d\d:\d\d:\d\d/);
  await expect(agent(win).getByText(/^Tool capture_frame returned/)).toBeVisible();
  await expect.poll(viewCapture).toBe(true);

  // the next capture in this project runs without a card and says why
  await ask(win, CAPTURE);
  await expect(captures(win)).toHaveCount(2);
  await expect(captures(win).nth(1)).toHaveClass(/\bdone\b/);
  await expect(agent(win).locator('.approve')).toHaveCount(0);
  await expect(agent(win).locator('.step-note')).toHaveText(NOTE);
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'agent-view-consent-auto.png') });

  // turned off (the dock's project panel calls the same channel), the card comes back; the dock
  // reads the project's choices again when the window gets focus
  await expect(agent(win).getByText(/^Tool capture_frame returned/)).toHaveCount(2);
  const off = await win.evaluate(
    (id) => window.aio.invoke('ai:setViewCapture', { projectId: id, allow: false }),
    projectId,
  );
  expect(off).toEqual({ ok: true });
  expect(await viewCapture()).toBe(false);
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  // the re-read is two quick IPC calls; nothing on screen says when it is over
  await win.waitForTimeout(1000);
  await ask(win, CAPTURE);
  await expect(captures(win)).toHaveCount(3);
  await expect(captures(win).nth(2)).toHaveClass(/\bawaiting\b/);
  await expect(agent(win).locator('.approve')).toHaveCount(1);
  await expect(agent(win).locator('.approve')).toContainText('Allow for this project');
  await agent(win).locator('.approve').getByRole('button', { name: 'Reject' }).click();
  await expect(captures(win).nth(2)).toHaveClass(/\brejected\b/);

  const outbound = await network.outbound();
  expect(outbound, 'the app made network requests').toEqual([]);
});
