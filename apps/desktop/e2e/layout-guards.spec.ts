/**
 * Layout guards (UI revision W1d): the windows the app must fit, the smallest (1100 x 720, the CI
 * window) and a common laptop (1366 x 768). At each: the scene as it opens, Compare dates, the
 * footage strip, the project switcher and Settings > Processing tools and Keyboard. Each asserts
 * that no listed text is cut (`scrollWidth > clientWidth + 1`) and that the island lies inside the
 * stage. Boxes only, no pixel snapshots (WARP renders differ).
 *
 * A clicked pile in Selection (founder condition: Selection text never clips) is read at 1100, 1280
 * and 1440 px wide on the synthetic quarry, with the pipeline Python; it skips without it.
 *
 * The footage and switcher tests use the bundled demos (`pnpm demo:build --quick`) and skip
 * without them. Screenshots go to QUADRION_E2E_SHOTS when it names a folder. Zero network.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEMO_FOLDER,
  expect,
  hasPipelinePython,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import { closeIslandTools, island, islandSettled, toggleCompareDates, volumesView } from './island';
import { expectNoClippedText, islandProblems, overlaps, spillsDown } from './layoutGuards';
import { panelTab, selectedPile } from './panel';
import { headerProblems } from './split';
import { openDemo } from './surveyJobs';

const SIZES = ['1100x720', '1366x768'] as const;
const VIEW_READY = { timeout: 60_000 };
const HAS_DEMOS = existsSync(join(DEMO_FOLDER, 'demo-tank-farm', 'manifest.json'));

/**
 * The shell's own text: the project's name and its customer in the title bar's breadcrumb, the
 * Layers column's rows, the right panel's tabs. (Text only: an icon button's tip is absolutely
 * placed inside it and would read as cut; the rail's names are read out, never drawn.)
 */
const SHELL_TEXT = [
  '.proj-switch > b',
  '.tb-crumb-customer',
  '.sidebar .nav-item .lbl',
  '.ws > .right [id^="wb-tab-"]',
];

async function shot(win: Page, size: string, name: string): Promise<void> {
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await win.screenshot({ path: join(dir, `layout-${size}-${name}.png`) });
}

/** The page is the size asked for (within a pixel or two: display scaling rounds). */
async function expectSize(win: Page, size: string): Promise<void> {
  const [w, h] = size.split('x').map(Number);
  const [iw, ih] = await win.evaluate(() => [innerWidth, innerHeight]);
  expect(Math.abs(iw - (w ?? 0)), `window width ${String(iw)}`).toBeLessThanOrEqual(2);
  expect(Math.abs(ih - (h ?? 0)), `window height ${String(ih)}`).toBeLessThanOrEqual(2);
}

async function openProject(win: Page, name: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect(win.locator('.proj-switch')).toContainText(name);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(VIEW_READY);
}

