/**
 * Pinned media (pinned media design): a 360 and a photo that have no GPS show "Not placed" in
 * Media; Place on site from a tile's right-click (or a click on an unplaced 360's tile) opens the
 * placing strip bottom-centre over the stage, clear of the middle of the view; a click on the
 * site pins the 360 at eye height, two landmark pairs line it up, its marker enters it facing the
 * saved heading, and Remove pin makes it "Not placed" again. On the map, a GPS photo is a marker plate that previews on hover and
 * opens beside the map, a photo pinned on the map opens the same way, and a 360 pinned there is a
 * round plate that enters the 360. Synthetic project (pinFixture.ts), off-screen, zero network.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { closeIslandTools, stageMode } from './island';
import {
  createPinProject,
  itemOf,
  lonLatOf,
  notPlaced,
  openMedia,
  openPinProject,
  PANO_LAYER,
  PH3_POS,
  PHOTO_LAYER,
  tileAction,
} from './pinFixture';

interface Probe {
  __stratlas: {
    workspace: { getState(): { selection: { kind: string; id: string } | null } };
    stage(): {
      camera: {
        updateMatrixWorld(): void;
        matrixWorld: { elements: number[] };
        projectionMatrix: { elements: number[] };
        position: {
          y: number;
          clone(): {
            set(
              x: number,
              y: number,
              z: number,
            ): { project(c: unknown): { x: number; y: number; z: number } };
          };
        };
      };
      renderer: { domElement: HTMLCanvasElement };
      restoreView(
        v: { position: [number, number, number]; target: [number, number, number] },
        animate?: boolean,
      ): void;
    } | null;
  };
}

interface MapEl extends Element {
  __aioMap: {
    getContainer(): HTMLElement;
    project(ll: [number, number]): { x: number; y: number };
    jumpTo(o: { center: [number, number]; zoom: number }): void;
    isMoving(): boolean;
  };
}

/** Look straight down on the pin's ground from 40 m, so 5 m around it is on screen. */
async function lookDown(win: Page): Promise<void> {
  await win.evaluate(() => {
    (window as unknown as Probe).__stratlas
      .stage()
      ?.restoreView({ position: [0, 40, 0.1], target: [0, 0, 0] }, false);
  });
  // the view has settled when the camera stands 40 m up
  await expect
    .poll(
      async () =>
        Math.round(
          await win.evaluate(
            () => (window as unknown as Probe).__stratlas.stage()?.camera.position.y ?? 0,
          ),
        ),
      { timeout: 10_000 },
    )
    .toBe(40);
}

/**
 * The page point of a model point (x, height, z) in the 3D view. A panel that just opened or
 * closed resizes the view over a few frames, and the camera can still be easing: the point is read
 * once no side panel is mid-fold, the view's box and the camera's pose have held still for three
 * frames and the camera's aspect matches the box, else the click lands where the view was. A
 * folding panel slides out first and the view is resized only when the slide ends (useFold.ts),
 * so a still box during the slide is not enough.
 */
