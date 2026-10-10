/**
 * The title bar's connection pair: the mode chip says the real mode (Online or Offline only, the
 * offline-only setting main checks) and the cloud AI chip beside it never contradicts it.
 *
 * - The mode chip opens the Connection menu: the switch, what the mode means, Download maps and
 *   Cloud AI. Keyboard: Enter opens, Space switches, Escape closes and returns focus.
 * - Offline only: the cloud chip is never on, Download maps is off in the menu, and Offline maps
 *   greys its Download button; main refuses a download. Online: all of it is offered again. No
 *   download is started.
 * - The mode survives a relaunch, and the command search has Go online / Work offline only.
 * - At the smallest window the chips stay clear of the window's own buttons and the search
 *   button stays.
 *
 * Everything runs behind the zero-network guard: no request leaves in either mode.
 * QUADRION_E2E_SHOTS=<folder> saves a screenshot of each chip state and of the open menu.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataRoot, expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

test.setTimeout(180_000);

const SHOTS = process.env.QUADRION_E2E_SHOTS;

/** The whole window, or only its title bar strip (`bar`). */
async function shot(win: Page, name: string, bar = false) {
  if (!SHOTS) return;
  const size = await win.evaluate(() => ({ width: window.innerWidth, height: 48 }));
  await win.screenshot({
    path: join(SHOTS, `${name}.png`),
    // the menu fades in; an off-screen window draws too few frames to finish that on its own
    animations: 'disabled',
    ...(bar ? { clip: { x: Math.max(0, size.width - 900), y: 0, width: 900, height: 48 } } : {}),
  });
}

async function start(data: DataRoot) {
  const app = await launchApp(data);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('.titlebar')).toBeVisible();
  return { app, network, win };
}

const mode = (win: Page) => win.getByTestId('connection-chip');
const cloud = (win: Page) => win.getByTestId('cloud-chip');
const menu = (win: Page) => win.getByRole('dialog', { name: 'Connection' });
const modeSwitch = (win: Page) => menu(win).getByRole('switch', { name: 'Online' });
const offlineOnly = (win: Page) =>
  win.evaluate(() => window.aio.invoke('settings:get', {}).then((s) => s.offlineOnly === true));

