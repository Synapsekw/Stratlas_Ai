/**
 * The smallest window, 1100 x 700 (CI runs a little taller, 1100 x 720): what only goes wrong
 * when there is little room. Asked for here, so a run at the default size covers it too.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS when it
 * names a folder.
 */
import { ONLINE_SATELLITE } from '@aio/schema';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import {
  closeIslandTools,
  island,
  islandCutOff,
  islandSettled,
  measureControl,
  openBench,
  openIslandTools,
  stageMode,
  toggleCompareDates,
} from './island';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

/** A view that was just created (the map loads its style, the 3D scene its model) takes a while. */
const VIEW_READY = { timeout: 30_000 };

/** Switch the stage with the island's view switch. */
async function showView(win: Page, view: '3D' | 'Map'): Promise<void> {
  await stageMode(win, view);
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', view === '3D' ? '3d' : 'map');
}

async function openProject(win: Page): Promise<void> {
  // the window is the smallest one (within a pixel or two: display scaling rounds)
  const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
  expect(Math.abs(w - 1100), `window width ${String(w)}`).toBeLessThanOrEqual(2);
  expect(Math.abs(h - 700), `window height ${String(h)}`).toBeLessThanOrEqual(2);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Scene');
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible(VIEW_READY);
}

/**
 * Give the window a size and wait until the page has it: the size asked for, or the nearest one
 * the display allows, which is the size the window itself reports. Returns the page's width.
 */
async function resize(app: ElectronApplication, win: Page, w: number, h: number): Promise<number> {
  await app.evaluate(
    ({ BrowserWindow }, [cw, ch]) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(cw, ch);
    },
    [w, h] as const,
  );
  await expect
    .poll(async () => {
      const window = await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentSize() ?? [],
      );
      const page = await win.evaluate(() => [innerWidth, innerHeight]);
      const same =
        window.length === 2 && window.every((n, i) => Math.abs(n - (page[i] ?? -9)) <= 1);
      return same
        ? 'the same'
        : `the window is ${window.join(' x ')}, the page ${page.join(' x ')}`;
    })
    .toBe('the same');
  return win.evaluate(() => innerWidth);
}

async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  // two frames, so what was just laid out has been drawn
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

/** The island's group tabs, and those of its first row cut off at the capsule's edge. */
async function islandTabs(win: Page) {
  const bar = await openIslandTools(win);
  const names = await bar.getByRole('tab').allTextContents();
  const cut = await islandCutOff(win);
  await closeIslandTools(win);
  return { names, cut };
}

test('the Map island shows its tools again after a visit to the 3D view', async ({ win }, info) => {
  await openProject(win);

  // the map's island: its groups, every tab in view
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  const onMap = await islandTabs(win);
  expect(onMap.cut).toEqual([]);

  // the 3D view's island, every tab in view too
  await showView(win, '3D');
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible(VIEW_READY);
  expect((await islandTabs(win)).cut).toEqual([]);

  // back on the map the island is as it was: what the 3D view showed does not stay
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  const again = await islandTabs(win);
  expect(again).toEqual(onMap);
  await openIslandTools(win);
  await shot(win, info, 'map-island-after-3d.png');
  await closeIslandTools(win);
});

/**
 * The header of the Projects screen: how far the main pane scrolls sideways (0: nothing is cut
 * off), and for each action whether it lies inside the pane and is what a click at its middle
 * reaches (not the Recent panel beside the pane).
 */
async function headerLayout(win: Page) {
  return win.evaluate(() => {
    const main = document.querySelector('.home-main');
    const acts = document.querySelector('.home-acts');
    if (!main || !acts) return null;
    const pane = main.getBoundingClientRect();
    const items = [...acts.querySelectorAll('input, button')].map((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        name: el.getAttribute('aria-label') ?? el.textContent.trim(),
        inside: r.left >= pane.left && r.right <= pane.right && r.width > 0,
        onTop: el === top || el.contains(top),
        row: Math.round(r.top + r.height / 2),
        width: Math.round(r.width),
      };
    });
    return { overflow: main.scrollWidth - main.clientWidth, items };
  });
}