async function scenePoint(
  win: Page,
  p: [number, number, number],
): Promise<{ x: number; y: number }> {
  return win.evaluate(async (p) => {
    const st = (window as unknown as Probe).__stratlas.stage();
    if (!st) throw new Error('no stage');
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    const box = () => {
      const r = st.renderer.domElement.getBoundingClientRect();
      return `${String(r.left)},${String(r.top)},${String(r.width)},${String(r.height)}`;
    };
    const aspect = () => (st.camera as unknown as { aspect?: number }).aspect;
    const pose = () => {
      st.camera.updateMatrixWorld();
      return [...st.camera.matrixWorld.elements, ...st.camera.projectionMatrix.elements]
        .map((e) => e.toFixed(4))
        .join(',');
    };
    let last = box() + pose();
    for (let still = 0, i = 0; still < 3 && i < 120; i++) {
      await frame();
      const now = box() + pose();
      const r = st.renderer.domElement.getBoundingClientRect();
      const a = aspect();
      const fits = a === undefined || Math.abs(a - r.width / r.height) < 0.01;
      const folding = document.querySelector('[data-fold]') !== null;
      still = now === last && fits && !folding ? still + 1 : 0;
      last = now;
    }
    st.camera.updateMatrixWorld();
    const v = st.camera.position.clone().set(p[0], p[1], p[2]).project(st.camera);
    const r = st.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);
}

/** The page point of a model point on the map (the UTM project). */
async function mapPoint(win: Page, p: [number, number, number]): Promise<{ x: number; y: number }> {
  const ll = lonLatOf(p);
  return win.evaluate((ll) => {
    const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
      MapEl | undefined;
    if (!el) throw new Error('no map');
    const at = el.__aioMap.project(ll);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    return { x: r.left + at.x, y: r.top + at.y };
  }, ll);
}

/**
 * Let the map finish any move it is making (a fit, a flight to the selection), then centre it on
 * a model point at a fixed zoom, so a point computed for a click is still there when it lands and
 * plates a few tens of metres apart draw apart.
 */
async function settleMap(win: Page, p: [number, number, number], zoom = 19): Promise<void> {
  const mapEl = () =>
    [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as MapEl | undefined;
  await expect
    .poll(() => win.evaluate(`(${mapEl.toString()})()?.__aioMap.isMoving() ?? true`), {
      timeout: 30_000,
    })
    .toBe(false);
  const ll = lonLatOf(p);
  await win.evaluate(
    ({ ll, zoom }) => {
      const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
        MapEl | undefined;
      if (!el) throw new Error('no map');
      el.__aioMap.jumpTo({ center: ll, zoom });
    },
    { ll, zoom },
  );
}

/** Azimuth of the 3D camera's view, degrees clockwise from grid north. */
async function cameraAzimuth(win: Page): Promise<number> {
  return win.evaluate(() => {
    const st = (window as unknown as Probe).__stratlas.stage();
    if (!st) throw new Error('no stage');
    st.camera.updateMatrixWorld();
    const e = st.camera.matrixWorld.elements;
    // the camera looks along its -z axis
    const fx = -(e[8] ?? 0);
    const fz = -(e[10] ?? 0);
    return ((((Math.atan2(fx, -fz) * 180) / Math.PI) % 360) + 360) % 360;
  });
}

const selected = (win: Page) =>
  win.evaluate(() => (window as unknown as Probe).__stratlas.workspace.getState().selection);

/** The centre of a locator's box on the page. */
async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('not on screen');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * The strip is bottom-centre over the stage and leaves the middle of the 3D view to the scene:
 * a click there reaches the canvas.
 */
async function stripClearOfView(win: Page): Promise<void> {
  const strip = win.getByTestId('pin-strip');
  await expect(strip).toBeVisible({ timeout: 30_000 });
  const s = await strip.boundingBox();
  const stage = await win.locator('.stage').first().boundingBox();
  if (!s || !stage) throw new Error('no strip or stage box');
  expect(s.y).toBeGreaterThan(stage.y + stage.height / 2);
  expect(Math.abs(s.x + s.width / 2 - (stage.x + stage.width / 2))).toBeLessThanOrEqual(8);
  await closeIslandTools(win);
  expect(
    await win.evaluate(() => {
      const c = document.querySelector('[data-scene-view] canvas');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === c;
    }),
  ).toBe(true);
}

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `pinned-media-${name}.png`) });
}

/**
 * Open the project, see the unplaced items in Media, Place on site on `p1`: from its right-click
 * menu, or (`click`) by a plain click on its tile, which places an unplaced 360.
 */
async function placeP1(win: Page, via: 'menu' | 'click' = 'menu'): Promise<void> {
  await openPinProject(win);
  await openMedia(win);
  await expect(notPlaced(win, 'p1')).toBeVisible({ timeout: 30_000 });
  await expect(notPlaced(win, 'ph1')).toBeVisible();
  // ph2 (the 2:1 photo) has no place either; ph3 has GPS
  await expect(notPlaced(win, 'ph2')).toBeVisible();
  await expect(win.getByTestId('media-not-placed')).toHaveCount(3);
  await evidence(win, `${via}-1-media`);
  if (via === 'menu') await tileAction(win, { pano: 'p1' }, 'Place on site');
  else await win.locator('[data-pano="p1"]').first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(step(win)).toHaveAttribute('data-step', 'pick');
  await stripClearOfView(win);
  await evidence(win, `${via}-2-placing`);
}

/** Turn the Panoramas pane's look to compass `deg` with the arrow keys (5 degrees a press). */
async function turnPaneTo(win: Page, view: Locator, deg: number): Promise<void> {
  const pane = win.getByTestId('pane-pano');
  const off = async () => {
    const yaw = Number(await pane.getAttribute('data-yaw'));
    return ((((deg - yaw) % 360) + 540) % 360) - 180;
  };
  await view.focus();
  for (let i = 0; i < 72 && Math.abs(await off()) > 2.5; i++)
    await win.keyboard.press((await off()) > 0 ? 'ArrowRight' : 'ArrowLeft');
  expect(Math.abs(await off())).toBeLessThanOrEqual(2.5);
}

const step = (win: Page) => win.getByTestId('pin-strip').locator('[data-step]');

