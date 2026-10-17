/**
 * The stage island (stage-island D1 to D10) in the real app: the date at rest, T and Esc, the
 * group tabs, a live Distance beside the date, one survey date or none, and, in the window CI
 * runs (1100 x 720), the open island fits the stage, keeps clear of what sits under it and never
 * takes a click meant for the middle of the view. Right to left, it stays centred.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS when it
 * names a folder.
 */
import type { Locator, Page, TestInfo } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captionArea } from './caption';
import { DEMO_FOLDER, expect, openProject, test, TINY_PROJECT_ID } from './fixtures';
import {
  closeIslandTools,
  island,
  islandDate,
  islandGroup,
  openIslandTools,
  islandSettled,
} from './island';
import { openDemo } from './surveyJobs';

/** A view that was just created (the map loads its style, the 3D scene its model) takes a while. */
const VIEW_READY = { timeout: 30_000 };

async function openCard(win: Page, name: string, id: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(VIEW_READY);
  await expect.poll(async () => (await openProject(win)).id, VIEW_READY).toBe(id);
}

async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

/** What a click at the middle of the stage reaches: inside the 3D view, or what took it. */
const centreClick = (win: Page) =>
  win.evaluate(() => {
    const stage = document.querySelector('.ws > .stage');
    const r = stage?.getBoundingClientRect();
    if (!r) return 'no stage';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit?.closest('[data-scene-view]')) return 'the view';
    return hit ? `${hit.tagName.toLowerCase()}.${hit.getAttribute('class') ?? ''}` : 'nothing';
  });

test.describe('the island on a project with two dates', () => {
  test('at rest it shows the date; T opens the tools and Esc closes them', async ({
    twoDateProject,
    win,
  }) => {
    expect(twoDateProject.captures).toHaveLength(2);
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const bar = island(win);
    await expect(bar).toHaveAttribute('data-state', 'rest');
    // the latest date, short: the year is in its name
    await expect(islandDate(win).getByTestId('date-bar-open')).toHaveText('13 Apr');
    await expect(islandDate(win).getByTestId('date-bar-open')).toHaveAccessibleName(/13 Apr 2026/);

    await win.locator('[data-scene-view] canvas').first().focus();
    await win.keyboard.press('t');
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await expect(bar.getByRole('tab', { selected: true })).toBeFocused();
    await expect(bar.getByRole('group', { name: 'Stage view' })).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(bar).not.toHaveAttribute('data-state', 'tools');
    await expect(islandDate(win).getByTestId('date-bar-open')).toHaveText('13 Apr');
  });

  test('a click on a group tab picks it and opens its full set', async ({
    twoDateProject,
    win,
  }) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const tab = (bar: Locator, name: string) => bar.getByRole('tab', { name, exact: true });
    for (const name of ['Measure', 'Display']) {
      const bar = await openIslandTools(win);
      await islandSettled(win);
      // hovering shows the group's row, and the tab stays under the pointer (the first row
      // sets the island's width, whatever the row)
      const before = await tab(bar, name).boundingBox();
      await tab(bar, name).hover();
      await expect(bar.getByRole('tabpanel')).toHaveAccessibleName(name);
      await islandSettled(win);
      expect(await tab(bar, name).boundingBox()).toEqual(before);
      await tab(bar, name).click();
      // the group's full set opens under the island, and the island folds back to its line
      await expect(win.locator('.isl-full .pop-title')).toHaveText(name);
      await expect(bar).not.toHaveAttribute('data-state', 'tools');
      await win.locator('.isl-full').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(win.locator('.isl-full')).toHaveCount(0);
      // opened again, the tools show the picked group
      await openIslandTools(win);
      await expect(tab(bar, name)).toHaveAttribute('aria-selected', 'true');
      await expect(bar.getByRole('tabpanel')).toHaveAccessibleName(name);
      await closeIslandTools(win);
    }
  });

  test('a live Distance shows its reading beside the date', async ({ twoDateProject, win }) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const canvas = win.locator('[data-scene-view] canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no 3D view');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await islandGroup(win, 'measure');
    await win.getByRole('button', { name: 'Survey measurements' }).click();
    await win.getByTestId('survey-tool-distance').click();
    await expect(win.getByTestId('survey-drawbar')).toBeVisible();
    await win.mouse.click(cx, cy);
    await win.mouse.move(cx + 120, cy + 10);
    await win.keyboard.type('25');
    await expect(win.getByTestId('survey-typed-distance')).toContainText('25');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('survey-drawbar')).toContainText('2 points');

    const live = island(win).locator('[data-live="tool"]');
    await expect(live).toContainText('Distance');
    // the line so far, to the pointer: at least the typed 25 m
    await expect(live.locator('.isl-value')).toHaveText(/^\d+(\.\d+)? m$/);
    const metres = Number.parseFloat((await live.locator('.isl-value').textContent()) ?? '');
    expect(metres).toBeGreaterThanOrEqual(25);
    // beside the date, on the same line
    const date = await islandDate(win).boundingBox();
    const reading = await live.boundingBox();
    expect(date && reading).toBeTruthy();
    if (date && reading) {
      expect(reading.x).toBeGreaterThanOrEqual(date.x + date.width);
      expect(Math.abs(reading.y + reading.height / 2 - (date.y + date.height / 2))).toBeLessThan(3);
    }
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await expect(live).toHaveCount(0);
  });
});