test('the Projects header keeps every action in view, down to the smallest window', async ({
  app,
  win,
}, info) => {
  await expect(win.getByTestId('project-card').first()).toBeVisible();
  const names = [
    'Filter projects',
    'Recent',
    'Name',
    'New folder',
    'Open package',
    'Add project folder',
  ];

  // the smallest window: the actions wrap inside the pane, New project included
  const small = await headerLayout(win);
  expect(small?.overflow, 'the main pane scrolls sideways').toBe(0);
  expect(small?.items.map((i) => i.name)).toEqual([...names, 'New project']);
  expect(small?.items.filter((i) => !i.inside || !i.onTop)).toEqual([]);
  const add = win.locator('.home-acts').getByTestId('new-project');
  await expect(add).toBeInViewport({ ratio: 1 });
  await shot(win, info, 'projects-header-1100.png');
  // and it is the button a click reaches: the wizard opens
  await add.click();
  const wizard = win.getByTestId('new-project-wizard');
  await expect(wizard).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(wizard).toBeHidden();

  // wider windows: still nothing cut off, and from 1440 on the actions share one row as before
  for (const [w, h] of [
    [1180, 700],
    [1280, 720],
    [1440, 900],
  ] as const) {
    const got = await resize(app, win, w, h);
    const at = await headerLayout(win);
    expect(at?.overflow, `the main pane scrolls sideways at ${String(got)}`).toBe(0);
    expect(
      at?.items.filter((i) => !i.inside || !i.onTop),
      `at ${String(got)}`,
    ).toEqual([]);
    // (a screen that cannot hold a 1440 window, a CI runner's, leaves this part out)
    if (got >= 1440) {
      expect(new Set(at?.items.map((i) => i.row)).size, 'rows of actions at 1440').toBe(1);
      expect(at?.items[0]?.width, 'the filter at 1440').toBe(240);
      await shot(win, info, 'projects-header-1440.png');
    }
  }
});

// ------------------------------------------------------------------------- the live card

/** The boxes of the live card, the stage and the panels beside it, in page pixels. */
async function liveCardLayout(win: Page) {
  return win.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0
        ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        : null;
    };
    const stage = document.querySelector('.ws > .stage')?.getBoundingClientRect();
    const canvas = document.querySelector('[data-scene-view] canvas');
    const middle = stage
      ? document.elementFromPoint(stage.left + stage.width / 2, stage.top + stage.height / 2)
      : null;
    return {
      card: box('[data-testid="survey-drawbar"]'),
      stage: box('.ws > .stage'),
      right: box('.ws > aside.right'),
      // nothing of the drawing floats over the view: a click in its middle reaches it
      viewFree: canvas !== null && middle === canvas,
    };
  });
}

/** Start drawing an area from the Measure workbench: its live card shows Save and Stop. */
async function startArea(win: Page) {
  await (await measureControl(win, 'survey-tool-area')).click();
  const card = win.getByTestId('survey-drawbar');
  await expect(card).toContainText('Area');
  await expect(card.getByRole('button', { name: /^Save/ })).toBeVisible();
  return card;
}

