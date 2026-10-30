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
  win.locator('.right').getByRole('button', { name: /^AI off.* · Turn on$/ });

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
    // a new install starts with cloud AI on; this spec starts from off and turns it on itself
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: false }));
    // the screen loaded with the new-install default, so load it again to show the saved value
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    // AI off: one row instead of half the column (D24), the bench has the rest
    await expect(offRow(win)).toBeVisible();
    await expect(agent(win)).toBeHidden();
    expect((await heights(win)).agent).toBeLessThanOrEqual(48);
    await shot(win, 'agent-pane-01-off-row');
    // Ctrl+J with the AI off: the cursor on the row's Turn on
    await win.locator('[data-scene-view] canvas').first().hover();
    await win.keyboard.press('Control+J');
    await expect(offRow(win)).toBeFocused();
    // Turn on opens the agent's words on why it is off, the cursor on its Check again
    await win.keyboard.press('Enter');
    await expect(agent(win)).toContainText('The agent is off');
    await expect(agent(win).getByRole('button', { name: 'Check again' })).toBeFocused();

    // cloud AI on from the command search (the scripted provider stands in for the cloud): the
    // panel checks its route again by itself, and the header's AI status chip follows
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await palette.getByRole('combobox').fill('cloud AI');
    await palette.getByRole('option', { name: /Turn cloud AI on/ }).click();
    await expect(box(win)).toBeEnabled({ timeout: 15_000 });
    await expect(agent(win).getByTestId('agent-ai-chip')).toHaveText('AI ready');

    // the header at 1100 px: the bound view's chip shows its whole window name ("3D view"),
    // the rest ellipsized; Minimise and Maximise are the panel's own borderless buttons
    const chip = await agent(win)
      .locator('.ag-bind')
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        const probe = document.createElement('span');
        probe.textContent = '3D view';
        probe.style.font = cs.font;
        probe.style.fontVariantNumeric = cs.fontVariantNumeric;
        probe.style.position = 'absolute';
        probe.style.whiteSpace = 'nowrap';
        document.body.append(probe);
        const label = probe.getBoundingClientRect().width;
        probe.remove();
        const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return {
          text: el.textContent,
          label,
          inner,
          clipped: el.scrollWidth > el.clientWidth,
          ellipsis: cs.textOverflow,
          // text-overflow draws its ellipsis only on a block container that clips its own text
          display: cs.display,
          overflow: cs.overflowX,
          // the chip's own box ends inside the header: the cut is its ellipsis, not the row's edge
          inside:
            el.getBoundingClientRect().right <=
            (el.parentElement?.getBoundingClientRect().right ?? 0) + 0.5,
          window: window.innerWidth,
        };
      });
    expect(chip.window).toBe(1100);
    expect(chip.text).toMatch(/^3D view, /);
    expect(chip.inner, JSON.stringify(chip)).toBeGreaterThanOrEqual(chip.label);
    expect(chip.ellipsis).toBe('ellipsis');
    // the rest is cut at an ellipsis by the chip itself (the old header cut it at its edge,
    // after "3D view,"): the text overflows the chip, which clips and ellipsizes it
    expect(chip.clipped, JSON.stringify(chip)).toBe(true);
    // a flex box (the old inline-flex chip) ignores text-overflow: no ellipsis is drawn
    expect(chip.display).toBe('block');
    expect(chip.overflow).toBe('hidden');
    expect(chip.inside, JSON.stringify(chip)).toBe(true);
    for (const name of ['Minimise', 'Maximise']) {
      await expect(agent(win).getByRole('button', { name })).toHaveClass('ag-btn ghost icon');
    }

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
    // the focus moves on to the line, which restores
    await expect(line(win)).toBeFocused();
    await expect(box(win)).toBeHidden();
    expect((await heights(win)).agent).toBeLessThanOrEqual(48);
    await shot(win, 'agent-pane-03-minimised');
    await line(win).click();
    await expect(box(win)).toBeFocused();
    // Ctrl+J on a minimised agent: open again, the cursor in its input
    await agent(win).getByRole('button', { name: 'Minimise' }).click();
    await expect(box(win)).toBeHidden();
    await win.locator('[data-scene-view] canvas').first().hover();
    await win.keyboard.press('Control+J');
    await expect(box(win)).toBeFocused();
    await expect(line(win)).toHaveCount(0);

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