test.describe('the island with one survey date, and with none', () => {
  test('one date: the pill without arrows, and Alt+Left / Alt+Right leave it be', async ({
    win,
  }) => {
    await openCard(win, 'E2E tiny project', TINY_PROJECT_ID);
    const date = islandDate(win);
    await expect(date.getByTestId('date-bar-open')).toHaveText('1 Jan');
    // near the pointer, and open, still no arrows and no count
    const stage = await win.locator('.ws > .stage').boundingBox();
    if (!stage) throw new Error('no stage');
    await win.mouse.move(stage.x + stage.width / 2 - 60, stage.y + 20);
    await expect(island(win)).toHaveAttribute('data-state', 'ready');
    await expect(date.getByTestId('date-bar-prev')).toHaveCount(0);
    await expect(date.getByTestId('date-bar-next')).toHaveCount(0);
    await expect(date.getByTestId('date-bar-count')).toHaveCount(0);

    await win.locator('[data-scene-view] canvas').first().focus();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    await win.keyboard.press('Alt+ArrowLeft');
    await win.keyboard.press('Alt+ArrowRight');
    await win.keyboard.press('Alt+ArrowRight');
    await expect(date.getByTestId('date-bar-open')).toHaveText('1 Jan');
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('no date: three dots, the tools still open, Alt+Left / Alt+Right do nothing', async ({
    dataRoot,
    win,
  }) => {
    // the tiny project without its survey date (the app reads the manifest when it opens it)
    const file = join(dataRoot.projectDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as { captures: unknown[] };
    manifest.captures = [];
    await writeFile(file, JSON.stringify(manifest, null, 2));

    await openCard(win, 'E2E tiny project', TINY_PROJECT_ID);
    const bar = island(win);
    await expect(bar.locator('.isl-dots')).toBeVisible();
    await expect(islandDate(win)).toHaveCount(0);
    await win.locator('[data-scene-view] canvas').first().focus();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    await win.keyboard.press('Alt+ArrowLeft');
    await win.keyboard.press('Alt+ArrowRight');
    await expect(bar.locator('.isl-dots')).toBeVisible();
    expect(errors).toEqual([]);
    await openIslandTools(win);
    await closeIslandTools(win);
    await expect(bar.locator('.isl-dots')).toBeVisible();
  });
});

/** Boxes of the open island's parts, and of what lies under the island on the stage. */
async function openLayout(win: Page) {
  return win.evaluate(() => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0
        ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        : null;
    };
    const capsule = document.querySelector('.island');
    const row = document.querySelector('.isl-r1');
    return {
      stage: box(document.querySelector('.ws > .stage')),
      capsule: box(capsule),
      // the first row's controls: the view switch, the tabs and Close
      controls: [...(row?.querySelectorAll('button') ?? [])].map((b) => ({
        name: b.getAttribute('aria-label') ?? b.textContent.trim(),
        box: box(b),
      })),
      tabsScroll: (() => {
        const tabs = row?.querySelector('[role="tablist"]');
        return tabs ? tabs.scrollWidth - tabs.clientWidth : -1;
      })(),
      notice: box(document.querySelector('[data-testid="t-notice"]')),
      under: [...document.querySelectorAll('.stage-under > *')].map((el) => ({
        name: el.className,
        box: box(el),
      })),
    };
  });
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const overlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.describe('in the window CI runs, 1100 x 720', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_DEMO: DEMO_FOLDER } });

  test('the open island fits the stage, keeps clear of the PAUSED chip and never takes the centre click', async ({
    win,
  }, info) => {
    const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
    expect(Math.abs(w - 1100), `window width ${String(w)}`).toBeLessThanOrEqual(2);
    expect(Math.abs(h - 720), `window height ${String(h)}`).toBeLessThanOrEqual(2);
    // the demo with the most groups: point clouds, volumes and a video clip (paused)
    await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
    const bar = island(win);
    await expect(win.locator('.stage-status')).toContainText('Paused', VIEW_READY);
    await expect(bar.getByTestId('date-row')).toBeVisible();
    expect(await centreClick(win), 'at rest').toBe('the view');

    // the first T: the tools and the one-time notice
    await win.locator('[data-scene-view] canvas').first().focus();
    await win.keyboard.press('t');
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await expect(win.getByTestId('t-notice')).toBeVisible();
    await islandSettled(win);
    const open = await openLayout(win);
    await shot(win, info, 'island-open-1100.png');
    expect(open.stage && open.capsule).toBeTruthy();
    if (!open.stage || !open.capsule) return;
    const { capsule, stage } = open;
    expect(capsule.left).toBeGreaterThanOrEqual(stage.left);
    expect(capsule.right).toBeLessThanOrEqual(stage.right);
    // every control of the first row lies inside the capsule: none is cut off at its right edge
    expect(open.controls.length).toBeGreaterThan(8);
    const cut = open.controls.filter(
      (c) => !c.box || c.box.left < capsule.left || c.box.right > capsule.right,
    );
    expect
      .soft(
        cut.map((c) => c.name),
        'cut off at the edge',
      )
      .toEqual([]);
    expect.soft(open.tabsScroll, 'the tabs fit without scrolling').toBe(0);
    // the notice and what lies under the island keep apart
    expect(open.notice).not.toBeNull();
    const under = open.under.filter((u) => u.box !== null);
    expect(under.map((u) => u.name).join(' ')).toContain('stage-status');
    if (open.notice) {
      const notice = open.notice;
      expect(notice.top).toBeGreaterThanOrEqual(capsule.bottom);
      expect
        .soft(
          under.filter((u) => u.box && overlap(u.box, notice)).map((u) => u.name),
          'under the T notice',
        )
        .toEqual([]);
    }
    for (const u of under)
      if (u.box) expect(overlap(u.box, capsule), `${u.name} under the capsule`).toBe(false);
    expect(await centreClick(win), 'with the tools open').toBe('the view');

    // the View group's full set, measured while it is open: inside the stage, every control in
    // it in view, and the centre still the view's
    await islandGroup(win, 'view');
    await islandSettled(win);
    const set = await win.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0
          ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
          : null;
      };
      const full = document.querySelector('.isl-full');
      return {
        stage: box(document.querySelector('.ws > .stage')),
        full: box(full),
        controls: [...(full?.querySelectorAll('button') ?? [])].map((b) => ({
          name: b.getAttribute('aria-label') ?? b.textContent.trim(),
          box: box(b),
        })),
      };
    });
    expect(set.full, 'the View set is open').not.toBeNull();
    expect(set.controls.length, 'controls in the View set').toBeGreaterThan(4);
    if (set.full && set.stage) {
      const { full: f, stage: st } = set;
      expect(f.left, 'the set starts inside the stage').toBeGreaterThanOrEqual(st.left);
      expect(f.right, 'the set ends inside the stage').toBeLessThanOrEqual(st.right);
      expect(
        set.controls
          .filter(
            (c) =>
              !c.box ||
              c.box.left < Math.max(f.left, st.left) - 0.5 ||
              c.box.right > Math.min(f.right, st.right) + 0.5,
          )
          .map((c) => c.name),
        'View set controls cut off',
      ).toEqual([]);
    }
    expect(await centreClick(win), 'with the View set open').toBe('the view');
    await win.keyboard.press('Escape');
    await expect(win.locator('.isl-full')).toHaveCount(0);
    expect(await centreClick(win), 'closed again').toBe('the view');
  });
});

