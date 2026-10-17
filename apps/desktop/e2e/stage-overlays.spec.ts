/**
 * The stage's corner overlays and the docked video (stage-island D30) in the window CI runs,
 * 1100 x 720, on the tank farm demo (two survey dates, a clip): every overlay takes a corner of its
 * own and none covers another, the T notice keeps clear of the callouts, the telemetry HUD and the
 * PAUSED chip are off the model, the stage shows one Map menu chip, and the coordinates readout
 * sits on a scrim. Docked, the video shares the stage across a divider (`scene.video`), beside or
 * under the views, and the views keep 360 px with Volumes in front; the volumes hint takes a
 * corner of its own. With the drawer open, the end corners keep clear of it, the video docked
 * beside the views too. Right to left, the dock stands at the left.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS.
 */
import type { Locator, Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { captionArea } from './caption';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { closeIslandTools, island, islandGroup, islandSettled, stageMode } from './island';
import { headerProblems } from './split';
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

/** Fold the right sidebar away with the stage's own toggle. */
async function foldRight(win: Page): Promise<void> {
  await win.locator('.stage-rp button').click();
  await expect(win.locator('.ws')).toHaveClass(/right-off/);
}

/** A live tool (M, Distance) slides the Measure bench in as the drawer; wait until it is in. */
async function openDrawer(win: Page): Promise<Locator> {
  await win.locator('[data-scene-view] canvas').first().focus();
  await win.keyboard.press('m');
  const drawer = win.getByTestId('wb-drawer');
  await expect(drawer).toHaveAttribute('data-open', '');
  await expect
    .poll(() =>
      drawer.evaluate((el) => {
        const r = el.getBoundingClientRect();
        // in at the end edge: the window's right, or its left right to left
        return Math.min(Math.abs(r.right - innerWidth), Math.abs(r.left));
      }),
    )
    .toBeLessThanOrEqual(1);
  return drawer;
}

interface Box {
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * What stands on the stage: each corner overlay, the floating video, the T notice, the readout,
 * the scene's callout plates and the drawer.
 */
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
      callouts: [...document.querySelectorAll<HTMLElement>('[data-callout]')]
        .filter((e) => e.style.display !== 'none')
        .map((e) => box(`callout ${e.dataset.callout ?? ''}`, e)),
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

/** The boxes in `list` that lie under `over`. */
const under = (list: readonly (Box | null)[], over: Box | null) =>
  over ? list.filter((b): b is Box => b !== null && overlap(b, over)).map((b) => b.name) : [];

/** The coordinates readout shows on a scrim, so it reads on a light ground (D30). */
async function expectScrim(win: Page): Promise<void> {
  const readout = win.locator('.pane-3d:not(.is-hidden) .cursor-ro');
  await expect(readout).toBeVisible();
  const bg = await readout.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
}

test('every overlay takes a corner of its own: the T notice, the dates, the clip and the Map menu', async ({
  win,
}, info) => {
  await openTankFarm(win);
  // the right sidebar folded: the open island leaves the top corners room under it
  await foldRight(win);
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
  // playback is the island's live item, so no PAUSED chip anywhere on the stage but the island
  await expect(win.locator('[data-trace-hud]:visible')).toHaveCount(0);
  const stageText = await stage.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelector(':scope > .island-wrap')?.remove();
    return copy.textContent;
  });
  expect(stageText).not.toMatch(/paused|playing/i);

  // the corner overlays keep apart, and the callouts move off the T notice once it shows
  await expect
    .poll(async () => {
      const now = await layout(win);
      return [
        ...overlaps([...now.slots, ...now.others]),
        ...under(now.callouts, now.others[1] ?? null),
      ];
    }, VIEW_READY)
    .toEqual([]);
  const now = await layout(win);
  expect(now.slots.filter((s) => s !== null).length).toBeGreaterThanOrEqual(2);
  const corners = now.slots.flatMap((s) => (s ? [s.name.split(':')[0]] : []));
  expect(new Set(corners).size).toBe(corners.length);
  await shot(win, info, 'overlays-busy-1100.png');
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
  // the volumes hint takes a corner of its own, clear of the readout (I-R51); the readout is on
  // its scrim
  const hint = win.getByTestId('vol-hint');
  await expect(hint).toBeVisible();
  await expect(win.locator('.stage-slot').filter({ has: hint })).toHaveCount(1);
  await expectScrim(win);
  await expect
    .poll(async () => {
      const now = await layout(win);
      return overlaps([...now.slots, ...now.others]);
    })
    .toEqual([]);
  // the annotator's strip under the clip chip takes its own height (no 3 px sliver)
  // (it shows with the pointer over the video)
  const strip = win.locator('.vwin.docked .ann-video .bar');
  await win.locator('.vwin.docked .vframe').hover();
  await expect.poll(async () => (await strip.boundingBox())?.height ?? 0).toBeGreaterThan(20);
  await expect(strip).toHaveCSS('opacity', '1');
  await shot(win, info, 'dock-volumes-1100.png');
  // the pointer gone, the strip hides again (I-R55)
  await win.mouse.move(5, 5);
  await expect(strip).toHaveCSS('opacity', '0');

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
  await foldRight(win);
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
  // the docked header is as tall as the window buttons' band, its buttons left of them
  const area = await captionArea(win);
  const head = await win.locator('.vwin.docked .vh').boundingBox();
  expect(head?.height ?? 0).toBeGreaterThanOrEqual(area.height - 1);
  const acts = await win.locator('.vwin.docked .vh .acts').boundingBox();
  const width = await win.evaluate(() => innerWidth);
  if (acts) expect(acts.x + acts.width).toBeLessThanOrEqual(width - area.kept.right + 1);
  await expectScrim(win);
  await shot(win, info, 'dock-side-1100.png');

  // a live tool opens the drawer over the end edge: the corners keep clear of it, and the Map
  // menu chip and the readout keep their width (the drawer covers the dock first)
  const chip = win.getByTestId('scene-map-button');
  const chipWidth = (await chip.boundingBox())?.width ?? 0;
  expect(chipWidth).toBeGreaterThan(60);
  const readout = win.locator('.pane-3d:not(.is-hidden) .cursor-ro');
  const readoutWidth = (await readout.boundingBox())?.width ?? 0;
  expect(readoutWidth).toBeGreaterThan(100);
  const drawer = await openDrawer(win);
  await expect
    .poll(async () => {
      const now = await layout(win);
      return under([...now.slots, ...now.others], now.drawer);
    })
    .toEqual([]);
  await expect
    .poll(async () => Math.abs(((await chip.boundingBox())?.width ?? 0) - chipWidth))
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => Math.abs(((await readout.boundingBox())?.width ?? 0) - readoutWidth))
    .toBeLessThanOrEqual(2);
  await shot(win, info, 'dock-side-drawer-1100.png');
  await win.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // under the views by choice too
  await win.getByRole('button', { name: 'Dock the video at the bottom' }).click();
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');

  // floating again: no divider, the views take the whole stage
  await win.getByRole('button', { name: 'Float the video window' }).click();
  await expect(divider).toHaveCount(0);
  await expect(win.getByTestId('video-window')).toBeVisible();
});