/** The island resting, settled, inside the stage and whole. */
async function expectIslandFits(win: Page): Promise<void> {
  await closeIslandTools(win);
  await expect(island(win)).toHaveAttribute('data-state', 'rest');
  await islandSettled(win);
  await expect.poll(() => islandProblems(win)).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`at ${size}`, () => {
    test.use({ appEnv: { QUADRION_WINDOW_SIZE: size } });

    test('the scene as it opens: the shell text whole, the island in the stage', async ({
      win,
    }) => {
      await expectSize(win, size);
      await openProject(win, 'E2E tiny project');
      await expectIslandFits(win);
      await expectNoClippedText(win, SHELL_TEXT, 'shell text cut');
      await shot(win, size, 'scene');
    });

    test('Compare dates: the island and its controls in the stage, both dates whole', async ({
      twoDateProject,
      win,
    }) => {
      expect(twoDateProject.captures).toHaveLength(2);
      await expectSize(win, size);
      await openProject(win, 'E2E two dates');
      // the Low tier (a CI runner's software GPU, pinned here whatever the GPU): Compare dates
      // shows the two dates on maps with its notice, the busiest the panes get
      await win.evaluate(() => {
        (
          window as unknown as {
            __stratlas: { graphics(): { getState(): { setOverride(t: string): void } } };
          }
        ).__stratlas
          .graphics()
          .getState()
          .setOverride('low');
      });
      await toggleCompareDates(win);
      await expect(win.getByTestId('pane-chooser-right')).toBeVisible();
      // what is measured below is there to measure
      await expect(win.locator('.pane-map')).toHaveCount(2);
      await expect(win.locator('.pane-date-t')).toHaveCount(2);
      for (const date of await win.locator('.pane-date-t').all()) await expect(date).toBeVisible();
      await expect(win.getByTestId('compare-notice')).toBeVisible();
      await expect(win.getByTestId('map-no-packs').first()).toBeVisible(VIEW_READY);
      // Compare's warning is a status bar: it stands in the tool stack at the top left (W10)
      await expect(win.locator('.stage-slot:has(.compare-notice) > *').first()).toBeVisible();
      await expectIslandFits(win);
      await expect.poll(() => headerProblems(win)).toEqual([]);
      await expectNoClippedText(win, [...SHELL_TEXT, '.pane-date-t'], 'compare text cut');
      // what the panes show at their corners keeps apart, and a wrapped notice grows with its text
      await expect
        .poll(() =>
          overlaps(win, [
            '[data-testid^="pane-chooser-"] > *',
            '.compare-notice',
            '[data-testid="map-no-packs"]',
            '.stage-slot > *',
            '.maplibregl-ctrl-scale',
            '.maplibregl-ctrl-attrib',
          ]),
        )
        .toEqual([]);
      expect(await spillsDown(win, ['.compare-notice'])).toEqual([]);
      await shot(win, size, 'compare');
    });

    test('Settings, Processing tools and Keyboard: headings, sections and rows whole', async ({
      win,
    }) => {
      await expectSize(win, size);
      await win.locator('.nav-item', { hasText: 'Settings' }).click();
      const nav = win.getByRole('navigation', { name: 'Settings sections' });
      for (const page of ['Processing tools', 'Keyboard']) {
        await nav.locator('button', { hasText: page }).click();
        await expect(win.locator('.set-page h1')).toHaveText(page);
        await expectNoClippedText(
          win,
          ['.set-nav button', '.set-page h1', '.set-page h2', '.set-page h3', '.keymap th'],
          `${page} text cut`,
        );
        // nothing on the page is wider than the page
        const wide = await win.locator('.set-body').evaluate((body) => {
          const right = body.getBoundingClientRect().right;
          return [...body.querySelectorAll<HTMLElement>('*')]
            .filter(
              (el) => el.getBoundingClientRect().right > right + 1 && el.offsetParent !== null,
            )
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
            .slice(0, 5);
        });
        expect(wide, `${page} scrolls sideways`).toEqual([]);
        await shot(win, size, `settings-${page.toLowerCase().replace(' ', '-')}`);
      }
    });

    test.describe('with the bundled demos', () => {
      test.skip(!HAS_DEMOS, `no demos in ${DEMO_FOLDER}: run pnpm demo:build --quick`);
      test.use({ appEnv: { QUADRION_WINDOW_SIZE: size, QUADRION_DEMO: DEMO_FOLDER } });

      test('the project switcher shows every name whole', async ({ win }) => {
        await expectSize(win, size);
        await openProject(win, 'E2E tiny project');
        await win.locator('.proj-switch').click();
        const menu = win.getByTestId('project-switcher');
        await expect(menu).toBeVisible();
        await expect
          .poll(() => menu.locator(':is(.menu-name, .row-label)').count())
          .toBeGreaterThan(3);
        await expectNoClippedText(
          win,
          ['[data-testid="project-switcher"] :is(.menu-name, .row-label)'],
          'project names cut',
        );
        // the menu itself lies inside the window
        const box = await menu.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(Number(size.split('x')[1]) + 1);
        }
        await shot(win, size, 'switcher');
      });

      test('the footage strip: the clock and its bar whole, the island in the stage', async ({
        win,
      }) => {
        await expectSize(win, size);
        await openProject(win, 'Demo tank farm');
        const footage = win.getByTestId('bottom-switch-footage');
        const clock = win.getByTestId('timecode');
        await expect(footage).toBeVisible(VIEW_READY);
        // the strip may settle on its remembered side as the project opens: pick Footage until
        // the clock shows
        await expect(async () => {
          if ((await footage.getAttribute('aria-pressed')) !== 'true') await footage.click();
          await expect(clock).toHaveText(/^\d\d:\d\d:\d\d\.\d\d$/, { timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await expectNoClippedText(
          win,
          [...SHELL_TEXT, '[data-testid="timecode"]', '[data-testid^="bottom-switch-"]'],
          'footage text cut',
        );
        // nothing of the clock's bar spills out of it
        const spill = await clock.evaluate((el) => {
          const bar = el.parentElement?.getBoundingClientRect();
          return [...(el.parentElement?.children ?? [])]
            .filter((c) => c.getBoundingClientRect().right > (bar?.right ?? 0) + 0.5)
            .map((c) => c.className);
        });
        expect(spill, 'the footage bar spills').toEqual([]);
        await expectIslandFits(win);
        await shot(win, size, 'footage');
      });
    });
  });
}

/** Resize the window until the page is `w` x `h` (a display may add a frame to the outer size). */
async function resize(app: ElectronApplication, win: Page, w: number, h: number): Promise<void> {
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

test.describe('a clicked pile in Selection', () => {
  test.use({ appEnv: PIPELINE_ENV });
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

  test('reads whole inside the right panel at 1100, 1280 and 1440 px, and so do the Volumes figures', async ({
    quarryProject,
    app,
    win,
  }) => {
    test.setTimeout(10 * 60_000);
    await openDemo(win, quarryProject.name, quarryProject.id);
    await expect((await volumesView(win)).getByTestId('volumes-pile')).toHaveCount(4, {
      timeout: 120_000,
    });
    // every survey prepared, so the figures are the real ones (pile-panel.spec.ts)
    const strip = win.getByRole('region', { name: 'Survey dates chart' });
    await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
      timeout: 360_000,
    });
    const right = win.locator('.ws > .right');

    /** Every box `sel` finds lies inside the right panel, `pad` px clear of its left edge. */
    const inside = async (sel: string, pad: number) => {
      const box = await right.boundingBox();
      if (!box) throw new Error('no right panel');
      const boxes = await win.evaluate(
        (q) =>
          [...document.querySelectorAll(q)]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, text: el.textContent.slice(0, 40) };
            }),
        sel,
      );
      expect(boxes.length, sel).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.left, `${sel} "${b.text}" left`).toBeGreaterThanOrEqual(box.x + pad);
        expect(b.right, `${sel} "${b.text}" right`).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
    };

    for (const [w, h] of [
      [1100, 720],
      [1280, 800],
      [1440, 900],
    ] as const) {
      await resize(app, win, w, h);
      // a picked pile brings Selection forward: back to Project > Volumes each time
      const view = await volumesView(win);
      await expect(view.getByTestId('volumes-kpi')).toBeVisible();
      await expectNoClippedText(win, ['[data-testid="volumes-kpi"] b'], 'Volumes figures cut');
      await view.getByTestId('volumes-pile').filter({ hasText: 'Stockpile SP1' }).click();
      await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
      const pile = selectedPile(win);
      await expect(pile).toBeVisible();
      await expect(pile.getByTestId('pile-name')).toHaveText('Stockpile SP1');
      // no text meets the panel's left edge (its drag handle lies over the first 4 px)
      await inside(
        '.ws > .right #wb-panel-selection [data-testid="pile-panel"] :is(h2, h3, p, button, b)',
        8,
      );
      await expectNoClippedText(win, ['[data-testid="pile-kpi"] b'], 'pile figures cut');
      await shot(win, `${String(w)}x${String(h)}`, 'selection-pile');
      await pile.getByRole('button', { name: /Inventory/ }).click();
      await expect(pile).toHaveCount(0);
    }
  });
});