test.describe('the right panel folded', () => {
  test('its toggle sits left of the window buttons, and Ctrl+J brings the agent back', async ({
    twoDateProject,
    win,
  }, info) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const toggle = win.locator('.stage-rp button');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(win.locator('.ws')).toHaveClass(/right-off/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // the panel has finished folding: the toggle is where it stays
    await expect
      .poll(() => win.locator('.ws > .right').evaluate((el) => el.getBoundingClientRect().width))
      .toBeLessThan(20);
    await shot(win, info, 'right-folded-toggle.png');
    // D28: the toggle is left of the window's own buttons, never under them (the page cannot
    // see them, so a click there would close or maximise the window)
    const area = await captionArea(win);
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const under =
        box.y < area.height && (box.x + box.width > area.free.right || box.x < area.free.left);
      expect(under, `toggle ${JSON.stringify(box)} under the buttons ${JSON.stringify(area)}`).toBe(
        false,
      );
    }
    if (process.platform === 'win32') expect(area.kept.right).toBeGreaterThan(40);

    // Ctrl+J opens the folded panel and puts the cursor in the agent
    await win.locator('[data-scene-view] canvas').first().focus();
    await win.keyboard.press('Control+j');
    await expect(win.locator('.ws')).not.toHaveClass(/right-off/);
    await expect
      .poll(() => win.evaluate(() => !!document.activeElement?.closest('.right .agent')))
      .toBe(true);
  });
});