test.describe('a wider stage', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1400x800', QUADRION_DEMO: DEMO_FOLDER } });

  test('the open island moves only the top corners it reaches across', async ({ win }, info) => {
    await openTankFarm(win);
    await foldRight(win);
    const stage = win.locator('.ws > .stage');
    const dates = stage.getByTestId('dates-on-screen');
    const chip = stage.locator('[data-testid="basemap-button"], [data-testid="scene-map-button"]');
    await expect(dates).toBeVisible(VIEW_READY);
    const before = { dates: await dates.boundingBox(), chip: await chip.boundingBox() };
    await win.locator('[data-scene-view] canvas').first().focus();
    await win.keyboard.press('t');
    await expect(island(win)).toHaveAttribute('data-state', 'tools');
    await islandSettled(win);
    // the island leaves both top corners clear: the dates and the Map menu chip stay up, where
    // they were, beside it
    await expect(stage).toHaveAttribute('data-isl-clear', 'tl tr');
    const capsule = await win.locator('.island').boundingBox();
    const after = { dates: await dates.boundingBox(), chip: await chip.boundingBox() };
    expect(capsule && after.dates && after.chip && before.dates && before.chip).toBeTruthy();
    if (capsule && after.dates && after.chip && before.dates && before.chip) {
      expect(Math.round(after.dates.y)).toBe(Math.round(before.dates.y));
      expect(Math.round(after.chip.y)).toBe(Math.round(before.chip.y));
      expect(after.dates.y).toBeLessThan(capsule.y + capsule.height);
      for (const b of [after.dates, after.chip])
        expect(b.x + b.width <= capsule.x || capsule.x + capsule.width <= b.x).toBe(true);
    }
    await shot(win, info, 'island-open-corners-clear-1400.png');
    await win.keyboard.press('Escape');
    await expect(stage).not.toHaveAttribute('data-isl-clear');
  });

  test('in a wide Split, the readout stays beside the divider while the volumes hint shows', async ({
    win,
  }, info) => {
    await openTankFarm(win);
    await foldRight(win);
    // the video window put away, so it rests in no corner
    await win.evaluate(() => {
      (
        window as unknown as {
          __stratlas: { shell: { setState(s: { videoHidden: boolean }): void } };
        }
      ).__stratlas.shell.setState({ videoHidden: true });
    });
    await expect(win.getByTestId('video-window')).toHaveCount(0);
    await stageMode(win, 'Split');
    await closeIslandTools(win);
    const pane3d = win.locator('.stage-panes > .pane-3d[data-side="left"]');
    await expect(pane3d).toHaveCount(1);
    const hint = win.getByTestId('vol-hint');
    const readout = win.locator('.pane-3d:not(.is-hidden) .cursor-ro');
    await expect(hint).toBeVisible(VIEW_READY);
    // widen the 3D side until it has room for both
    const width = async () => Math.round((await pane3d.boundingBox())?.width ?? 0);
    const divider = win.getByRole('separator', { name: 'Resize the two sides' });
    await divider.focus();
    for (let i = 0; i < 30 && (await width()) < 660; i++) await win.keyboard.press('ArrowRight');
    expect(await width()).toBeGreaterThanOrEqual(660);
    await expect(readout).toBeVisible();
    await expect(hint).toBeVisible();
    const ro = await readout.boundingBox();
    const hb = await hint.boundingBox();
    expect(ro && hb).toBeTruthy();
    if (ro && hb) expect(ro.x).toBeGreaterThan(hb.x + hb.width);
    await shot(win, info, 'split-readout-beside-hint-1400.png');
    // narrowed again, the readout gives way to the hint
    for (let i = 0; i < 30 && (await width()) >= 600; i++) await win.keyboard.press('ArrowLeft');
    await expect(readout).toHaveCount(0);
  });
});