/** Run a command of the command search by its exact title. */
async function command(win: Page, title: string) {
  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await expect(palette).toBeVisible();
  await win.keyboard.type(title);
  await expect(palette.getByRole('option').first()).toHaveText(new RegExp(`^${title}`));
  await win.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/** The green dot of the cloud chip: only ever beside "Online". */
const cloudIsGreen = (win: Page) =>
  cloud(win)
    .locator('.dot:not(.off)')
    .count()
    .then((n) => n > 0);

test('the title bar shows the real mode, its menu switches it, and the mode survives a relaunch', async () => {
  const data = await createDataRoot();
  let app: ElectronApplication | undefined;
  try {
    let run = await start(data);
    app = run.app;
    let { win, network } = run;

    // A new workstation may go online, and cloud AI is off: the pair says exactly that.
    await expect(mode(win)).toHaveText('Online');
    await expect(mode(win)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(mode(win)).toHaveAttribute('aria-expanded', 'false');
    await expect(cloud(win)).toHaveText('Cloud AI off');
    expect(await cloudIsGreen(win)).toBe(false);
    await shot(win, 'conn-1-online-cloud-off', true);

    // Keyboard: Enter opens the menu on the switch.
    await mode(win).focus();
    await win.keyboard.press('Enter');
    await expect(menu(win)).toBeVisible();
    await expect(mode(win)).toHaveAttribute('aria-expanded', 'true');
    await expect(modeSwitch(win)).toBeFocused();
    await expect(modeSwitch(win)).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByTestId('connection-text')).toContainText('You can download maps');
    await expect(win.getByTestId('connection-cloud')).toContainText('Off');
    await expect(win.getByTestId('connection-no-network')).toHaveCount(0);
    await shot(win, 'conn-2-menu-online');

    // Online: Download maps leads to Offline maps, where a region download is offered.
    const maps = win.getByTestId('connection-maps');
    await expect(maps).toBeEnabled();
    await expect(maps).toContainText('Settings, Offline maps');
    await maps.click();
    await expect(menu(win)).toBeHidden();
    await expect(win.locator('.set-page h1')).toHaveText('Offline maps');
    await win.getByRole('button', { name: 'Add a region' }).click();
    const panel = win.getByTestId('add-region');
    await panel.getByLabel('Country').selectOption('qatar');
    const download = panel.getByRole('button', { name: /^Download/ });
    await expect(download).toBeEnabled();
    await expect(panel).not.toContainText('offline-only');
    await shot(win, 'conn-3-maps-online');

    // Space on the switch: offline only, at once, and everything on screen follows.
    await mode(win).click();
    await expect(modeSwitch(win)).toBeFocused();
    await win.keyboard.press('Space');
    await expect(modeSwitch(win)).toHaveAttribute('aria-checked', 'false');
    await expect(mode(win)).toHaveText('Offline only');
    await expect(cloud(win)).toHaveText('Cloud AI off');
    await expect(cloud(win)).toHaveAttribute('title', /offline-only/);
    await expect(win.getByTestId('connection-text')).toContainText('makes no network connections');
    await expect(maps).toBeDisabled();
    await expect(maps).toContainText('Go online first');
    await expect.poll(() => offlineOnly(win)).toBe(true);
    await shot(win, 'conn-4-menu-offline');

    // Escape closes the menu and gives focus back to the chip.
    await win.keyboard.press('Escape');
    await expect(menu(win)).toBeHidden();
    await expect(mode(win)).toBeFocused();
    await shot(win, 'conn-5-offline-cloud-off', true);

    // Offline maps behind it: the download is greyed with the reason, and main refuses one.
    await expect(panel).toContainText('offline-only');
    await expect(download).toBeDisabled();
    const refused = await win.evaluate(() =>
      window.aio.invoke('packs:download', {
        id: 'e2e-refused',
        label: 'Refused',
        bbox: [50.74, 24.47, 51.65, 26.2],
        maxZoom: 6,
      }),
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('offline-only');
    expect(await readdir(join(data.root, 'packs'))).toEqual([]);
    expect(await network.outbound(), 'a request left in offline only').toEqual([]);

    // The mode is a saved setting: offline only is still there after a relaunch.
    await app.close();
    run = await start(data);
    app = run.app;
    ({ win, network } = run);
    await expect(mode(win)).toHaveText('Offline only');
    await expect(cloud(win)).toHaveText('Cloud AI off');
    expect(await offlineOnly(win)).toBe(true);

    // The command search goes online, then turns cloud AI on: the pair turns green together.
    await command(win, 'Go online');
    await expect(mode(win)).toHaveText('Online');
    await command(win, 'Turn cloud AI on');
    await expect(cloud(win)).toHaveText('Cloud AI');
    expect(await cloudIsGreen(win)).toBe(true);
    await shot(win, 'conn-6-online-cloud-on', true);
    await mode(win).click();
    await expect(win.getByTestId('connection-cloud')).toContainText('On');
    await shot(win, 'conn-7-menu-online-cloud-on');

    // Offline only with cloud AI switched on: blocked, never green, and the menu says why.
    await modeSwitch(win).click();
    await expect(mode(win)).toHaveText('Offline only');
    await expect(cloud(win)).toHaveText('Cloud AI blocked');
    await expect(cloud(win)).toHaveAttribute('title', /offline-only/);
    expect(await cloudIsGreen(win)).toBe(false);
    await expect(win.getByTestId('connection-cloud')).toContainText('Blocked');
    await shot(win, 'conn-8-menu-offline-cloud-blocked');
    await win.keyboard.press('Escape');
    await shot(win, 'conn-9-offline-cloud-blocked', true);

    // The cloud chip opens its setting, which is off and greyed for the same reason.
    await cloud(win).click();
    await expect(win.locator('.set-page h1')).toHaveText('Privacy and cloud');
    await expect(win.getByRole('switch', { name: 'Allow cloud AI' })).toBeDisabled();
    await expect(win.getByRole('switch', { name: 'Offline-only workstation' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Back online from the command search: cloud AI is as it was set.
    await command(win, 'Go online');
    await expect(mode(win)).toHaveText('Online');
    await expect(cloud(win)).toHaveText('Cloud AI');
    await expect(win.getByRole('switch', { name: 'Offline-only workstation' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect.poll(() => offlineOnly(win)).toBe(false);
    await command(win, 'Work offline only');
    await expect(mode(win)).toHaveText('Offline only');
    await command(win, 'Go online');
    await expect.poll(() => offlineOnly(win)).toBe(false);
    expect(await network.outbound(), 'switching the mode made a request').toEqual([]);

    // Online with cloud AI on survives a relaunch too.
    await app.close();
    run = await start(data);
    app = run.app;
    ({ win, network } = run);
    await expect(mode(win)).toHaveText('Online');
    await expect(cloud(win)).toHaveText('Cloud AI');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app?.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('the connection pair fits the title bar at the smallest window, in its longest wording', async () => {
  const data = await createDataRoot();
  const { app, win, network } = await start(data);
  try {
    // the longest pair, "Offline only" and "Cloud AI blocked", beside a project's Share chip
    await command(win, 'Turn cloud AI on');
    await command(win, 'Work offline only');
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
    await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
    await expect(win.getByTestId('sync-chip')).toBeVisible();
    // The smallest window is 1100 wide (main/index.ts), and the title bar keeps clear of the
    // window's own buttons. A resized test viewport has no such buttons, so their room comes off.
    const buttons = await win.evaluate(() => {
      const bar = document.querySelector('.titlebar');
      return bar ? Math.ceil(parseFloat(getComputedStyle(bar).paddingRight)) : 0;
    });
    expect(buttons).toBeGreaterThan(40);
    const width = 1100 - buttons;
    await win.setViewportSize({ width, height: 700 });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
    await expect(mode(win)).toHaveText('Offline only');
    await expect(cloud(win)).toHaveText('Cloud AI blocked');

    const fit = () =>
      win.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
        const bar = document.querySelector('.titlebar');
        const pad = bar ? parseFloat(getComputedStyle(bar).paddingRight) : 0;
        const search = box('.search-btn');
        const help = box('.help-btn');
        const status = box('.tb-status');
        const pop = box('.conn-pop');
        return {
          // where the window's own buttons begin
          room: window.innerWidth - pad,
          statusRight: status?.right ?? 0,
          searchWidth: search?.width ?? 0,
          searchBeforeHelp: (search?.right ?? 0) <= (help?.left ?? 0),
          helpBeforeStatus: (help?.right ?? 0) <= (status?.left ?? 0),
          sideways: document.documentElement.scrollWidth > window.innerWidth,
          pop: pop ? { left: pop.left, right: pop.right, bottom: pop.bottom } : null,
        };
      });
    const closed = await fit();
    expect(closed.statusRight).toBeLessThanOrEqual(closed.room + 0.5);
    expect(closed.searchWidth).toBeGreaterThanOrEqual(140);
    expect(closed.searchBeforeHelp).toBe(true);
    expect(closed.helpBeforeStatus).toBe(true);
    expect(closed.sideways).toBe(false);
    await shot(win, 'conn-10-smallest-window');

    // the menu opens inside the window
    await mode(win).click();
    await expect(menu(win)).toBeVisible();
    const open = await fit();
    expect(open.pop).not.toBeNull();
    expect(open.pop?.left ?? -1).toBeGreaterThanOrEqual(0);
    expect(open.pop?.right ?? Infinity).toBeLessThanOrEqual(width);
    expect(open.pop?.bottom ?? Infinity).toBeLessThanOrEqual(700);
    expect(open.sideways).toBe(false);
    await shot(win, 'conn-11-smallest-window-menu');

    // a press outside the menu closes it
    await win.mouse.click(500, 420);
    await expect(menu(win)).toBeHidden();
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
