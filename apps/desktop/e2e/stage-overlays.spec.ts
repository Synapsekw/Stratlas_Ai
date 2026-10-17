/**
 * The stage's corner overlays and the docked video (stage-island D30) in the window CI runs,
 * 1100 x 720, on the tank farm demo (two survey dates, a clip): every overlay takes a corner of its
 * own and none covers another or the T notice, the telemetry HUD and the PAUSED chip are off the
 * model, the stage shows one Map menu chip, and the coordinates readout sits on a scrim. Docked,
 * the video shares the stage across a divider (`scene.video`), beside or under the views, and the
 * views keep 360 px with Volumes in front. With the drawer open, the end corners keep clear of it.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS.
 */
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { islandGroup, islandSettled } from './island';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_DEMO: DEMO_FOLDER } });

const VIEW_READY = { timeout: 30_000 };

interface Hooks {
  __stratlas: {
    workspace: { setState(s: { hidden: Record<string, true> }): void };
  };
}

async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

/** The tank farm with both survey dates on screen and its clip floating over the stage. */
async function openTankFarm(win: Page): Promise<void> {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  await win.evaluate(() => {
    (window as unknown as Hooks).__stratlas.workspace.setState({ hidden: {} });
  });
  await expect(win.getByTestId('video-window')).toBeVisible(VIEW_READY);
}

interface Box {
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What stands on the stage: each corner overlay, the floating video, the T notice, the readout. */
const layout = (win: Page) =>
  win.evaluate(() => {
    const box = (name: string, el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0
        ? { name, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        : null;
    };
    return {
      slots: [...document.querySelectorAll<HTMLElement>('.stage-slot')].map((s) =>
        box(
          `${s.dataset.slot ?? ''}:${s.querySelector('[data-testid]')?.getAttribute('data-testid') ?? s.firstElementChild?.className ?? ''}`,
          s,
        ),
      ),
      others: [
        box('video', document.querySelector('.vwin:not(.docked)')),
        box('t-notice', document.querySelector('[data-testid="t-notice"]')),
        box('cursor', document.querySelector('.pane-3d:not(.is-hidden) .cursor-ro')),
      ],
      drawer: box('drawer', document.querySelector('[data-testid="wb-drawer"]')),
    };
  });

const overlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The pairs of boxes that cover each other. */
function overlaps(list: readonly (Box | null)[]): string[] {
  const boxes = list.filter((b): b is Box => b !== null);
  const out: string[] = [];
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1)) if (overlap(a, b)) out.push(`${a.name} / ${b.name}`);
  });
  return out;
}