test('a click through the volumes hint picks the pile under it', async ({ win }, info) => {
  await openTankFarm(win);
  // Volumes in front and the video docked, as above: the hint has its corner
  await islandGroup(win, 'volumes');
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: 'Dock the video window' }).click();
  const hint = win.getByTestId('vol-hint');
  await expect(hint).toBeVisible(VIEW_READY);
  const box = await hint.boundingBox();
  if (!box) throw new Error('no hint');
  const aim = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // pan the camera until a pile stands under the hint's middle
  const pile = await win.evaluate(({ x, y }) => {
    interface V {
      x: number;
      y: number;
      z: number;
      clone(): V;
      project(c: unknown): V;
      applyMatrix4(m: unknown): V;
      sub(v: V): V;
      add(v: V): V;
      length(): number;
      setFromMatrixColumn(m: unknown, i: number): V;
      multiplyScalar(k: number): V;
    }
    const w = window as unknown as {
      __stratlas: {
        stage(): {
          canvas: HTMLCanvasElement;
          camera: {
            fov: number;
            aspect: number;
            position: V;
            matrixWorld: unknown;
            updateMatrixWorld(): void;
          };
          controls: { target: V; update(): void };
          scene: { getObjectByName(n: string): unknown };
          renderNow(): void;
        } | null;
        volumetric: {
          getState(): {
            epoch: string;
            piles: { id: string; epochs: Record<string, { node: string } | undefined> }[];
          };
        };
      };
    };
    const stage = w.__stratlas.stage();
    const vol = w.__stratlas.volumetric.getState();
    if (!stage) return null;
    const r = stage.canvas.getBoundingClientRect();
    const hx = ((x - r.left) / r.width) * 2 - 1;
    const hy = 1 - ((y - r.top) / r.height) * 2;
    for (const p of vol.piles) {
      const node = p.epochs[vol.epoch]?.node;
      const obj = node
        ? (stage.scene.getObjectByName(node) as
            { traverse(cb: (o: unknown) => void): void } | undefined)
        : undefined;
      const found: V[] = [];
      obj?.traverse((o) => {
        const m = o as {
          isMesh?: boolean;
          matrixWorld: unknown;
          geometry?: { boundingSphere: { center: V } | null; computeBoundingSphere(): void };
        };
        if (found.length > 0 || !m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const c = m.geometry.boundingSphere?.center;
        if (c) found.push(c.clone().applyMatrix4(m.matrixWorld));
      });
      const centre = found[0];
      if (!centre) continue;
      const cam = stage.camera;
      const tan = Math.tan((cam.fov * Math.PI) / 360);
      for (let i = 0; i < 4; i++) {
        cam.updateMatrixWorld();
        const at = centre.clone().project(cam);
        const d = centre.clone().sub(cam.position).length();
        const right = cam.position.clone().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = cam.position.clone().setFromMatrixColumn(cam.matrixWorld, 1);
        const move = right
          .multiplyScalar((at.x - hx) * d * tan * cam.aspect)
          .add(up.multiplyScalar((at.y - hy) * d * tan));
        cam.position.add(move);
        stage.controls.target.add(move);
        stage.controls.update();
      }
      stage.renderNow();
      return p.id;
    }
    return null;
  }, aim);
  expect(pile).not.toBeNull();
  // the hint is still there, and the click lands on the 3D view under it
  await expect(hint).toBeVisible();
  const top = await win.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null,
    aim,
  );
  expect(top).toBe('CANVAS');
  await win.mouse.click(aim.x, aim.y);
  await expect
    .poll(() =>
      win.evaluate(
        () =>
          (
            window as unknown as {
              __stratlas: { volumetric: { getState(): { selected: string | null } } };
            }
          ).__stratlas.volumetric.getState().selected,
      ),
    )
    .toBe(pile);
  await shot(win, info, 'vol-hint-click-through-1100.png');
});

