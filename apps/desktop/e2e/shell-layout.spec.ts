/**
 * The shell's frame (UI revision W11): the 52 px rail on every screen, the 40 px title bar with
 * the breadcrumb, search and the status group, and the Layers column on the Scene only, which
 * Ctrl+L, Ctrl+B and the title bar's toggle fold away and bring back. The title bar's controls
 * keep clear of the window's own buttons.
 *
 * QUADRION_E2E_SHOTS=<folder> saves a screenshot of the frame open and folded.
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { captionArea } from './caption';
import { expect, test } from './fixtures';

const SHOTS = process.env.QUADRION_E2E_SHOTS;
const RAIL = 52;

async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Scene');
}

/** The rail's box, and whether it starts the window. */
const railBox = (win: Page) =>
  win.evaluate(() => {
    const r = document.querySelector('[data-testid="rail"]')?.getBoundingClientRect();
    return r ? { left: r.left, width: Math.round(r.width), height: r.height } : null;
  });

test('the rail is always present, on every screen', async ({ win }) => {
  await expect(win.getByTestId('project-card').first()).toBeVisible();
  const height = await win.evaluate(() => window.innerHeight);
  for (const screen of ['Projects', 'Globe', 'Issues', 'Inspect', 'Reports', 'Settings']) {
    await win.locator('.rail .nav-item', { hasText: screen }).first().click();
    await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText(screen);
    expect(await railBox(win)).toEqual({ left: 0, width: RAIL, height });
    // no Layers column off the Scene: the main area starts at the rail
    await expect(win.getByTestId('layers-column')).toHaveCount(0);
    await expect(win.getByTestId('titlebar')).toBeVisible();
  }
  await win.locator('.rail .nav-item', { hasText: 'Projects' }).first().click();
  await openTiny(win);
  expect(await railBox(win)).toEqual({ left: 0, width: RAIL, height });
  // folding Layers away leaves the rail where it is
  await win.keyboard.press('Control+B');
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
  expect(await railBox(win)).toEqual({ left: 0, width: RAIL, height });
  await win.keyboard.press('Control+B');
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
});

test('Ctrl+L toggles Layers, and the title bar toggle does too', async ({ win }) => {
  await openTiny(win);
  const column = win.getByTestId('layers-column');
  const toggle = win.getByTestId('layers-toggle');
  await expect(column).toBeVisible();
  await expect(column.getByTestId('sidebar-create-maps')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await shot(win, 'shell-layout-open');

  await win.keyboard.press('Control+L');
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // folded: the main area starts at the rail, and the column takes no focus
  await expect
    .poll(async () => Math.round((await win.locator('main.main').boundingBox())?.x ?? -1))
    .toBe(RAIL);
  await expect(column).toHaveAttribute('inert', '');
  await expect(win.getByTestId('panel-handle-left')).toHaveAttribute('aria-expanded', 'false');
  await shot(win, 'shell-layout-folded');

  await win.keyboard.press('Control+L');
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
  await expect(column.getByTestId('sidebar-create-maps')).toBeVisible();

  await toggle.click();
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
  // the tab on the rail's edge brings it back
  await win.getByTestId('panel-handle-left').click();
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // a key typed in a text field is the field's
  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await expect(palette.getByRole('combobox')).toBeFocused();
  await win.keyboard.press('Control+L');
  await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
  await win.keyboard.press('Escape');
});

test('the title bar clears the window buttons and holds the breadcrumb and status', async ({
  win,
}) => {
  await openTiny(win);
  const area = await captionArea(win);
  const bar = await win.evaluate(() => {
    const b = document.querySelector('.titlebar')?.getBoundingClientRect();
    const kids = [...document.querySelectorAll('.titlebar > *, .titlebar .sb-status-row > *')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0);
    return {
      top: b?.top ?? -1,
      height: b?.height ?? 0,
      right: Math.max(...kids.map((r) => r.right)),
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(bar.top).toBe(0);
  expect(bar.height).toBe(40);
  // the window's buttons begin here: the room the app keeps, and the buttons drawn
  const room = Math.min(
    (await win.evaluate(() => window.innerWidth)) - area.kept.right,
    area.free.right,
  );
  if (process.platform === 'win32') expect(area.kept.right).toBeGreaterThan(40);
  expect(bar.right).toBeLessThanOrEqual(room + 0.5);
  expect(bar.sideways).toBe(false);
  // the breadcrumb, search and the one AI status in the bar
  const titlebar = win.getByTestId('titlebar');
  await expect(titlebar.getByTestId('crumb-project')).toContainText('E2E tiny project');
  await expect(titlebar.locator('.tb-search')).toBeVisible();
  await expect(titlebar.getByTestId('ai-status-chip')).toBeVisible();
  await expect(titlebar.getByTestId('connection-chip')).toBeVisible();
  // the project menu holds Project settings and the Audit trail
  await titlebar.getByTestId('crumb-project').click();
  await expect(win.getByTestId('menu-audit-trail')).toBeVisible();
  await win.getByTestId('menu-project-settings').click();
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Settings');
  await expect(win.locator('.set-page h1')).toHaveText('Project settings');
  // the bar stays on Settings, with the AI chip still there to click
  await expect(titlebar.getByTestId('ai-status-chip')).toBeVisible();
});
