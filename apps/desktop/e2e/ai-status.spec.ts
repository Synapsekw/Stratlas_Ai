/**
 * The one AI status chip in the sidebar's status row (shell/AiStatusChip.tsx): green only when a
 * request would run, amber when something the person can fix stops it, and a click opens what
 * fixes it, or Ask AI itself.
 *
 * - A new install (cloud AI on, no key): amber "AI off: no key", opening Settings, AI providers.
 * - With a key (a placeholder: checking a route sends nothing): green "AI ready"; on the Scene a
 *   click opens Ask AI with the cursor in its message box, and the agent's header says the same.
 * - Cloud AI switched off: a quiet "AI off", opening Settings, Privacy and cloud.
 *
 * Everything runs behind the zero-network guard. QUADRION_E2E_SHOTS=<folder> saves the states.
 */
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataRoot, expect, launchApp, NetworkGuard, test } from './fixtures';

test.setTimeout(180_000);

const SHOTS = process.env.QUADRION_E2E_SHOTS;

async function shot(win: Page, name: string) {
  if (!SHOTS) return;
  const size = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await win.screenshot({
    path: join(SHOTS, `${name}.png`),
    animations: 'disabled',
    clip: { x: 0, y: Math.max(0, size.height - 140), width: 320, height: 140 },
  });
}

const chip = (win: Page) => win.getByTestId('ai-status-chip');
const heading = (win: Page) => win.locator('.set-page h1');

test('the AI status chip says what Ask AI can do, and opens what fixes it', async () => {
  const data = await createDataRoot();
  const app = await launchApp(data);
  try {
    const network = new NetworkGuard();
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.sb-top')).toBeVisible();

    // a new install: cloud AI on, no key, so amber and never green
    await expect(chip(win)).toHaveText('AI off: no key');
    await expect(chip(win)).toHaveAttribute('data-tone', 'warn');
    // its tip says where the fix is
    await chip(win).hover();
    await expect(win.getByRole('tooltip')).toContainText('Settings, AI providers');
    await shot(win, 'ai-status-1-no-key');
    await chip(win).click();
    await expect(heading(win)).toHaveText('AI providers');

    // a key: AI ready, green
    await win.evaluate(() =>
      window.aio.invoke('ai:setKey', { provider: 'anthropic', key: 'placeholder-not-a-key' }),
    );
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await expect(chip(win)).toHaveText('AI ready');
    await expect(chip(win)).toHaveAttribute('data-tone', 'ok');
    await shot(win, 'ai-status-2-ready');

    // on the Scene a click opens Ask AI with the cursor in it; its header says the same state
    await win.locator('.nav-item', { hasText: 'Projects' }).click();
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
    await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
    await chip(win).click();
    const agent = win.getByRole('region', { name: 'Agent' });
    await expect(agent.getByRole('textbox', { name: 'Message the agent' })).toBeFocused();
    await expect(agent.getByTestId('agent-ai-chip')).toHaveText('AI ready');

    // cloud AI switched off: a quiet AI off, opening Privacy and cloud
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: false }));
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await expect(chip(win)).toHaveText('AI off');
    await expect(chip(win)).toHaveAttribute('data-tone', 'neutral');
    await shot(win, 'ai-status-3-off');
    await chip(win).click();
    await expect(heading(win)).toHaveText('Privacy and cloud');

    expect(await network.outbound(), 'the AI status made a request').toEqual([]);
  } finally {
    await app.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