test('the live card shown while drawing an area sits in the right panel, clear of the view', async ({
  app,
  win,
}, info) => {
  await openProject(win);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  const card = await startArea(win);

  // the smallest window: the card is in the right panel, every control in view, and the view
  // keeps all its room (D13, D18: no drawing bar over the model)
  const small = await liveCardLayout(win);
  expect(small.right, 'the right panel is open').not.toBeNull();
  expect(small.card && small.stage && small.right).toBeTruthy();
  if (!small.card || !small.stage || !small.right) return;
  expect(small.card.left).toBeGreaterThanOrEqual(small.right.left);
  expect(small.card.right).toBeLessThanOrEqual(small.right.right);
  expect(small.card.left, 'the card is beside the stage').toBeGreaterThanOrEqual(small.stage.right);
  expect(small.viewFree, 'a click in the middle of the view reaches it').toBe(true);
  for (const control of await card.getByRole('button').all())
    await expect(control).toBeInViewport({ ratio: 1 });
  await shot(win, info, 'live-card-1100.png');
  // Stop is what a click on it reaches, and it puts the tool away
  const stop = card.getByRole('button', { name: /^Stop/ });
  expect(
    await stop.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === top || el.contains(top);
    }),
  ).toBe(true);
  await stop.click();
  await expect(card).toHaveCount(0);

  // a wide window: the same card in the same place
  // (a screen that cannot hold a 1920 window, a CI runner's, leaves this part out)
  const got = await resize(app, win, 1920, 1000);
  if (got >= 1900) {
    await startArea(win);
    const wide = await liveCardLayout(win);
    expect(wide.card && wide.right && wide.card.left >= wide.right.left).toBe(true);
    expect(wide.viewFree).toBe(true);
    await shot(win, info, 'live-card-1920.png');
  }
});

// ------------------------------------------------------------------------- the foot of the map

/**
 * What is wrong at the foot of the main map: the scale bar (left), the note that no map pack is
 * installed and the credits (right) each have a box inside the map, none cut off, and no two of
 * them overlap. Empty when all is well.
 *
 * With `maps` 2, the same for both maps of Compare dates, each half as wide: the scale bar and
 * the credits of each, and its note where it shows one.
 */