test.describe('pinned media in the 3D view', () => {
  test('a 360 with no GPS is pinned, lined up by two landmarks, entered and unpinned', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const dir = await createPinProject(dataRoot.root);
    await win.reload();
    await placeP1(win);
    // room for the 3D view beside the 360 while lining up
    await win.getByRole('button', { name: 'Hide the right panel' }).click();

    // pin it on the ground at the origin: the camera stands 1.6 m up
    await lookDown(win);
    const o = await scenePoint(win, [0, 0, 0]);
    await win.mouse.click(o.x, o.y);
    await expect
      .poll(async () => (await itemOf(dir, PANO_LAYER, 'p1'))?.pos, { timeout: 30_000 })
      .toBeDefined();
    const p1 = await itemOf(dir, PANO_LAYER, 'p1');
    const pos = p1?.pos ?? [NaN, NaN, NaN];
    expect(Math.abs(pos[0])).toBeLessThan(0.05);
    expect(Math.abs(pos[1] - 1.6)).toBeLessThan(0.05);
    expect(Math.abs(pos[2])).toBeLessThan(0.05);
    expect(p1?.pin?.eyeM).toBe(1.6);
    const pane = win.getByTestId('pane-pano');
    await expect(pane).toBeVisible({ timeout: 30_000 });
    await expect(step(win)).toHaveAttribute('data-step', 'pano');
    const view = pane.locator('[data-picking="true"]');
    await expect(view).toBeVisible();

    // first pair: the middle of the 360, then a landmark 5 m east of the pin (the 3D view beside
    // the 360 is narrow: 5 m keeps both landmarks on it)
    const heading = async () => (await itemOf(dir, PANO_LAYER, 'p1'))?.headingDeg ?? NaN;
    await view.click();
    await expect(step(win)).toHaveAttribute('data-step', 'scene');
    await lookDown(win);
    const east = await scenePoint(win, [5, 0, 0]);
    await win.mouse.click(east.x, east.y);
    await expect.poll(heading, { timeout: 30_000 }).toBeGreaterThan(89);
    expect(await heading()).toBeLessThan(91);
    await expect(step(win)).toHaveAttribute('data-step', 'more');

    // second pair: the same spot of the 360 (its own direction 0, now drawn at compass 90: the
    // pane keeps its compass look, so turn it there), then the landmark at bearing 100: the
    // mean of the two pairs, 95
    await turnPaneTo(win, view, await heading());
    await view.click();
    await expect(step(win)).toHaveAttribute('data-step', 'scene');
    const rad = (100 * Math.PI) / 180;
    const b100 = await scenePoint(win, [5 * Math.sin(rad), 0, -5 * Math.cos(rad)]);
    await win.mouse.click(b100.x, b100.y);
    await expect(win.getByTestId('pin-strip')).toHaveCount(0, { timeout: 30_000 });
    expect(Math.abs((await heading()) - 95)).toBeLessThanOrEqual(1);

    // the 360's marker previews on hover and enters it facing its heading
    const mk = win.locator('.pane-3d .aio-mk[data-kind="pano"]').first();
    await expect(mk).toBeVisible({ timeout: 30_000 });
    const at = await centre(mk);
    await win.mouse.move(at.x + 4, at.y + 4);
    await win.mouse.move(at.x, at.y, { steps: 2 });
    await expect(win.locator('.pane-3d [data-markers="pano"] .aio-mk-tip')).toContainText('p1');
    await win.mouse.click(at.x, at.y);
    await expect(win.getByTestId('pano-back')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => {
        const az = await cameraAzimuth(win);
        return Math.abs(((az - 95 + 540) % 360) - 180);
      })
      .toBeLessThanOrEqual(2);

    // back out; right-click the pin's eye: Remove pin, and Media says Not placed again
    await win.getByTestId('pano-back').click();
    await expect(win.getByTestId('pano-back')).toBeHidden();
    await lookDown(win);
    const eye = await scenePoint(win, [0, 1.6, 0]);
    await win.mouse.click(eye.x, eye.y, { button: 'right' });
    await win.getByRole('menuitem', { name: 'Remove pin', exact: true }).click();
    await expect
      .poll(async () => (await itemOf(dir, PANO_LAYER, 'p1'))?.pos, { timeout: 30_000 })
      .toBeUndefined();
    await openMedia(win);
    await expect(notPlaced(win, 'p1')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('the placing strip in a shorter window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('sits bottom-centre and leaves the middle of the view to the scene', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    await createPinProject(dataRoot.root);
    await win.reload();
    await placeP1(win, 'click');
  });
});

test.describe('pinned media on the map', () => {
  test('a GPS photo is a plate on the map; photos and 360s pinned on the map open from it', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(240_000);
    const dir = await createPinProject(dataRoot.root, { crs: 'utm', basemap: true });
    await win.reload();
    await openPinProject(win);
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 30_000 });
    await stageMode(win, 'Split');
    const map = win.locator('.maplibregl-map').first();
    await expect(map).toBeVisible({ timeout: 30_000 });

    // the GPS photo is a plate like the 3D one (not the old near-black dot)
    const mapPhoto = map.locator('.aio-mk[data-kind="photo"]').first();
    await expect(mapPhoto).toBeVisible({ timeout: 30_000 });
    const plate = (l: Locator) =>
      l.locator('.aio-mk-p').evaluate((e) => getComputedStyle(e).backgroundColor);
    const scenePhoto = win.locator('.pane-3d .aio-mk[data-kind="photo"]').first();
    await expect(scenePhoto).toHaveCount(1, { timeout: 30_000 });
    expect(await plate(mapPhoto)).toBe(await plate(scenePhoto));

    // it previews on hover with its thumbnail, and opens beside the map on click
    const ph3 = await mapPoint(win, PH3_POS);
    await win.mouse.move(ph3.x + 4, ph3.y + 4);
    await win.mouse.move(ph3.x, ph3.y, { steps: 2 });
    const tip = map.locator('[data-markers="photo"] .aio-mk-tip');
    await expect(tip).toBeVisible();
    await expect(tip.locator('img')).toHaveCount(1);
    await win.mouse.click(ph3.x, ph3.y);
    await expect(win.getByTestId('pane-photo')).toBeVisible({ timeout: 30_000 });
    await expect(map).toBeVisible();
    await expect.poll(() => selected(win)).toMatchObject({ kind: 'photo', id: 'ph3' });

    // a photo with no GPS, pinned on the map off the model: its height is unknown
    await openMedia(win);
    await expect(notPlaced(win, 'ph1')).toBeVisible({ timeout: 30_000 });
    await tileAction(win, { photo: 'ph1' }, 'Place on site');
    await expect(win.getByTestId('pin-strip')).toBeVisible({ timeout: 30_000 });
    await expect(map).toBeVisible({ timeout: 30_000 });
    const ph1At: [number, number, number] = [-25, 0, 0];
    // the map comes back flying to the selection (ph3): a point taken mid-flight lands elsewhere
    await settleMap(win, [-15, 0, 15]);
    const a = await mapPoint(win, ph1At);
    await win.mouse.click(a.x, a.y);
    await expect
      .poll(async () => (await itemOf(dir, PHOTO_LAYER, 'ph1'))?.pos, { timeout: 30_000 })
      .toBeDefined();
    await expect(win.getByTestId('pin-strip')).toContainText(
      'Height unknown here: the pin sits at 0 m.',
    );
    await win.getByTestId('pin-done').click();
    await expect(win.getByTestId('pin-strip')).toHaveCount(0);
    await expect(map.locator('.aio-mk[data-kind="photo"]')).toHaveCount(2, { timeout: 30_000 });
    const b = await mapPoint(win, ph1At);
    await win.mouse.move(b.x + 4, b.y + 4);
    await win.mouse.move(b.x, b.y, { steps: 2 });
    await win.mouse.click(b.x, b.y);
    await expect
      .poll(() => selected(win), { timeout: 30_000 })
      .toMatchObject({
        kind: 'photo',
        id: 'ph1',
      });
    await expect(win.getByTestId('pane-photo')).toBeVisible();
    await expect(map).toBeVisible();

    // a 360 pinned on the map is a round plate there; a click enters it, the 3D view beside
    await openMedia(win);
    await tileAction(win, { pano: 'p1' }, 'Place on site');
    await expect(win.getByTestId('pin-strip')).toBeVisible({ timeout: 30_000 });
    await expect(map).toBeVisible({ timeout: 30_000 });
    const p1At: [number, number, number] = [0, 0, 25];
    // the map centred on the spot: near the pane's edge the split's divider takes the click
    await settleMap(win, p1At);
    const c = await mapPoint(win, p1At);
    await win.mouse.click(c.x, c.y);
    await expect
      .poll(async () => (await itemOf(dir, PANO_LAYER, 'p1'))?.pos, { timeout: 30_000 })
      .toBeDefined();
    await win.getByTestId('pin-cancel').click();
    await expect(win.getByTestId('pin-strip')).toHaveCount(0);
    if (!(await map.isVisible())) await stageMode(win, 'Split');
    const round = map.locator('.aio-mk[data-kind="pano"]').first();
    await expect(round).toBeVisible({ timeout: 30_000 });
    expect(await round.locator('.aio-mk-p').evaluate((e) => getComputedStyle(e).borderRadius)).toBe(
      '50%',
    );
    const d = await centre(round);
    await win.mouse.move(d.x + 4, d.y + 4);
    await win.mouse.move(d.x, d.y, { steps: 2 });
    await win.mouse.click(d.x, d.y);
    await expect(win.getByTestId('pano-back')).toBeVisible({ timeout: 30_000 });
    await expect(map).toBeVisible();
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  });
});
