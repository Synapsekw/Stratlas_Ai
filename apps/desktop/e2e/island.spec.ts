/**
 * The stage island, a notch (stage-island D1 to D10) in the real app: the view switch and the date
 * at rest, hover intent, Keep open, T and Esc, the group tabs, a live Distance beside the date, one
 * survey date or none, and, in the window CI
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
import { writeNoisyProject } from './cleanupHelpers';
import { DEMO_FOLDER, expect, openProject, test, TINY_PROJECT_ID } from './fixtures';
import {
  closeIslandTools,
  island,
  islandDate,
  islandGroup,
  islandRow,
  islandSettled,
  measureControl,
  openBench,
  openIslandCalendar,
  openIslandTools,
  stageMode,
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
    // the latest date, short (the year is in its name), and where it stands in the dates
    await expect(islandDate(win).locator('.isl-day')).toHaveText('13 Apr');
    await expect(islandDate(win).getByTestId('date-bar-count')).toHaveText('2 of 2');
    await expect(islandDate(win).getByTestId('date-bar-open')).toHaveAccessibleName(/13 Apr 2026/);

    await win.locator('[data-scene-view] canvas').first().focus();
    await win.keyboard.press('t');
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await expect(bar.getByRole('tab', { selected: true })).toBeFocused();
    await expect(bar.getByRole('group', { name: 'Stage view' })).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(bar).not.toHaveAttribute('data-state', 'tools');
    await expect(islandDate(win).locator('.isl-day')).toHaveText('13 Apr');
  });

  test('the pointer resting on the notch opens it; kept open, a press outside and a pick leave it open', async ({
    twoDateProject,
    win,
  }) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const bar = island(win);
    // at rest: the view switch and the date's steps, nothing to wake first
    await expect(bar).toHaveAttribute('data-state', 'rest');
    await expect(bar.getByRole('group', { name: 'Stage view' })).toBeVisible();
    await expect(bar.getByTestId('date-bar-prev')).toBeVisible();
    const canvas = await win.locator('[data-scene-view] canvas').first().boundingBox();
    if (!canvas) throw new Error('no 3D view');
    const away = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height * 0.75 };
    await win.locator('.island').hover({ position: { x: 4, y: 4 } });
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await win.mouse.move(away.x, away.y);
    await expect(bar).toHaveAttribute('data-state', 'rest');

    await openIslandTools(win);
    const pin = bar.getByRole('button', { name: 'Keep open', exact: true });
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(bar).toHaveAttribute('data-pinned', '');
    await win.mouse.click(away.x, away.y);
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await bar.getByRole('tab', { name: 'Measure', exact: true }).click();
    await expect(win.locator('#wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await expect(bar.getByRole('tabpanel')).toHaveAccessibleName('Measure');
    // let go, it closes once the pointer leaves
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await win.mouse.move(away.x, away.y);
    await expect(bar).toHaveAttribute('data-state', 'rest');
  });

  test('a click on a group tab picks it and opens its workbench in the right panel', async ({
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
      // the group's workbench opens in the right sidebar (D4, D12), and the island folds back
      await expect(bar).not.toHaveAttribute('data-state', 'tools');
      const id = name.toLowerCase();
      await expect(win.locator(`#wb-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
      await expect(
        win
          .locator(`#wb-panel-${id}`)
          .getByTestId(name === 'Measure' ? 'survey-tools' : 'display-bench'),
      ).toBeVisible();
      // the island has no full set of its own any more
      await expect(win.locator('.isl-full')).toHaveCount(0);
      // opened again, the tools show the picked group
      await openIslandTools(win);
      await expect(tab(bar, name)).toHaveAttribute('aria-selected', 'true');
      await expect(bar.getByRole('tabpanel')).toHaveAccessibleName(name);
      await closeIslandTools(win);
    }
    // by key too: Space on a group tab opens its workbench (Enter is what islandGroup uses)
    const bar = await openIslandTools(win);
    await tab(bar, 'Measure').focus();
    await win.keyboard.press('Space');
    await expect(bar).not.toHaveAttribute('data-state', 'tools');
    await expect(win.locator('#wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
  });

  test('the calendar lines up the dates beside Compare the two dates', async ({
    twoDateProject,
    win,
  }, info) => {
    // the later date already lined up, so the calendar offers both Line up dates and Remove
    const file = join(twoDateProject.dir, 'manifest.json');
    const later = twoDateProject.captures[1];
    interface Manifest {
      captures: { id: string; lineUp?: unknown }[];
    }
    const read = async () => JSON.parse(await readFile(file, 'utf8')) as Manifest;
    const manifest = await read();
    const date = manifest.captures.find((c) => c.id === later);
    if (!date) throw new Error(`no capture ${later}`);
    date.lineUp = {
      eastM: -2,
      northM: 0,
      with: twoDateProject.captures[0],
      at: '2026-10-16T08:00:00Z',
    };
    await writeFile(file, JSON.stringify(manifest, null, 2));

    await openCard(win, 'E2E two dates', twoDateProject.id);
    const cal = await openIslandCalendar(win);
    const list = island(win).locator('.isl-cal-list');
    await expect(list.getByRole('button', { name: 'Compare the two dates' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Line up dates', exact: true })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Remove line-up' })).toBeVisible();
    await expect(cal).toBeVisible();
    await shot(win, info, 'island-calendar-line-up.png');

    // Line up dates opens the line-up step for the shown date, and the island goes to rest
    await list.getByRole('button', { name: 'Line up dates', exact: true }).click();
    await expect(win.getByTestId('lineup-dialog')).toBeVisible();
    await expect(island(win)).toHaveAttribute('data-state', 'rest');
    await win.getByTestId('lineup-cancel').click();
    await expect(win.getByTestId('lineup-dialog')).toHaveCount(0);

    // Remove line-up takes the saved line-up off the date
    await openIslandCalendar(win);
    await list.getByRole('button', { name: 'Remove line-up' }).click();
    await expect(island(win)).toHaveAttribute('data-state', 'rest');
    await expect
      .poll(async () => (await read()).captures.find((c) => c.id === later)?.lineUp ?? null)
      .toBeNull();
    // no date is lined up now: the calendar offers Line up dates only
    await openIslandCalendar(win);
    await expect(list.getByRole('button', { name: 'Line up dates', exact: true })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Remove line-up' })).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(island(win)).toHaveAttribute('data-state', 'rest');
  });

  test('a live Distance shows its reading beside the date', async ({ twoDateProject, win }) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const canvas = win.locator('[data-scene-view] canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no 3D view');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await (await measureControl(win, 'survey-tool-distance')).click();
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
    // by key (I-R44): with another tab in front, the reading is a button that Space brings
    // Measure back with (while a line is drawn, Enter finishes it and Tab types a bearing)
    await openBench(win, 'issues');
    const open = island(win).getByRole('button', { name: /^Show Distance .* in the right panel$/ });
    await open.focus();
    await expect(open).toBeFocused();
    await win.keyboard.press('Space');
    await expect(win.locator('#wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
    await expect(island(win)).not.toHaveAttribute('data-state', 'tools');
    await win.locator('[data-scene-view] canvas').first().hover();
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
    // at rest, and open, no arrows and no count
    for (const open of [false, true]) {
      if (open) await openIslandTools(win);
      await expect(date.getByTestId('date-bar-prev')).toHaveCount(0);
      await expect(date.getByTestId('date-bar-next')).toHaveCount(0);
      await expect(date.getByTestId('date-bar-count')).toHaveCount(0);
    }
    await closeIslandTools(win);

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

  test('no date: the view switch alone, the tools still open, Alt+Left / Alt+Right do nothing', async ({
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
    const modes = bar.getByRole('group', { name: 'Stage view' });
    await expect(modes).toBeVisible();
    await expect(islandDate(win)).toHaveCount(0);
    await win.locator('[data-scene-view] canvas').first().focus();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    await win.keyboard.press('Alt+ArrowLeft');
    await win.keyboard.press('Alt+ArrowRight');
    await expect(islandDate(win)).toHaveCount(0);
    expect(errors).toEqual([]);
    await openIslandTools(win);
    await closeIslandTools(win);
    await expect(modes).toBeVisible();
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
    return {
      stage: box(document.querySelector('.ws > .stage')),
      capsule: box(capsule),
      // the line's and the tab row's controls: the view switch and the date; the tabs, Jobs,
      // Keep open and Close
      controls: [...document.querySelectorAll('.isl-layer > .isl-line button, .isl-tabs button')]
        // (those the narrow-stage rules leave out on purpose, the date's steps, are not drawn)
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => ({
          name: b.getAttribute('aria-label') ?? b.textContent.trim(),
          box: box(b),
        })),
      tabsScroll: (() => {
        const tabs = document.querySelector('.isl-tabs [role="tablist"]');
        return tabs ? tabs.scrollWidth - tabs.clientWidth : -1;
      })(),
      notice: box(document.querySelector('[data-testid="t-notice"]')),
      // the stage's corner overlays (D30): the dates, the status chips, the Map menu chip
      under: [...document.querySelectorAll('.stage-slot > *')].map((el) => ({
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

  test('the open island fits the stage, keeps clear of the corner overlays and never takes the centre click', async ({
    win,
  }, info) => {
    const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
    expect(Math.abs(w - 1100), `window width ${String(w)}`).toBeLessThanOrEqual(2);
    expect(Math.abs(h - 720), `window height ${String(h)}`).toBeLessThanOrEqual(2);
    // the demo with the most groups: point clouds, volumes and a video clip (paused)
    await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
    const bar = island(win);
    await expect(win.getByTestId('video-window')).toBeVisible(VIEW_READY);
    // the clip is paused, and no PAUSED chip stands on the stage (D30): the island's live line
    // and the Video workbench say what the clip does
    await expect(win.locator('.stage-slot').filter({ hasText: /paused/i })).toHaveCount(0);
    await expect(bar.getByTestId('date-row')).toBeVisible();
    expect(await centreClick(win), 'at rest').toBe('the view');
    // at rest the Map menu chip stands in a corner of its own
    await expect(win.locator('.stage-slot > .stage-basemap')).toBeVisible();

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
    // every control of the first two rows lies inside the capsule: none is cut off at its edge
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
    // (on this narrow stage the open island reaches past the middle, so the top corners are
    // kept free: what stays in the bottom corners, if anything, keeps clear of it)
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

    // the right panel folded, the stage is wider and the open island no longer reaches past the
    // middle: the top corners hold their overlays again, below the island and its notice
    await win.keyboard.press('Control+Alt+B');
    await expect(win.locator('.ws')).toHaveClass(/right-off/);
    await expect(bar).toHaveAttribute('data-state', 'tools');
    await expect(win.getByTestId('t-notice')).toBeVisible();
    // the panel slid away and the capsule has grown around its content on the wider stage
    await expect
      .poll(() =>
        win.evaluate(() => {
          const c = document.querySelector('.island')?.getBoundingClientRect().width ?? 0;
          const l = document.querySelector('.island .isl-layer')?.getBoundingClientRect().width;
          return l !== undefined && Math.abs(c - l) <= 2;
        }),
      )
      .toBe(true);
    await islandSettled(win);
    await expect(
      win.locator('.stage-slot[data-slot="tl"], .stage-slot[data-slot="tr"]').first(),
    ).toBeVisible();
    // (the corners follow the capsule on the next frame once it has grown)
    await expect
      .poll(async () => {
        const wide = await openLayout(win);
        const { notice: n, capsule: c } = wide;
        if (!n || !c) return ['no notice or capsule'];
        const held = wide.under.filter((u) => u.box !== null);
        if (held.length === 0) return ['no overlays on the stage'];
        return held
          .filter((u) => u.box && (overlap(u.box, n) || overlap(u.box, c)))
          .map((u) => `${u.name} under the T notice or the capsule`);
      })
      .toEqual([]);
    await shot(win, info, 'island-open-folded-1100.png');
    await win.keyboard.press('Control+Alt+B');
    await expect(win.locator('.ws')).not.toHaveClass(/right-off/);

    // the Volumes group's full set is the Volumes workbench (I-R19): it lies in the right panel,
    // inside the window, its one Survey date switch in view, and the centre still the view's
    const bench = await islandGroup(win, 'volumes');
    await expect(bench.getByTestId('volumes-bench')).toBeVisible();
    // under the controls, the volumes view (volumetric parity W3): every volume measurement, or
    // its empty state offering Draw volume
    const view = bench.getByTestId('volumes-view');
    await expect(
      view.locator('[data-testid="volumes-pile"], [data-testid="volumes-draw"]').first(),
    ).toBeVisible();
    await islandSettled(win);
    await shot(win, info, 'island-volumes-bench-1100.png');
    const set = await win.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0
          ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
          : null;
      };
      const panel = document.querySelector('#wb-panel-volumes');
      return {
        width: innerWidth,
        stage: box(document.querySelector('.ws > .stage')),
        panel: box(panel),
        dates: panel?.querySelectorAll('[role="group"][aria-label="Survey date"]').length ?? 0,
        controls: [...(panel?.querySelectorAll('.vol-bench-controls button') ?? [])].map((b) => ({
          name: b.getAttribute('aria-label') ?? b.textContent.trim(),
          box: box(b),
        })),
      };
    });
    expect(set.panel, 'the Volumes workbench is open').not.toBeNull();
    expect(set.dates, 'Survey date switches in the Volumes tab').toBe(1);
    expect(set.controls.length, 'controls above the inventory').toBeGreaterThan(4);
    if (set.panel && set.stage) {
      const p = set.panel;
      expect(p.left, 'the workbench starts right of the stage').toBeGreaterThanOrEqual(
        set.stage.right - 1,
      );
      expect(p.right, 'the workbench ends inside the window').toBeLessThanOrEqual(set.width);
      expect(
        set.controls
          .filter((c) => !c.box || c.box.left < p.left - 0.5 || c.box.right > p.right + 0.5)
          .map((c) => c.name),
        'Volumes controls cut off',
      ).toEqual([]);
    }
    expect(await centreClick(win), 'with the Volumes workbench open').toBe('the view');
    await expect(win.locator('.isl-full')).toHaveCount(0);
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

// opening under the pointer must not move what the pointer is on (a click would land on a
// neighbour): the line's view switch and date keep their boxes from rest to open
for (const size of ['1400x900', '1100x720'] as const) {
  test.describe(`the line keeps its place as the notch opens, ${size}`, () => {
    test.use({ appEnv: { QUADRION_WINDOW_SIZE: size } });

    test('the view switch and the date stay put, to the pixel', async ({
      twoDateProject,
      win,
    }, info) => {
      await openCard(win, 'E2E two dates', twoDateProject.id);
      const bar = island(win);
      await expect(bar).toHaveAttribute('data-state', 'rest');
      await islandSettled(win);
      const boxes = () =>
        win.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.isl-layer > .isl-line :is(.isl-modes button, [data-testid^="date-bar-"])',
            ),
          ]
            .filter((b) => b.getClientRects().length > 0)
            .map((b) => {
              const r = b.getBoundingClientRect();
              const name = b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? '';
              return { name, x: r.x, y: r.y, w: r.width, h: r.height };
            }),
        );
      const rest = await boxes();
      expect(rest.map((b) => b.name)).toEqual(expect.arrayContaining(['3D', 'Map', 'Split']));
      await shot(win, info, `notch-rest-${size}.png`);
      // the pointer rests on the notch's own edge, off its buttons
      await win.locator('.island').hover({ position: { x: 4, y: 4 } });
      await expect(bar).toHaveAttribute('data-state', 'tools');
      await islandSettled(win);
      await shot(win, info, `notch-open-${size}.png`);
      const open = await boxes();
      expect(open.map((b) => b.name)).toEqual(rest.map((b) => b.name));
      for (const [i, was] of rest.entries()) {
        const now = open[i];
        if (!now) continue;
        for (const k of ['x', 'y', 'w', 'h'] as const)
          expect(Math.abs(now[k] - was[k]), `${was.name} ${k}`).toBeLessThanOrEqual(1);
      }
    });
  });
}

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
    // the line above reads from the right too (3D first, the date after it), and Close ends the
    // tab row at its left
    const x = async (name: string, role: 'tab' | 'button') => {
      const b = await bar.getByRole(role, { name, exact: true }).boundingBox();
      return b ? b.x : Number.NaN;
    };
    const view = await x('View', 'tab');
    const measure = await x('Measure', 'tab');
    const threeD = await x('3D', 'button');
    const split = await x('Split', 'button');
    const close = await x('Close', 'button');
    const date = (await islandDate(win).boundingBox())?.x ?? Number.NaN;
    expect(measure, 'Measure lies left of View').toBeLessThan(view);
    expect(split, 'Split lies left of 3D').toBeLessThan(threeD);
    expect(date, 'the date lies left of the view switch').toBeLessThan(split);
    expect(close, 'Close is left of the tabs').toBeLessThan(measure);
    await closeIslandTools(win);
  });
});

test.describe('the quick rows (D5, I-R48)', () => {
  test('Point cloud: the colour switch RGB / Elevation / Intensity / Flight', async ({
    dataRoot,
    win,
  }, info) => {
    await writeNoisyProject(dataRoot.projectDir);
    await openCard(win, 'E2E tiny project', TINY_PROJECT_ID);
    const row = await islandRow(win, 'clouds');
    const colour = row.getByRole('group', { name: 'Colour', exact: true });
    await expect(colour.getByRole('button')).toHaveText([
      'RGB',
      'Elevation',
      'Intensity',
      'Flight',
    ]);
    await colour.getByRole('button', { name: 'Elevation', exact: true }).click();
    await expect(colour.getByRole('button', { name: 'Elevation', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const mode = () =>
      win.evaluate(
        () =>
          (
            window as unknown as {
              __stratlas: { pointcloud: { getState(): { colourMode: string } } };
            }
          ).__stratlas.pointcloud.getState().colourMode,
      );
    await expect.poll(mode).toBe('height');
    await islandSettled(win);
    // at 1100 px the row is one line: All tools does not wrap under it alone (T20 M3)
    const tiles = row.locator('.isl-tile');
    const first = await tiles.first().boundingBox();
    const all = await tiles.last().boundingBox();
    expect(Math.round(all?.y ?? -1)).toBe(Math.round(first?.y ?? -2));
    await shot(win, info, 'island-row-clouds-colour.png');
    // the workbench's own switch says the same
    const bench = await islandGroup(win, 'clouds');
    await expect(
      bench.getByRole('group', { name: 'Colour by' }).getByRole('button', { name: 'Elevation' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('Annotate: the tools on the model and the map start annotating with that tool', async ({
    twoDateProject,
    win,
  }, info) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    let row = await islandRow(win, 'annotate');
    for (const name of [
      'Pin on the model',
      'Line on the model',
      'Area on the model',
      'Point on the cloud',
      'Box on the cloud',
    ])
      await expect(row.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Point on the map' })).toHaveCount(0);
    await islandSettled(win);
    await shot(win, info, 'island-row-annotate-3d.png');

    const pin = row.getByRole('button', { name: 'Pin on the model', exact: true });
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    // the annotation tools are on, their tab live in front, with Pin picked there too
    await expect(win.locator('#wb-tab-annotate')).toHaveAttribute('aria-selected', 'true');
    const tools = win
      .locator('#wb-panel-annotate')
      .getByRole('toolbar', { name: '3D annotation tools' });
    await expect(tools.getByRole('button', { name: 'Pin', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // in Split the map's tools are there as well
    await stageMode(win, 'Split');
    row = await islandRow(win, 'annotate');
    for (const name of ['Point on the map', 'Line on the map', 'Area on the map'])
      await expect(row.getByRole('button', { name, exact: true })).toBeVisible();
    const area = row.getByRole('button', { name: 'Area on the map', exact: true });
    await area.click();
    await expect(area).toHaveAttribute('aria-pressed', 'true');
    await islandSettled(win);
    await shot(win, info, 'island-row-annotate-split.png');
    await closeIslandTools(win);
  });
});