test('with the drawer open, the corners at its side keep clear of it', async ({ win }, info) => {
  await openTankFarm(win);
  // the right sidebar folded: a live tool slides its bench in as the drawer
  await foldRight(win);
  await openDrawer(win);
  await expect
    .poll(async () => {
      const now = await layout(win);
      return now.drawer ? under([...now.slots, ...now.others], now.drawer) : ['no drawer'];
    })
    .toEqual([]);
  await shot(win, info, 'overlays-drawer-1100.png');
  await win.keyboard.press('Escape');
});

test('in Split, the pane headers keep clear of the corners and the video, and each divider moves alone', async ({
  win,
}, info) => {
  await openTankFarm(win);
  await foldRight(win);
  await stageMode(win, 'Split');
  await closeIslandTools(win);
  await expect(win.locator('.pane-head')).toHaveCount(2);
  await islandSettled(win);
  // the floating clip, the corners and the two headers keep apart
  await expect.poll(() => headerProblems(win), VIEW_READY).toEqual([]);
  await expect
    .poll(async () => {
      const now = await layout(win);
      return overlaps([...now.slots, ...now.others]);
    })
    .toEqual([]);

  // docked beside the views: two dividers, the split's inside the views
  await win.getByRole('button', { name: 'Dock the video window' }).click();
  const dockDivider = win.getByRole('separator', { name: 'Resize the video dock' });
  const splitDivider = win.getByRole('separator', { name: 'Resize the two sides' });
  await expect(dockDivider).toHaveAttribute('aria-orientation', 'vertical');
  await expect(splitDivider).toBeVisible();
  // the volumes hint takes the 3D pane's foot; the 3D view on the left keeps its readout beside
  // the divider, hidden while the pane is too narrow for both (a wide one: the 1400 px test)
  await expect(win.getByTestId('vol-hint')).toBeVisible();
  await expect(win.locator('.stage-panes > .pane-3d[data-side="left"]')).toHaveCount(1);
  await expect(win.locator('.pane-3d:not(.is-hidden) .cursor-ro')).toHaveCount(0);
  const panes = win.locator('.stage-panes');
  const left = win.locator('.stage-panes > [data-side="left"]').first();
  const dock = win.locator('.stage-dock');
  /** The left side's share of the views, in hundredths. */
  const share = async () => {
    const a = await left.boundingBox();
    const b = await panes.boundingBox();
    return a && b ? Math.round((a.width / b.width) * 100) : -1;
  };
  const dockWidth = async () => Math.round((await dock.boundingBox())?.width ?? 0);
  await expect.poll(() => headerProblems(win)).toEqual([]);
  await shot(win, info, 'split-dock-side-1100.png');

  // the dock's divider: the dock grows, the two sides keep their shares
  const shareBefore = await share();
  const dockBefore = await dockWidth();
  await dockDivider.focus();
  await win.keyboard.press('ArrowLeft');
  await win.keyboard.press('ArrowLeft');
  await expect.poll(dockWidth).toBeGreaterThan(dockBefore + 20);
  await expect.poll(share).toBe(shareBefore);
  // the split's divider: the left side grows, the dock keeps its width
  const dockNow = await dockWidth();
  const leftBefore = Math.round((await left.boundingBox())?.width ?? 0);
  await splitDivider.focus();
  await win.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => Math.round((await left.boundingBox())?.width ?? 0))
    .toBeLessThan(leftBefore - 10);
  expect(await dockWidth()).toBe(dockNow);
  await expect.poll(() => headerProblems(win)).toEqual([]);
  // the left side at its least (200 px): each corner overlay keeps to the pane under it
  for (let i = 0; i < 20; i++) await win.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => Math.round((await left.boundingBox())?.width ?? 0))
    .toBeLessThanOrEqual(210);
  await expect
    .poll(() =>
      win.evaluate(() => {
        const pane = (side: string) =>
          document.querySelector(`.stage-panes > [data-side="${side}"]`)?.getBoundingClientRect();
        const out: string[] = [];
        for (const slot of document.querySelectorAll<HTMLElement>('.stage-slot')) {
          const at = slot.dataset.slot ?? '';
          const p = pane(at.endsWith('l') ? 'left' : 'right');
          for (const item of slot.children) {
            const r = item.getBoundingClientRect();
            if (!p || r.width === 0) continue;
            if (r.left < p.left - 0.5 || r.right > p.right + 0.5)
              out.push(`${at} ${item.className} leaves its pane`);
          }
        }
        return out;
      }),
    )
    .toEqual([]);
  await expect(win.getByTestId('vol-hint')).toBeVisible();
  await shot(win, info, 'split-narrow-side-1100.png');

  // floating again: the split keeps its divider
  await win.getByRole('button', { name: 'Float the video window' }).click();
  await expect(dockDivider).toHaveCount(0);
  await expect(splitDivider).toBeVisible();
});

