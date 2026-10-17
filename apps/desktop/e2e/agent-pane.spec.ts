/**
 * The Scene's agent pane (stage island D21-D25): one row while the AI is off, then maximised over
 * the bench (the tab bar stays, a tab brings the bench back), minimised to one line, dropped to
 * that line while a tool is live unless the person sized it, 60 / 40 again on a double-click, and
 * Ctrl+J into its input from a folded sidebar. Scripted test model, no network.
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test } from './fixtures';
import { measureControl } from './island';

const SHOTS = process.env.QUADRION_E2E_SHOTS;
async function shot(win: Page, name: string) {
  await win.screenshot({
    path: SHOTS ? join(SHOTS, `${name}.png`) : test.info().outputPath(`${name}.png`),
  });
}

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });
const box = (win: Page) => agent(win).getByRole('textbox', { name: 'Message the agent' });
const line = (win: Page) => win.locator('.right').getByRole('button', { name: /^Ask about/ });
const offRow = (win: Page) =>
  win.locator('.right').getByRole('button', { name: 'Agent off · Turn on' });

/** Heights in the right panel: the bench, the agent and the split they share. */
const heights = (win: Page) =>
  win.evaluate(() => {
    const h = (s: string) => document.querySelector(s)?.getBoundingClientRect().height ?? 0;
    return { bench: h('.right .wb-body'), agent: h('.right .agent'), split: h('.right .rp-split') };
  });

test('the agent pane: off row, maximise, minimise, a live tool, the divider and Ctrl+J', async ({
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const app = await launchApp(dataRoot, { QUADRION_AI_TEST_PROVIDER: '1' });
  const network = new NetworkGuard();
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    // AI off: one row instead of half the column (D24), the bench has the rest
    await expect(offRow(win)).toBeVisible();
    await expect(agent(win)).toBeHidden();
    expect((await heights(win)).agent).toBeLessThanOrEqual(48);
    await shot(win, 'agent-pane-01-off-row');
    await offRow(win).click();
    await expect(agent(win)).toContainText('The agent is off');

    // cloud AI on (the scripted provider stands in), and the panel's Check again
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await agent(win).getByRole('button', { name: 'Check again' }).click();
    await expect(box(win)).toBeEnabled({ timeout: 15_000 });
    await expect(agent(win).getByTestId('agent-cloud-chip')).toBeVisible();

    // maximise: the agent has the column below the tab bar (D22)
    await agent(win).getByRole('button', { name: 'Maximise' }).click();
    await expect(win.locator('.right .wb-body')).toBeHidden();
    await expect(win.locator('#wb-tab-issues')).toBeVisible();
    const max = await heights(win);
    expect(max.agent).toBeGreaterThan(max.split - 2);
    await shot(win, 'agent-pane-02-maximised');
    // a tab brings the workbench back
    await win.locator('#wb-tab-issues').click();
    await expect(win.locator('.right .wb-body')).toBeVisible();
    await expect(agent(win).getByRole('button', { name: 'Maximise' })).toBeVisible();

    // minimise: one line, Ask about the view, Ctrl J
    await win.locator('#wb-tab-selection').click();
    await agent(win).getByRole('button', { name: 'Minimise' }).click();
    await expect(line(win)).toHaveText(/Ask about 3D view\s*Ctrl J/);
    await expect(box(win)).toBeHidden();
    expect((await heights(win)).agent).toBeLessThanOrEqual(48);
    await shot(win, 'agent-pane-03-minimised');
    await line(win).click();
    await expect(box(win)).toBeFocused();

    // a live tool drops the agent to its line, and its stop brings it back (D23)
    const canvas = win.locator('[data-scene-view] canvas').first();
    await (await measureControl(win, 'survey-tool-distance')).click();
    await expect(win.getByTestId('survey-drawbar')).toBeVisible();
    await expect(line(win)).toBeVisible();
    await expect(box(win)).toBeHidden();
    await shot(win, 'agent-pane-04-tool-live');
    await canvas.hover();
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('survey-drawbar')).toHaveCount(0);
    await expect(box(win)).toBeVisible();

    // sized by the person, the agent stays as it is when a tool starts
    const divider = win.getByRole('separator', { name: 'Resize the agent' });
    await divider.focus();
    await win.keyboard.press('ArrowUp');
    await win.keyboard.press('ArrowUp');
    await (await measureControl(win, 'survey-tool-distance')).click();
    await expect(win.getByTestId('survey-drawbar')).toBeVisible();
    await expect(box(win)).toBeVisible();
    await expect(line(win)).toHaveCount(0);
    await canvas.hover();
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('survey-drawbar')).toHaveCount(0);

    // a double-click on the divider: 60 / 40 again (D21)
    await divider.dblclick();
    await expect
      .poll(async () => {
        const h = await heights(win);
        const handle = await divider.boundingBox();
        const split = await win.locator('.right .rp-split').boundingBox();
        if (!handle || !split) return -1;
        return Math.round(((handle.y + handle.height / 2 - split.y) / h.split) * 100);
      })
      .toBe(60);
    await shot(win, 'agent-pane-05-reset-60-40');

    // the sidebar folded: no agent shows; Ctrl+J opens it with the cursor in the input (D25, D28)
    await win.locator('[data-scene-view] canvas').first().hover();
    await win.keyboard.press('Control+Alt+B');
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    await expect(agent(win)).toBeHidden();
    // slid out to its strip at the window's edge
    await expect
      .poll(() =>
        win.evaluate(
          () =>
            window.innerWidth -
            (document.querySelector('.right')?.getBoundingClientRect().left ?? 0),
        ),
      )
      .toBeLessThanOrEqual(20);
    await shot(win, 'agent-pane-06-sidebar-folded');
    await win.keyboard.press('Control+J');
    await expect(box(win)).toBeFocused();
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