test.describe('right to left', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

  test('the island stays centred and its tabs read from the right', async ({
    twoDateProject,
    win,
  }, info) => {
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
    await win.getByRole('button', { name: 'Right to left' }).click();
    await expect(win.locator('html')).toHaveAttribute('dir', 'rtl');
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await openCard(win, 'E2E two dates', twoDateProject.id);

    const centred = () =>
      win.evaluate(() => {
        const s = document.querySelector('.ws > .stage')?.getBoundingClientRect();
        const c = document.querySelector('.island')?.getBoundingClientRect();
        return s && c ? Math.round(c.left + c.width / 2 - (s.left + s.width / 2)) : null;
      });
    await islandSettled(win);
    await shot(win, info, 'island-rtl-rest.png');
    expect(Math.abs((await centred()) ?? 99), 'at rest, off centre by').toBeLessThanOrEqual(1);

    const bar = await openIslandTools(win);
    await islandSettled(win);
    await shot(win, info, 'island-rtl-open.png');
    expect(Math.abs((await centred()) ?? 99), 'open, off centre by').toBeLessThanOrEqual(1);
    // the content sits inside the capsule, not pushed out of it by the mirrored centring
    const inside = await win.evaluate(() => {
      const c = document.querySelector('.island')?.getBoundingClientRect();
      const l = document.querySelector('.isl-layer')?.getBoundingClientRect();
      return c && l ? l.left >= c.left - 0.5 && l.right <= c.right + 0.5 : false;
    });
    expect(inside, 'the open content lies inside the capsule').toBe(true);
    // the tabs run from the right in their own order: View rightmost, then Measure to its left;
    // the view switch is at the start (right) and Close at the end (left)
    const x = async (name: string, role: 'tab' | 'button') => {
      const b = await bar.getByRole(role, { name, exact: true }).boundingBox();
      return b ? b.x : Number.NaN;
    };
    const view = await x('View', 'tab');
    const measure = await x('Measure', 'tab');
    const threeD = await x('3D', 'button');
    const close = await x('Close', 'button');
    expect(measure, 'Measure lies left of View').toBeLessThan(view);
    expect(threeD, 'the view switch is right of the tabs').toBeGreaterThan(view);
    expect(close, 'Close is left of the tabs').toBeLessThan(measure);
    await closeIslandTools(win);
  });
});