async function footProblems(win: Page, maps: 1 | 2 = 1): Promise<string[]> {
  return win.evaluate((count) => {
    const found = [...document.querySelectorAll('.pane-map .aio-map')];
    if (found.length < count) return [`${String(found.length)} of ${String(count)} maps`];
    const out: string[] = [];
    for (const [n, map] of found.slice(0, count).entries()) {
      const of = count > 1 ? ` of map ${String(n + 1)}` : '';
      const frame = map.getBoundingClientRect();
      const note = map.querySelector('[data-testid="map-no-packs"]');
      const parts = {
        scale: map.querySelector('.maplibregl-ctrl-scale'),
        // the main map always has the note here; a compared map is checked with what it shows
        ...(count === 1 || note ? { note } : {}),
        credits: map.querySelector('.maplibregl-ctrl-attrib'),
      };
      const boxes: [string, DOMRect][] = [];
      for (const [name, el] of Object.entries(parts)) {
        const r = el?.getBoundingClientRect();
        if (!el || !r || r.width < 1 || r.height < 1) {
          out.push(`${name}${of} is not shown`);
          continue;
        }
        if (
          r.left < frame.left ||
          r.right > frame.right ||
          r.top < frame.top ||
          r.bottom > frame.bottom
        )
          out.push(`${name}${of} runs out of the map`);
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${name}${of} is cut off`);
        // the credits stay in the right corner, wherever the scale bar sends them
        if (name === 'credits' && Math.abs(frame.right - r.right - 10) > 2)
          out.push(`${name}${of} left the right corner`);
        boxes.push([name, r]);
      }
      for (const [i, [a, ra]] of boxes.entries())
        for (const [b, rb] of boxes.slice(i + 1))
          if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom)
            out.push(`${a} and ${b}${of} overlap`);
    }
    return out;
  }, maps);
}

/** The credits of the main map, and the button that folds them to an "i" and back. */
const credits = (win: Page) => win.locator('.pane-map .maplibregl-ctrl-attrib');
const creditsButton = (win: Page) => win.locator('.pane-map .maplibregl-ctrl-attrib-button');

/** The scale bar, the note and the credits keep apart, with the credits open and folded. */
async function expectFootApart(win: Page, state: string): Promise<void> {
  await expect(credits(win)).toHaveClass(/maplibregl-compact-show/);
  await expect.poll(() => footProblems(win), { message: `${state}, credits open` }).toEqual([]);
  await creditsButton(win).click();
  await expect(credits(win)).not.toHaveClass(/maplibregl-compact-show/);
  await expect.poll(() => footProblems(win), { message: `${state}, credits folded` }).toEqual([]);
  // open again: the credits can still be read
  await creditsButton(win).click();
  await expect(credits(win)).toHaveClass(/maplibregl-compact-show/);
  await expect.poll(() => footProblems(win), { message: `${state}, credits open` }).toEqual([]);
}

async function openMapWithoutPacks(win: Page): Promise<void> {
  await openProject(win);
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  // the tiny project's data root has no map pack: the map says so
  await expect(win.getByTestId('map-no-packs')).toHaveText(
    'No map pack installed: project layers only. Add a pack in Settings, Offline maps.',
  );
}

test('the scale bar, the no pack note and the credits keep apart at the foot of the map', async ({
  win,
}, info) => {
  await openMapWithoutPacks(win);
  await expect(credits(win)).toContainText('OpenStreetMap');
  await expectFootApart(win, 'no map pack');
  await shot(win, info, 'map-foot-no-pack.png');
});

/** Pick Sentinel-2 in the Map menu: the map draws it, with its long credit. */
async function switchOnSatellite(win: Page): Promise<void> {
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  await win.getByTestId('map-tile-s2cloudless-2016').click();
  await win
    .getByTestId('basemap-pop')
    .getByTestId('online-satellite-notice')
    .getByRole('button', { name: 'Switch on' })
    .click();
  await expect(chip).toContainText('Sentinel-2');
  // the menu's own chip closes it again
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await expect(win.getByTestId('basemap-pop')).toHaveCount(0);
  await expect(credits(win)).toContainText(ONLINE_SATELLITE.attribution, VIEW_READY);
}

test.describe('with online satellite', () => {
  // No test reaches the network: main stands in for the service (online-satellite.spec.ts), and
  // the zero-network guard of the fixtures still fails the test on any real request.
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700', QUADRION_ONLINE_TILES_TEST: '1' } });

  test('the long satellite credit keeps apart from the scale bar and the note too', async ({
    win,
  }, info) => {
    await openMapWithoutPacks(win);
    await expectFootApart(win, 'online satellite off');

    await switchOnSatellite(win);
    await expectFootApart(win, 'online satellite on');
    await shot(win, info, 'map-foot-online-satellite.png');
  });

  test('the Map menu fits the smallest window: it scrolls inside, and nothing of it is cut off', async ({
    win,
  }, info) => {
    await openMapWithoutPacks(win);
    const chip = win.getByTestId('basemap-button');
    await chip.click();
    const pop = win.getByTestId('basemap-pop');
    await expect(pop).toBeVisible();
    const box = await pop.boundingBox();
    // an Electron window has no Playwright viewport: the page's own size
    const size = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box).toBeTruthy();
    if (box) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    }
    // the footer is reachable by scrolling inside the pop
    const link = pop.getByTestId('map-sources-link');
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport({ ratio: 1 });
    await shot(win, info, 'map-menu-small-window.png');
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(chip).toBeFocused();
  });

  test('in Compare dates the open satellite credit keeps clear of each scale bar', async ({
    twoDateProject,
    win,
  }, info) => {
    expect(twoDateProject.captures).toHaveLength(2);
    await win.getByTestId('project-card').filter({ hasText: 'E2E two dates' }).click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible(VIEW_READY);
    await showView(win, 'Map');
    await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
    await switchOnSatellite(win);

    // from the Map, Compare dates shows two maps, each half the stage wide
    await toggleCompareDates(win);
    await expect(win.locator('.pane-map')).toHaveCount(2);
    await expect(credits(win)).toHaveCount(2);
    for (const credit of await credits(win).all()) {
      // as the maps open, before anything is dragged: the long credit is open in both
      await expect(credit).toContainText(ONLINE_SATELLITE.attribution, VIEW_READY);
      await expect(credit).toHaveClass(/maplibregl-compact-show/);
    }
    await expect.poll(() => footProblems(win, 2), { message: 'credits open' }).toEqual([]);
    await shot(win, info, 'compare-foot-online-satellite.png');
  });
});

// ------------------------------------------------------------------------- Volumes in front

/**
 * The stage with the widest tab in front (Volumes, 470 px): what a click at the middle of the
 * stage reaches, the rows the workbench tabs take, where the resting island lies against the
 * stage, and for each pane header of a split what lies outside its pane or under the island.
 */
async function narrowStage(win: Page) {
  return win.evaluate(() => {
    const stage = document.querySelector('.ws > .stage')?.getBoundingClientRect();
    if (!stage) return null;
    const middle = document.elementFromPoint(
      stage.left + stage.width / 2,
      stage.top + stage.height / 2,
    );
    const tabs = [...document.querySelectorAll('.ws > .right [id^="wb-tab-"]')]
      .map((t) => t.getBoundingClientRect())
      .filter((r) => r.width > 0);
    const capsule = document.querySelector('.island')?.getBoundingClientRect();
    const heads: string[] = [];
    for (const head of document.querySelectorAll('.pane-head')) {
      const pane = head.closest('[data-side]')?.getBoundingClientRect();
      const side = head.closest('[data-side]')?.getAttribute('data-side') ?? '?';
      for (const part of head.children) {
        const r = part.getBoundingClientRect();
        if (!pane || r.left < pane.left - 0.5 || r.right > pane.right + 0.5)
          heads.push(`the ${side} header leaves its pane`);
        if (capsule && r.top < capsule.bottom && capsule.top < r.bottom)
          heads.push(`the ${side} header is under the island`);
      }
    }
    return {
      width: Math.round(stage.width),
      // the 3D view's canvas takes the click, nothing laid over it
      middle: middle?.closest('[data-scene-view]')
        ? middle.tagName.toLowerCase()
        : middle?.className,
      tabRows: new Set(tabs.map((r) => Math.round(r.top))).size,
      tabs: tabs.length,
      islandIn:
        capsule !== undefined &&
        capsule.left >= stage.left &&
        capsule.right <= stage.right &&
        capsule.top >= stage.top,
      heads,
    };
  });
}

test.describe('with Volumes in front', () => {
  test.skip(
    !existsSync(join(DEMO_FOLDER, 'demo-tank-farm', 'manifest.json')),
    `no demos in ${DEMO_FOLDER}: run pnpm demo:build --quick`,
  );
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700', QUADRION_DEMO: DEMO_FOLDER } });

  test('the stage centre takes a click, the tabs keep one row and the island fits', async ({
    app,
    win,
  }, info) => {
    test.setTimeout(120_000);
    await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
    await openBench(win, 'volumes');
    for (const height of [700, 720]) {
      if (height !== 700) await resize(app, win, 1100, height);
      const size = `1100 x ${String(height)}`;
      await expect(island(win)).toHaveAttribute('data-state', 'rest');
      const at = await narrowStage(win);
      expect(at, size).not.toBeNull();
      if (!at) return;
      // the right panel at its Volumes width leaves the stage narrow, but whole
      expect(at.width, `the stage at ${size}`).toBeGreaterThanOrEqual(360);
      expect(at.middle, `a click at the middle of the stage at ${size}`).toBe('canvas');
      expect(at.tabs, `the workbench tabs at ${size}`).toBeGreaterThan(1);
      expect(at.tabRows, `rows of workbench tabs at ${size}`).toBe(1);
      expect(at.islandIn, `the island inside the stage at ${size}`).toBe(true);
      expect(await islandCutOff(win), `the open island at ${size}`).toEqual([]);
      await closeIslandTools(win);
      await islandSettled(win);
      await shot(win, info, `volumes-front-1100x${String(height)}.png`);
    }

    // Split on the same narrow stage: each pane header stays inside its pane, under the island
    await stageMode(win, 'Split');
    await closeIslandTools(win);
    await expect(win.locator('.pane-head')).toHaveCount(2);
    await expect.poll(async () => (await narrowStage(win))?.heads).toEqual([]);
    await islandSettled(win);
    await shot(win, info, 'volumes-front-split-1100x720.png');
  });
});
