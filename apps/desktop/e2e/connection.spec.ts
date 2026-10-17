/**
 * The connection in the sidebar's status row: the mode chip says the real mode (Online or Offline
 * only, the offline-only setting main checks) and the cloud AI chip beside it never contradicts it.
 *
 * - The mode chip opens the Connection menu: the switch, what the mode means, Download maps and
 *   Cloud AI. Keyboard: Enter opens, Space switches, Escape closes and returns focus.
 * - Offline only: the cloud chip is never on, Download maps is off in the menu, and Offline maps
 *   greys its Download button; main refuses a download. Online: all of it is offered again. No
 *   download is started.
 * - The mode survives a relaunch, and the command search has Go online / Work offline only.
 * - At the smallest window the chips fit the sidebar's foot, the headers keep clear of the
 *   window's own buttons, and the search button and help stay.
 *
 * Everything runs behind the zero-network guard: no request leaves in either mode.
 * QUADRION_E2E_SHOTS=<folder> saves a screenshot of each chip state and of the open menu.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { captionArea } from './caption';
import { createDataRoot, expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

test.setTimeout(180_000);

const SHOTS = process.env.QUADRION_E2E_SHOTS;

/** The whole window, or only the sidebar's foot with its status row (`bar`). */
async function shot(win: Page, name: string, bar = false) {
  if (!SHOTS) return;
  const size = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await win.screenshot({
    path: join(SHOTS, `${name}.png`),
    // the menu fades in; an off-screen window draws too few frames to finish that on its own
    animations: 'disabled',
    ...(bar ? { clip: { x: 0, y: Math.max(0, size.height - 140), width: 320, height: 140 } } : {}),
  });
}

async function start(data: DataRoot) {
  const app = await launchApp(data);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('.sb-top')).toBeVisible();
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

test('the status row shows the real mode, its menu switches it, and the mode survives a relaunch', async () => {
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

test('the connection fits the sidebar foot at the smallest window, in its longest wording', async () => {
  const data = await createDataRoot();
  const { app, win, network } = await start(data);
  try {
    // the longest pair, "Offline only" and "Cloud AI blocked", with a project's Share chip open
    await command(win, 'Turn cloud AI on');
    await command(win, 'Work offline only');
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
    await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
    await expect(win.getByTestId('sync-chip')).toBeVisible();
    // The smallest window is 1100 x 700 (main/index.ts). There is no title bar: on Windows the
    // caption buttons (titleBarOverlay) sit over the top rows, and the rows keep --caption-right
    // clear for them (shell/caption.ts); on macOS the traffic lights take the sidebar's start.
    const width = 1100;
    const height = 700;
    await win.setViewportSize({ width, height });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
    await expect(mode(win)).toHaveText('Offline only');
    await expect(cloud(win)).toHaveText('Cloud AI blocked');

    const fit = async () => {
      const area = await captionArea(win);
      return win.evaluate(
        ({ caption, free }) => {
          const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
          const sidebar = box('.sidebar');
          const row = [...document.querySelectorAll('.sb-status-row > *')].map((el) =>
            el.getBoundingClientRect(),
          );
          const header = [...document.querySelectorAll('.right-head > *, .pg-head .pg-acts > *')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0);
          const search = box('.sb-search');
          const top = box('.sb-top');
          const settings = box('.sb-foot-row > .nav-item');
          const help = box('[data-testid="help-open"]');
          const pop = box('.conn-pop');
          return {
            caption,
            // where the window's own buttons begin: the room the app keeps, and the buttons drawn
            room: Math.min(window.innerWidth - caption, free),
            rowRight: Math.max(...row.map((r) => r.right)),
            sidebarRight: sidebar?.right ?? 0,
            headerRight: Math.max(0, ...header.map((r) => r.right)),
            searchInTop: !!search && !!top && search.width > 0 && search.right <= top.right + 0.5,
            helpBesideSettings: (settings?.right ?? Infinity) <= (help?.left ?? -1),
            sideways: document.documentElement.scrollWidth > window.innerWidth,
            pop: pop ? { left: pop.left, right: pop.right, bottom: pop.bottom } : null,
          };
        },
        { caption: area.kept.right, free: area.free.right },
      );
    };
    const closed = await fit();
    if (process.platform === 'win32') expect(closed.caption).toBeGreaterThan(40);
    expect(closed.rowRight).toBeLessThanOrEqual(closed.sidebarRight + 0.5);
    expect(closed.headerRight).toBeLessThanOrEqual(closed.room + 0.5);
    expect(closed.searchInTop).toBe(true);
    expect(closed.helpBesideSettings).toBe(true);
    expect(closed.sideways).toBe(false);
    await shot(win, 'conn-10-smallest-window');

    // the menu opens inside the window
    await mode(win).click();
    await expect(menu(win)).toBeVisible();
    const open = await fit();
    expect(open.pop).not.toBeNull();
    expect(open.pop?.left ?? -1).toBeGreaterThanOrEqual(0);
    expect(open.pop?.right ?? Infinity).toBeLessThanOrEqual(width);
    expect(open.pop?.bottom ?? Infinity).toBeLessThanOrEqual(height);
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