test('every overlay takes a corner of its own: the T notice, the dates, the clip and the Map menu', async ({
  win,
}, info) => {
  await openTankFarm(win);
  const stage = win.locator('.ws > .stage');
  await expect(stage.getByTestId('dates-on-screen')).toBeVisible(VIEW_READY);
  // one Map menu chip on the stage, never one per pane
  await expect(
    stage.locator('[data-testid="basemap-button"], [data-testid="scene-map-button"]'),
  ).toHaveCount(1);
  // the first T: the tools and the one-time notice under the island
  await win.locator('[data-scene-view] canvas').first().focus();
  await win.keyboard.press('t');
  await expect(win.getByTestId('t-notice')).toBeVisible();
  await islandSettled(win);

  // the telemetry is the island's live line and the Video workbench, not a box on the model;
  // playback is the island's live item, so no PAUSED chip
  await expect(win.locator('[data-trace-hud]:visible')).toHaveCount(0);
  await expect(stage.locator('.stage-views')).not.toContainText(/paused|playing/i);

  const now = await layout(win);
  expect(now.slots.filter((s) => s !== null).length).toBeGreaterThanOrEqual(2);
  expect(overlaps([...now.slots, ...now.others]), 'covering each other').toEqual([]);
  const corners = now.slots.flatMap((s) => (s ? [s.name.split(':')[0]] : []));
  expect(new Set(corners).size).toBe(corners.length);
  await shot(win, info, 'overlays-busy-1100.png');

  // the coordinates readout reads on a light ground: it has a scrim
  const readout = win.locator('.pane-3d:not(.is-hidden) .cursor-ro');
  if (await readout.count()) {
    const bg = await readout.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
});

test('docked, the video shares the stage across a divider, under or beside the views', async ({
  win,
}, info) => {
  await openTankFarm(win);
  // Volumes in front in the right panel: the stage is too narrow for the views and a dock side
  // by side, so the video docks under them
  await islandGroup(win, 'volumes');
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: 'Dock the video window' }).click();

  const divider = win.getByRole('separator', { name: 'Resize the video dock' });
  const views = win.locator('.stage-views');
  const dock = win.locator('.stage-dock');
  const stage = win.locator('.ws > .stage');
  await expect(divider).toBeVisible();
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(win.getByRole('button', { name: 'Dock the video at the side' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  // the views keep the stage's width, at least 360 px with Volumes in front
  await expect
    .poll(async () => (await views.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(360);
  const fill = async () => {
    // the frame fills the dock under its title bar: no black void below a 16:9 box
    const frame = await win.locator('.vwin.docked .vframe').boundingBox();
    const pane = await dock.boundingBox();
    return frame && pane ? Math.round(pane.y + pane.height - (frame.y + frame.height)) : null;
  };
  await expect.poll(fill).toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const v = await views.boundingBox();
      const k = await dock.boundingBox();
      return v && k ? Math.round(k.y - (v.y + v.height)) : null;
    })
    .toBe(0);
  await shot(win, info, 'dock-volumes-1100.png');

  // drag the divider up: the dock grows, the views give way
  const before = (await dock.boundingBox())?.height ?? 0;
  const d = await divider.boundingBox();
  if (!d) throw new Error('no divider');
  await win.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await win.mouse.down();
  await win.mouse.move(d.x + d.width / 2, d.y + d.height / 2 - 60, { steps: 6 });
  await win.mouse.up();
  await expect
    .poll(async () => (await dock.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before + 30);

  // the right panel folded, the stage has room: the video docks beside the views
  await win.locator('.stage-rp button').click();
  await expect(win.locator('.ws')).toHaveClass(/right-off/);
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  await expect
    .poll(async () => (await views.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(360);
  await expect.poll(fill).toBeLessThanOrEqual(1);
  const pane = await dock.boundingBox();
  // the right panel's toggle stands left of the dock, and the island centres on the views
  const toggle = await win.locator('.stage-rp').boundingBox();
  const bar = await win.locator('.island').boundingBox();
  expect(pane && toggle && bar).toBeTruthy();
  if (pane && toggle && bar) {
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(pane.x);
    expect(bar.x + bar.width).toBeLessThanOrEqual(pane.x);
  }
  // nothing of the stage's end controls reaches past the views into the dock
  const s = await stage.boundingBox();
  if (s && pane) expect(Math.round(s.x + s.width - (pane.x + pane.width))).toBe(0);
  await shot(win, info, 'dock-side-1100.png');

  // under the views by choice too
  await win.getByRole('button', { name: 'Dock the video at the bottom' }).click();
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');

  // floating again: no divider, the views take the whole stage
  await win.getByRole('button', { name: 'Float the video window' }).click();
  await expect(divider).toHaveCount(0);
  await expect(win.getByTestId('video-window')).toBeVisible();
});

test('with the drawer open, the corners at its side keep clear of it', async ({ win }, info) => {
  await openTankFarm(win);
  // the right sidebar folded: a live tool slides its bench in as the drawer
  await win.locator('.stage-rp button').click();
  await expect(win.locator('.ws')).toHaveClass(/right-off/);
  await win.locator('[data-scene-view] canvas').first().focus();
  await win.keyboard.press('m');
  const drawer = win.getByTestId('wb-drawer');
  await expect(drawer).toHaveAttribute('data-open', '');
  await expect
    .poll(() => drawer.evaluate((el) => Math.abs(el.getBoundingClientRect().right - innerWidth)))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const now = await layout(win);
      const d = now.drawer;
      if (!d) return ['no drawer'];
      return [...now.slots, ...now.others]
        .filter((b): b is Box => b !== null && overlap(b, d))
        .map((b) => b.name);
    })
    .toEqual([]);
  await shot(win, info, 'overlays-drawer-1100.png');
  await win.keyboard.press('Escape');
});