test.describe('right to left', () => {
  test('the video docks at the left, beside the views, with the stage controls right of it', async ({
    win,
  }, info) => {
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
    await win.getByRole('button', { name: 'Right to left' }).click();
    await expect(win.locator('html')).toHaveAttribute('dir', 'rtl');
    await openTankFarm(win);
    await foldRight(win);
    await win.getByRole('button', { name: 'Dock the video window' }).click();
    const divider = win.getByRole('separator', { name: 'Resize the video dock' });
    await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    const views = await win.locator('.stage-views').boundingBox();
    const pane = await win.locator('.stage-dock').boundingBox();
    const toggle = await win.locator('.stage-rp').boundingBox();
    expect(views && pane && toggle).toBeTruthy();
    if (views && pane && toggle) {
      expect(views.width).toBeGreaterThanOrEqual(360);
      // the dock at the end edge, the left right to left; the toggle stands right of it
      expect(pane.x + pane.width).toBeLessThanOrEqual(views.x + 1);
      expect(toggle.x).toBeGreaterThanOrEqual(pane.x + pane.width);
    }
    await expect
      .poll(async () => {
        const now = await layout(win);
        return overlaps([...now.slots, ...now.others]);
      })
      .toEqual([]);
    await shot(win, info, 'dock-rtl-1100.png');
  });
});
