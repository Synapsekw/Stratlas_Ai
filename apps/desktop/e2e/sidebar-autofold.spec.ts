/**
 * In a narrow window the left sidebar folds to its 52 px rail on its own while the Scene or a data
 * screen is open (founder, 16 Oct 2026); Settings and the projects keep it open. Ctrl+B opens it,
 * and that is remembered on this machine (not a setting): after a restart it is still open.
 *
 * Every other spec pins the sidebar open (main passes `--quadrion-autofold=0` to an e2e run); this
 * one lets it fold with QUADRION_E2E_AUTOFOLD=1.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, launchApp, NetworkGuard, reportWindow, test, type DataRoot } from './fixtures';

const ENV = { QUADRION_E2E_AUTOFOLD: '1' };
/** The CI window: narrower than 1280 px, where the sidebar folds on its own. */
const SIZE: [number, number] = [1100, 720];
/** tokens.css: the sidebar and its icon rail. */
const SIDEBAR = 252;
const RAIL = 52;

interface Run {
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
}

async function start(dataRoot: DataRoot, report = false): Promise<Run> {
  const app = await launchApp(dataRoot, ENV);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // the run's window, as the fixtures report it ("[e2e] window 1100 x 720 px ..."), then the
  // CI window whatever the run's size
  if (report) await reportWindow(win);
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(w, h);
  }, SIZE);
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(SIZE[0]);
  return { app, win, network };
}

async function stop(run: Run): Promise<void> {
  const outbound = await run.network.outbound();
  await run.app.close();
  expect(outbound, 'the app made network requests').toEqual([]);
}

/** The sidebar settles at `expected` pixels wide (the fold slides for 180 ms, then snaps). */
async function expectSidebar(win: Page, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.round((await win.locator('.sidebar').boundingBox())?.width ?? -1), {
      timeout: 15_000,
    })
    .toBe(expected);
}

async function openScene(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs b')).toHaveText('Scene');
}

test('the sidebar folds to its rail in a narrow window, and stays open once reopened', async ({
  dataRoot,
}) => {
  test.setTimeout(120_000);
  const first = await start(dataRoot, true);
  try {
    const { win } = first;
    // the window is narrower than 1280 px (the CI window, 1100 x 720)
    expect(await win.evaluate(() => window.innerWidth)).toBeLessThan(1280);
    // the projects keep it open
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    await expectSidebar(win, SIDEBAR);

    // the Scene folds it to the rail, without touching the person's setting
    await openScene(win);
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await expect(win.getByTestId('panel-handle-left')).toHaveAttribute('aria-expanded', 'false');
    await expectSidebar(win, RAIL);
    expect(
      await win.evaluate(() =>
        window.aio.invoke('settings:get', {}).then((s) => s.sidebarCollapsed),
      ),
    ).toBe(false);

    // Settings has no data to make room for: open at 1100
    await win.locator('.sb-foot .nav-item', { hasText: 'Settings' }).click();
    await expect(win.locator('.crumbs b')).toHaveText('Settings');
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    await expectSidebar(win, SIDEBAR);

    // back on the Scene it folds again; Ctrl+B opens it
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    await expect(win.locator('.crumbs b')).toHaveText('Scene');
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await expectSidebar(win, RAIL);
    await win.keyboard.press('Control+B');
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    await expect(win.getByTestId('panel-handle-left')).toHaveAttribute('aria-expanded', 'true');
    await expectSidebar(win, SIDEBAR);
    // remembered on this machine, not as the setting
    const stored = await win.evaluate(() => localStorage.getItem('quadrion.panels'));
    expect(JSON.parse(stored ?? '{}') as unknown).toMatchObject({ sidebarReopened: true });
    expect(
      await win.evaluate(() =>
        window.aio.invoke('settings:get', {}).then((s) => s.sidebarCollapsed),
      ),
    ).toBe(false);
  } finally {
    await stop(first);
  }

  // after a restart the reopened sidebar is still open on the Scene
  const second = await start(dataRoot);
  try {
    const { win } = second;
    await openScene(win);
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    await expectSidebar(win, SIDEBAR);
  } finally {
    await stop(second);
  }
});
