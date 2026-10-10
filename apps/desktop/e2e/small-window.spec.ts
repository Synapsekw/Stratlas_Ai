/**
 * The smallest window, 1100 x 700 (the size the CI runners give the app): what only goes wrong
 * when there is little room. Asked for here, so a run at the default size covers it too.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS when it
 * names a folder.
 */
import { ONLINE_SATELLITE } from '@aio/schema';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

/** A view that was just created (the map loads its style, the 3D scene its model) takes a while. */
const VIEW_READY = { timeout: 30_000 };

const stageBar = (win: Page) => win.getByRole('toolbar', { name: 'Stage tools' });

/** Switch the stage with its view switch (the one control of that name on the toolbar). */
async function showView(win: Page, view: '3D' | 'Map'): Promise<void> {
  const button = stageBar(win)
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name: view, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', view === '3D' ? '3d' : 'map');
}

async function openProject(win: Page): Promise<void> {
  // the window is the smallest one (within a pixel or two: display scaling rounds)
  const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
  expect(Math.abs(w - 1100), `window width ${String(w)}`).toBeLessThanOrEqual(2);
  expect(Math.abs(h - 700), `window height ${String(h)}`).toBeLessThanOrEqual(2);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs b')).toHaveText('Scene');
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

test('the Map toolbar shows its tools again after a visit to the 3D view', async ({
  win,
}, info) => {
  await openProject(win);
  const bar = stageBar(win);
  const layers = bar.getByRole('button', { name: 'Layers and issue pins', exact: true });
  const more = bar.getByRole('button', { name: 'More tools', exact: true });

  // the map's toolbar fits the stage: every group on the bar, nothing folded
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  await expect(layers).toBeVisible();
  await expect(more).toHaveCount(0);

  // the 3D view has more tools than fit: Labels and layers is the first group to fold
  await showView(win, '3D');
  await expect(bar.getByRole('button', { name: 'Environment and time of day' })).toBeVisible(
    VIEW_READY,
  );
  await expect(more).toBeVisible();
  await expect(layers).toHaveCount(0);

  // back on the map the bar is as it was: what the 3D view folded does not stay folded
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  await expect(layers).toBeVisible();
  await expect(more).toHaveCount(0);
  await shot(win, info, 'map-toolbar-after-3d.png');
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
  const names = ['Filter projects', 'Recent', 'Name', 'Open package', 'Add project folder'];

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

// ------------------------------------------------------------------------- the foot of the map

/**
 * What is wrong at the foot of the main map: the scale bar (left), the note that no map pack is
 * installed and the credits (right) each have a box inside the map, none cut off, and no two of
 * them overlap. Empty when all is well.
 */
async function footProblems(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const map = document.querySelector('.pane-map .aio-map');
    if (!map) return ['no map'];
    const frame = map.getBoundingClientRect();
    const parts = {
      scale: map.querySelector('.maplibregl-ctrl-scale'),
      note: map.querySelector('[data-testid="map-no-packs"]'),
      credits: map.querySelector('.maplibregl-ctrl-attrib'),
    };
    const out: string[] = [];
    const boxes: [string, DOMRect][] = [];
    for (const [name, el] of Object.entries(parts)) {
      const r = el?.getBoundingClientRect();
      if (!el || !r || r.width < 1 || r.height < 1) {
        out.push(`${name} is not shown`);
        continue;
      }
      if (
        r.left < frame.left ||
        r.right > frame.right ||
        r.top < frame.top ||
        r.bottom > frame.bottom
      )
        out.push(`${name} runs out of the map`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${name} is cut off`);
      boxes.push([name, r]);
    }
    for (const [i, [a, ra]] of boxes.entries())
      for (const [b, rb] of boxes.slice(i + 1))
        if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom)
          out.push(`${a} and ${b} overlap`);
    return out;
  });
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

test.describe('with online satellite', () => {
  // No test reaches the network: main stands in for the service (online-satellite.spec.ts), and
  // the zero-network guard of the fixtures still fails the test on any real request.
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700', QUADRION_ONLINE_TILES_TEST: '1' } });

  test('the long satellite credit keeps apart from the scale bar and the note too', async ({
    win,
  }, info) => {
    await openMapWithoutPacks(win);
    await expectFootApart(win, 'online satellite off');

    // switched on in the map type picker: the map draws it, with the service's long credit
    const chip = win.getByTestId('basemap-button');
    await chip.click();
    await win.getByTestId('basemap-online').click();
    await win
      .getByTestId('basemap-pop')
      .getByTestId('online-satellite-notice')
      .getByRole('button', { name: 'Switch on' })
      .click();
    await expect(chip).toHaveText('Satellite');
    // the picker's own button closes it again
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(win.getByTestId('basemap-pop')).toHaveCount(0);
    await expect(credits(win)).toContainText(ONLINE_SATELLITE.attribution, VIEW_READY);
    await expectFootApart(win, 'online satellite on');
    await shot(win, info, 'map-foot-online-satellite.png');
  });
});
