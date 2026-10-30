/**
 * The Wave 2 layout spike behind Ctrl+Alt+L (UI revision W4, gate G1; removed in W12). Off, the
 * shell is today's; on, the Scene shows the rail, the title bar, the four fixed right-panel tabs
 * and the bottom strip at the CI window.
 *
 * With QUADRION_SPIKE_SHOTS naming a folder (and the bundled demos built), a last test opens the
 * tank farm, the road and the change demos at 1440 x 900, 1280 x 800 and 1100 x 720, saves a
 * screenshot of each and writes the stage's share of the window, today's and the spike's, to
 * `stage-share.json` there. It is the founder's review set, not a CI check.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';

const VIEW_READY = { timeout: 60_000 };
const FLAG = 'quadrion.flags.layoutV2';

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(VIEW_READY);
}

/** Set the flag in storage and start the window again (as a restart of the app would). */
async function setSpike(win: Page, on: boolean): Promise<void> {
  await win.evaluate(
    ([key, value]) => {
      if (value) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    },
    [FLAG, on] as const,
  );
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
}

test('flag off renders today’s shell', async ({ win }) => {
  await openTiny(win);
  await expect(win.locator('.app')).not.toHaveAttribute('data-layout', 'spike');
  await expect(win.locator('aside.sidebar')).toBeVisible();
  await expect(win.getByTestId('spike-rail')).toHaveCount(0);
  await expect(win.getByTestId('spike-scene')).toHaveCount(0);
});

test('flag on renders four tabs and the rail at 1100 x 720', async ({ win }) => {
  // two project opens and two reloads
  test.setTimeout(180_000);
  await openTiny(win);
  await setSpike(win, true);
  await expect(win.locator('.app')).toHaveAttribute('data-layout', 'spike');
  await expect(win.getByTestId('spike-rail')).toBeVisible();
  await expect(win.locator('aside.sidebar')).toHaveCount(0);
  // the library shows inside the spike's frame; the project opens in the new Scene
  await win.getByTestId('spike-rail-projects').click();
  await openTiny(win);
  await expect(win.getByTestId('spike-scene')).toBeVisible();
  await expect(win.getByTestId('spike-title')).toBeVisible();

  const tabs = win.getByTestId('spike-tabs').getByRole('tab');
  await expect(tabs).toHaveText([/Selection/, /Tools/, /Layers & display/, /Project/]);
  // the panel keeps its width whichever tab is in front
  const panel = win.getByTestId('spike-right');
  const widths = new Set<number>();
  for (const name of ['Tools', 'Layers & display', 'Project', 'Selection']) {
    await tabs.filter({ hasText: name }).click();
    widths.add(Math.round((await panel.boundingBox())?.width ?? 0));
  }
  expect([...widths]).toHaveLength(1);

  // below 1280 px: rail 52, the panel docked at 300 px pushing the stage, Layers closed
  const w = await win.evaluate(() => innerWidth);
  if (w < 1280) {
    expect([...widths][0]).toBe(300);
    expect(Math.round((await win.getByTestId('spike-rail').boundingBox())?.width ?? 0)).toBe(52);
    await expect(win.getByTestId('spike-scene')).toHaveAttribute('data-layers', 'closed');
    // Layers opens over the stage and Escape closes it
    await win.getByTestId('spike-layers-toggle').click();
    await expect(win.getByTestId('spike-layers')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('spike-layers')).toHaveCount(0);
  }

  // the island opens on click only, never on hover
  await win.getByTestId('spike-island').hover();
  await expect(win.getByTestId('spike-mode-measure')).toHaveCount(0);
  await win.getByTestId('spike-island-open').click();
  await expect(win.getByTestId('spike-mode-measure')).toBeVisible();
  await win.getByTestId('spike-mode-measure').click();
  await expect(tabs.filter({ hasText: 'Tools' })).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('spike-section-tools.measure')).toHaveAttribute('data-open', 'true');

  // Ctrl+Alt+L brings today's shell back, in place
  await win.keyboard.press('Control+Alt+L');
  await expect(win.locator('aside.sidebar')).toBeVisible(VIEW_READY);
  await expect(win.getByTestId('spike-rail')).toHaveCount(0);
});

// ---------------------------------------------------------------- the founder's review set

