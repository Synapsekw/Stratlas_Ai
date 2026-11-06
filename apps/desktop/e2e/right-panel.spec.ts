/**
 * The right panel's four fixed tabs (UI revision W7, D2): Selection, Tools, Layers & display and
 * Project, always on one row, none pinned, closed or moved to "More tabs"; each tab a list of
 * sections; one width per window band that no tab or section changes.
 *
 * With QUADRION_PANEL_SHOTS naming a folder, a last test saves the tank farm at 1440 x 900,
 * 1280 x 800 and 1100 x 720 and writes the stage's share of the window to `stage-share.json`
 * there (the review set, not a CI check).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { expectNoClippedText } from './layoutGuards';
import { openBench, openSection, panelSection, panelTab } from './panel';
import { openDemo } from './surveyJobs';

const VIEW_READY = { timeout: 60_000 };

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(VIEW_READY);
}

const panelWidth = async (win: Page): Promise<number> =>
  Math.round((await win.locator('.ws > .right').boundingBox())?.width ?? 0);

test('four tabs, no overflow, width unchanged across tabs at 1100 x 720', async ({ win }) => {
  test.setTimeout(120_000);
  await openTiny(win);
  const side = win.locator('.ws > .right');
  const tabs = side.locator('[id^="wb-tab-"]');
  await expect(tabs).toHaveText([/^Selection/, /^Tools/, /^Layers & display/, /^Project/]);
  await expect(side.getByRole('button', { name: 'More tabs', exact: true })).toHaveCount(0);
  // every tab sits on the row, inside the panel, its name not cut off
  const box = await side.boundingBox();
  for (const tab of await tabs.all()) {
    const b = await tab.boundingBox();
    expect(b).not.toBeNull();
    if (!b || !box) continue;
    expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(
      await tab.evaluate((el) => {
        const label = el.querySelector('.tab-label') ?? el;
        return label.scrollWidth <= label.clientWidth + 1;
      }),
    ).toBe(true);
  }
  // no pin and no close on any of them
  await expect(side.getByRole('button', { name: /^(Pin|Close) / })).toHaveCount(0);

  // below 1280 px the panel is docked at 300 px, whichever tab or section is in front
  const widths = new Set<number>();
  for (const name of ['tools', 'layers', 'project', 'selection'] as const) {
    await panelTab(win, name).click();
    await expect(panelTab(win, name)).toHaveAttribute('aria-selected', 'true');
    widths.add(await panelWidth(win));
  }
  await openSection(win, 'project', 'project.jobs');
  widths.add(await panelWidth(win));
  await openSection(win, 'tools', 'tools.environment');
  widths.add(await panelWidth(win));
  expect([...widths]).toEqual([300]);
});

test('the sections of each tab: Measure in Tools, In this project and Issues in Project', async ({
  win,
}) => {
  test.setTimeout(120_000);
  await openTiny(win);
  // Tools: the Measure catalogue opens in its section
  const measure = await openSection(win, 'tools', 'tools.measure');
  await expect(
    measure.getByRole('group', { name: 'Measure tools' }).or(measure.locator('.meb')),
  ).toBeVisible();
  // Layers & display: Display
  const display = await openSection(win, 'layers', 'layers.display');
  await expect(display.locator('.wb-bench, .wb-scroll').first()).toBeVisible();
  // Project: In this project, then the Issues summary with Open in Issues
  const list = await openSection(win, 'project', 'project.inThisProject');
  await expect(list.getByTestId('project-list')).toBeVisible();
  const issues = await openSection(win, 'project', 'project.issues');
  await expect(issues.getByTestId('issues-summary')).toBeVisible();
  await expect(issues.getByRole('button', { name: 'Open in Issues' })).toBeVisible();
  // a section folds from its header and its body leaves
  await panelSection(win, 'project.issues').locator(':scope > .wb-section-head').click();
  await expect(panelSection(win, 'project.issues')).toHaveAttribute('data-open', 'false');
  await expect(issues.getByTestId('issues-summary')).toHaveCount(0);
  // Selection with nothing picked says what to do
  await panelTab(win, 'selection').click();
  await expect(win.locator('.ws > .right').getByTestId('selection-empty')).toHaveText(
    'Click something on the site.',
  );
});

// ------------------------------------------------------- the review set (not a CI check)

const SHOTS = process.env.QUADRION_PANEL_SHOTS;
const SIZES = [
  [1440, 900],
  [1280, 800],
  [1100, 720],
] as const;

async function resize(app: ElectronApplication, win: Page, w: number, h: number): Promise<void> {
  let ask: [number, number] = [w, h];
  for (let i = 0; i < 4; i++) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
      const bw = BrowserWindow.getAllWindows()[0];
      bw?.setMinimumSize(800, 600);
      bw?.setSize(cw, ch);
    }, ask);
    await win.waitForTimeout(400);
    const [pw, ph] = await win.evaluate(() => [innerWidth, innerHeight] as const);
    if (pw === w && ph === h) break;
    ask = [ask[0] + w - pw, ask[1] + h - ph];
  }
  expect(await win.evaluate(() => [innerWidth, innerHeight])).toEqual([w, h]);
  await win.waitForTimeout(800);
}

test.describe('beside the handle', () => {
  test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });

  test('Selection and Surface and piles keep their text whole at 1100 x 720 beside the handle gutter', async ({
    win,
  }) => {
    test.setTimeout(120_000);
    await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
    // the panel body keeps the handle's gutter at its start edge
    const gutter = await win.evaluate(() => {
      const body = document.querySelector('.ws > .right > .rp-split');
      return body ? getComputedStyle(body).paddingInlineStart : '';
    });
    expect(gutter).toBe('12px');
    // Layers & display: the Show control's section
    const show = await openSection(win, 'layers', 'layers.show');
    await expect(show.getByTestId('stage-show')).toBeVisible();
    await expectNoClippedText(
      win,
      ['.ws > .right [data-section="layers.show"] :is(button, .stage-show-cap, .wb-section-title)'],
      'Surface and piles text cut',
    );
    // a pile from the Volumes list opens in Selection
    const volumes = await openBench(win, 'volumes');
    await volumes.getByTestId('volumes-pile').first().click();
    await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
    const panel = win.getByTestId('pile-panel');
    await expect(panel).toBeVisible();
    await expectNoClippedText(
      win,
      [
        '.ws > .right #wb-panel-selection :is(button, label, h2, h3, h4, dt, dd, th, td)',
        '.ws > .right [data-testid="pile-name"]',
      ],
      'Selection text cut',
    );
  });
});

test.describe('review set', () => {
  test.skip(!SHOTS, 'QUADRION_PANEL_SHOTS names the folder for the screenshots');
  // the bundled demos in the library
  test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });
  test('the tank farm at three sizes, with the stage share', async ({ app, win }) => {
    test.setTimeout(300_000);
    const dir = SHOTS ?? '';
    await mkdir(dir, { recursive: true });
    await win.getByTestId('project-card').filter({ hasText: 'Demo tank farm' }).first().click();
    await expect(win.locator('[data-scene-view]').first()).toBeVisible(VIEW_READY);
    await win.waitForTimeout(2500);
    const shares: Record<string, { stage: number; panel: number; share: number }> = {};
    for (const [w, h] of SIZES) {
      await resize(app, win, w, h);
      for (const tab of ['project', 'tools'] as const) {
        await panelTab(win, tab).click();
        await win.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
        });
        await win.waitForTimeout(400);
        await win.screenshot({ path: join(dir, `tank-${tab}-${String(w)}x${String(h)}.png`) });
      }
      const stage = Math.round((await win.locator('.ws > .stage').boundingBox())?.width ?? 0);
      shares[`${String(w)}x${String(h)}`] = {
        stage,
        panel: await panelWidth(win),
        share: Math.round((stage / w) * 1000) / 10,
      };
    }
    await writeFile(join(dir, 'stage-share.json'), `${JSON.stringify(shares, null, 2)}\n`);
  });
});