const SHOTS = process.env.QUADRION_SPIKE_SHOTS;
const DEMOS = [
  { id: 'demo-tank-farm', name: 'Demo tank farm', preset: 'survey', file: 'tank' },
  { id: 'demo-access-road', name: 'Demo access road', preset: '', file: 'road' },
  { id: 'demo-change-site', name: 'Demo change site (2 dates)', preset: '', file: 'change' },
] as const;
const SIZES = [
  [1440, 900],
  [1280, 800],
  [1100, 720],
] as const;

async function resize(app: ElectronApplication, win: Page, w: number, h: number): Promise<void> {
  // the window has no title bar, so its size is the page's; where the display still adds a
  // frame, ask again by the difference until the page is the size the review needs
  let ask: [number, number] = [w, h];
  for (let i = 0; i < 4; i++) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
      const bw = BrowserWindow.getAllWindows()[0];
      // the minimum (1100 x 700) holds the outer frame, which some displays draw 16 px wide
      bw?.setMinimumSize(800, 600);
      bw?.setSize(cw, ch);
    }, ask);
    await win.waitForTimeout(400);
    const [pw, ph] = await win.evaluate(() => [innerWidth, innerHeight] as const);
    if (pw === w && ph === h) break;
    ask = [ask[0] + w - pw, ask[1] + h - ph];
  }
  expect(await win.evaluate(() => [innerWidth, innerHeight])).toEqual([w, h]);
  // the layout and the views settle
  await win.waitForTimeout(800);
}

/** The stage's width over the window's, in per cent, from the DOM. */
async function stageShare(win: Page, selector: string): Promise<number> {
  return win.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round((el.getBoundingClientRect().width / innerWidth) * 1000) / 10 : -1;
  }, selector);
}

async function openDemoCard(win: Page, name: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect
    .poll(
      () => win.evaluate(() => document.querySelector('[data-scene-view]') !== null),
      VIEW_READY,
    )
    .toBe(true);
  await win.waitForTimeout(2500);
}

test.describe('review set', () => {
  test.skip(!SHOTS, 'QUADRION_SPIKE_SHOTS names the folder for the founder’s screenshots');
  test.skip(
    !existsSync(join(DEMO_FOLDER, 'demo-tank-farm', 'manifest.json')),
    `no bundled demos in ${DEMO_FOLDER}`,
  );
  test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });
  test.setTimeout(15 * 60_000);

  test('screenshots at three sizes for three demos', async ({ app, win }) => {
    const dir = SHOTS ?? '';
    await mkdir(dir, { recursive: true });
    const shares: Record<string, Record<string, { today: number; spike: number }>> = {};
    const library = async () => {
      const rail = win.getByTestId('spike-rail-projects');
      if (await rail.count()) await rail.click();
      else await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
    };
    for (const demo of DEMOS) {
      shares[demo.file] = {};
      // today's layout first, for the comparison
      await setSpike(win, false);
      await library();
      await openDemoCard(win, demo.name);
      for (const [w, h] of SIZES) {
        await resize(app, win, w, h);
        (shares[demo.file] ??= {})[`${String(w)}x${String(h)}`] = {
          today: await stageShare(win, '.ws > .stage'),
          spike: -1,
        };
      }
      // then the spike, with the preset the review asks for
      await setSpike(win, true);
      await library();
      await openDemoCard(win, demo.name);
      await expect(win.getByTestId('spike-scene')).toBeVisible(VIEW_READY);
      if (demo.preset) await win.getByTestId('spike-preset').selectOption(demo.preset);
      for (const [w, h] of SIZES) {
        await resize(app, win, w, h);
        const size = `${String(w)}x${String(h)}`;
        const entry = shares[demo.file]?.[size];
        if (entry) entry.spike = await stageShare(win, '.spk-stage-cell');
        // no focus ring or tip left over from the clicks above
        await win.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
        });
        await win.screenshot({ path: join(dir, `${demo.file}-${size}.png`) });
      }
    }
    // the island opened on Measure and the video popped out, on the tank farm at 1280 x 800
    await library();
    await openDemoCard(win, DEMOS[0].name);
    await win.getByTestId('spike-preset').selectOption('survey');
    await resize(app, win, 1280, 800);
    const popOut = win.getByTestId('spike-video-popout');
    if (await popOut.count()) await popOut.click();
    await win.getByTestId('spike-island-open').click();
    await win.getByTestId('spike-mode-measure').click();
    await win.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await win.waitForTimeout(800);
    await win.screenshot({ path: join(dir, 'tank-1280x800-island-popout.png') });
    await writeFile(join(dir, 'stage-share.json'), `${JSON.stringify(shares, null, 2)}\n`);
    await setSpike(win, false);
  });
});
