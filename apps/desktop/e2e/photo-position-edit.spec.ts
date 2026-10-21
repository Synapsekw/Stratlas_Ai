/**
 * Edit position of photos (photo position edit, 21 Oct 2026). In Media, Edit position on one GPS
 * photo shows its X, Y, Z; a new Z is saved as an `offsetM` correction in `orientation.json`, the
 * manifest untouched, and the tile shows "Edited". Two picked photos take a shift together, Undo
 * and Redo in the notice are exact. On the map, Reset to original drops the correction and the
 * marker goes back to the imported place. A pinned photo's Edit position is greyed with the
 * reason. A thermal photo without DJI metadata, imported beside its visual twin, sits at the
 * twin's place as an edit that Reset takes back. Re-read photo positions on a photos dataset reads
 * stale heights and view directions again from the files and keeps a hand move where it was put.
 * Synthetic project (positionFixture.ts) and synthetic XT2-style JPEGs; off-screen; zero network.
 */
import { cameraQuatFromGimbal, gridConvergenceDeg } from '@aio/geo';
import { xt2Thermal, xt2Visual } from '@aio/project/builder/testing';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { stageMode } from './island';
import {
  correctionOf,
  createPositionProject,
  EPSG,
  G1_POS,
  G2_POS,
  itemOf,
  lonLatOf,
  onPixels,
  openPositionProject,
  POS_LAYER,
  readManifest,
} from './positionFixture';
import type { Vec3 } from '@aio/schema';

interface MapEl extends Element {
  __aioMap: {
    getContainer(): HTMLElement;
    project(ll: [number, number]): { x: number; y: number };
    jumpTo(o: { center: [number, number]; zoom: number }): void;
    isMoving(): boolean;
  };
}

const tile = (win: Page, id: string) => win.locator(`[data-photo="${id}"]`).first();
const edited = (win: Page, id: string) =>
  win.locator(`[data-testid="media-tile-edited"][data-item="${id}"]`);
const panel = (win: Page) => win.getByTestId('position-panel');

async function openMedia(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Media' }).first().click();
}

/** Right-click a Media tile and open its Edit position panel. */
async function editFromTile(win: Page, id: string): Promise<void> {
  const el = tile(win, id);
  await el.scrollIntoViewIfNeeded();
  await el.click({ button: 'right' });
  await win.getByTestId('ctx-item-photos.editPosition').click();
  await expect(panel(win)).toBeVisible();
}

const near = (a: readonly number[] | undefined, b: readonly number[], eps = 1e-3) =>
  a?.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < eps);

const offsetOf = async (dir: string, id: string, layer = POS_LAYER) =>
  (await correctionOf(dir, layer, id))?.offsetM;

/** The page point of a model point on the map. */
async function mapPoint(win: Page, p: Vec3): Promise<{ x: number; y: number }> {
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

/** Let the map finish any move, then centre it on a model point at a fixed zoom. */
async function settleMap(win: Page, p: Vec3, zoom = 19): Promise<void> {
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
            MapEl | undefined;
          return el?.__aioMap.isMoving() ?? true;
        }),
      { timeout: 30_000 },
    )
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

/** Distance in px from a page point to the nearest photo marker plate of the map. */
async function nearestPlate(map: Locator, at: { x: number; y: number }): Promise<number> {
  const boxes = await map.locator('.aio-mk[data-kind="photo"] .aio-mk-p').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }),
  );
  return Math.min(...boxes.map((b) => Math.hypot(b.x - at.x, b.y - at.y)));
}

test('edit one photo, shift two, undo and redo, reset on the map, pinned greyed', async ({
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const dir = await createPositionProject(dataRoot.root);
  await win.reload();
  await openPositionProject(win);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 30_000 });
  await stageMode(win, 'Split');
  const manifestBefore = await readFile(join(dir, 'manifest.json'), 'utf8');

  // (a) one photo: its X, Y, Z; a new Z is an offset, the manifest unchanged, the tile Edited
  await openMedia(win);
  await expect(tile(win, 'g1')).toBeVisible({ timeout: 30_000 });
  await editFromTile(win, 'g1');
  await expect(panel(win)).toContainText('Position');
  await expect(win.getByTestId('position-input-x')).toHaveValue('-8.000');
  await expect(win.getByTestId('position-input-y')).toHaveValue('-6.000');
  await expect(win.getByTestId('position-input-z')).toHaveValue('20.000');
  await win.getByTestId('position-input-z').fill('abc');
  await expect(win.getByTestId('position-input-z')).toHaveAttribute('aria-invalid', 'true');
  await expect(win.getByTestId('position-save')).toBeDisabled();
  await win.getByTestId('position-input-z').fill('25');
  await win.getByTestId('position-save').click();
  await expect(panel(win)).toBeHidden();
  await expect(win.getByTestId('position-text')).toHaveText('Moved 1 photo.');
  await expect.poll(() => offsetOf(dir, 'g1').then((o) => near(o, [0, 5, 0]))).toBe(true);
  expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifestBefore);
  await expect(edited(win, 'g1')).toBeVisible();
  await expect(edited(win, 'g2')).toHaveCount(0);

  // (b) two picked photos take one shift; Undo restores both exactly, Redo puts them back
  await tile(win, 'g2').click({ modifiers: ['Control'] });
  await expect(tile(win, 'g1')).toHaveAttribute('data-picked', 'true');
  await expect(tile(win, 'g2')).toHaveAttribute('data-picked', 'true');
  await editFromTile(win, 'g2');
  await expect(panel(win)).toContainText('Shift 2 photos');
  await expect(win.getByTestId('position-input-y')).toHaveValue('');
  await win.getByTestId('position-input-y').fill('10');
  await win.getByTestId('position-input-y').press('Enter');
  await expect(win.getByTestId('position-text')).toHaveText('Moved 2 photos.');
  await expect.poll(() => offsetOf(dir, 'g1').then((o) => near(o, [0, 5, -10]))).toBe(true);
  expect(near(await offsetOf(dir, 'g2'), [0, 0, -10])).toBe(true);
  await expect(edited(win, 'g2')).toBeVisible();
  await win.getByTestId('position-undo').click();
  await expect(win.getByTestId('position-text')).toHaveText('Undid the position change.');
  await expect.poll(() => offsetOf(dir, 'g1')).toEqual([0, 5, 0]);
  expect(await correctionOf(dir, POS_LAYER, 'g2')).toBeUndefined();
  await win.getByTestId('position-redo').click();
  await expect(win.getByTestId('position-text')).toHaveText('Redid the position change.');
  await expect.poll(() => offsetOf(dir, 'g2').then((o) => near(o, [0, 0, -10]))).toBe(true);
  expect(near(await offsetOf(dir, 'g1'), [0, 5, -10])).toBe(true);
  expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifestBefore);

  // (d) a pinned photo: Edit position greyed with the reason
  const pn = tile(win, 'pn');
  await pn.scrollIntoViewIfNeeded();
  await pn.click({ button: 'right' });
  const greyed = win.getByTestId('ctx-item-photos.editPosition');
  await expect(greyed).toHaveAttribute('aria-disabled', 'true');
  // the reason shows on hover (the menu's own tip)
  await expect(greyed).toHaveAttribute('title', 'Pinned: use Move pin.');
  await win.keyboard.press('Escape');

  // (c) the map: both edited markers wear the ring; Reset to original on g2's marker puts it back
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  const map = win.locator('.maplibregl-map').first();
  await expect(map).toBeVisible({ timeout: 30_000 });
  const ringed = map.locator('.aio-mk[data-kind="photo"][data-edited="true"]');
  await expect(ringed).toHaveCount(2, { timeout: 30_000 });
  const g2Edited: Vec3 = [G2_POS[0], G2_POS[1], G2_POS[2] - 10];
  await settleMap(win, g2Edited);
  let stem = Infinity;
  await expect
    .poll(async () => {
      stem = await nearestPlate(map, await mapPoint(win, g2Edited));
      return stem;
    })
    .toBeLessThan(30);
  const at = await mapPoint(win, g2Edited);
  await win.mouse.move(at.x + 4, at.y + 4);
  await win.mouse.move(at.x, at.y, { steps: 2 });
  await win.mouse.click(at.x, at.y, { button: 'right' });
  const list = win.getByTestId('photo-menu-list');
  if (await list.isVisible().catch(() => false))
    await list.getByRole('menuitem', { name: 'g2' }).click();
  await expect(win.getByTestId('photo-menu')).toBeVisible();
  await expect(win.getByTestId('ctx-item-photos.editPosition')).toBeVisible();
  await win.getByTestId('ctx-item-photos.resetPosition').click();
  await expect(win.getByTestId('position-text')).toHaveText(
    'Put 1 photo back where it was imported.',
  );
  await expect.poll(() => correctionOf(dir, POS_LAYER, 'g2')).toBeUndefined();
  expect(near(await offsetOf(dir, 'g1'), [0, 5, -10])).toBe(true);
  await expect(ringed).toHaveCount(1);
  // the marker stands at the imported place again (as far from it as it stood from the edit)
  await expect
    .poll(async () => Math.abs((await nearestPlate(map, await mapPoint(win, G2_POS))) - stem))
    .toBeLessThan(2);
  expect(await nearestPlate(map, await mapPoint(win, g2Edited))).toBeGreaterThan(stem + 10);
  expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifestBefore);
});

test('a thermal photo without metadata is placed at its visual twin; Reset takes it back', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const dir = await createPositionProject(dataRoot.root);
  // the visual twin 25 m north of the origin; the FLIR-written thermal a few metres off with a
  // negative altitude written as unsigned (4,295 km up through the old reader)
  const visualLL = lonLatOf([0, 0, -25]);
  const thermalLL = lonLatOf([3, 0, -22]);
  const visual = join(dataRoot.base, 'X_0006.jpg');
  const thermal = join(dataRoot.base, 'X_0005_R.JPG');
  await writeFile(
    visual,
    await onPixels(
      xt2Visual({
        dateTimeOriginal: '2026:10:01 10:00:00',
        lat: visualLL[1],
        lon: visualLL[0],
        absAlt: -4.501,
        relAlt: 30,
      }),
      [90, 140, 90],
    ),
  );
  await writeFile(
    thermal,
    await onPixels(
      xt2Thermal({
        dateTimeOriginal: '2026:10:01 10:00:01',
        lat: thermalLL[1],
        lon: thermalLL[0],
        alt: -4.502,
      }),
      [200, 90, 60],
    ),
  );
  await win.reload();
  await openPositionProject(win);

  await app.evaluate(
    ({ dialog }, files) => {
      const orig = dialog.showOpenDialog.bind(dialog);
      (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
        (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
        return Promise.resolve({ canceled: false, filePaths: files });
      };
    },
    [visual, thermal],
  );
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Import raw data');
  await win.keyboard.press('Enter');
  const card = win.getByTestId('import-heights');
  const importPanel = win.getByTestId('import-panel');
  await expect(card.or(importPanel)).toBeVisible({ timeout: 30_000 });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Import' }).click();
  await expect(importPanel).toContainText('Imported 2 of 2 files', { timeout: 30_000 });
  await expect(importPanel).toContainText('placed at its visual twin');

  // the new photos layer: the thermal sits at its twin as a correction, its own place plausible
  const m = await readManifest(dir);
  const layer = m.layers.find((l) => l.kind === 'photos' && l.id !== POS_LAYER);
  const items = layer?.items ?? [];
  const th = items.find((i) => i.id.includes('0005'));
  const vi = items.find((i) => i.id.includes('0006'));
  if (!layer || !th?.pos || !vi?.pos) throw new Error('import gave no placed thermal pair');
  expect(Math.abs(th.pos[1])).toBeLessThan(1000);
  expect(th.q).toEqual(vi.q);
  await expect.poll(() => offsetOf(dir, th.id, layer.id)).toBeDefined();
  const off = (await offsetOf(dir, th.id, layer.id)) ?? [0, 0, 0];
  const placed = th.pos.map((v, i) => v + (off[i] ?? 0));
  expect(near(placed, vi.pos)).toBe(true);

  await openMedia(win);
  await expect(edited(win, th.id)).toBeVisible({ timeout: 30_000 });
  await expect(edited(win, vi.id)).toHaveCount(0);
  const el = tile(win, th.id);
  await el.scrollIntoViewIfNeeded();
  await el.click({ button: 'right' });
  await win.getByTestId('ctx-item-photos.resetPosition').click();
  await expect.poll(() => offsetOf(dir, th.id, layer.id)).toBeUndefined();
  await expect(edited(win, th.id)).toHaveCount(0);
  // Reset puts it at its own place: the manifest's record of it is unchanged
  expect((await itemOf(dir, layer.id, th.id))?.pos).toEqual(th.pos);
});

test('re-read photo positions: heights and directions from the files, hand moves kept', async ({
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  // two XT2 visual photos whose records still hold the old reader's answer: the barometric
  // height and no view direction; v2 was moved 10 m up by hand since
  const XT2 = 'photos-xt2';
  const shots = [
    { id: 'v1', at: [5, 0, -30] as Vec3, relAlt: 30, yaw: 63.1, stale: [5, -40, -30] as Vec3 },
    { id: 'v2', at: [-5, 0, -30] as Vec3, relAlt: 25, yaw: 120, stale: [-5, -40, -30] as Vec3 },
  ];
  const files: Record<string, Uint8Array> = {};
  for (const s of shots) {
    const ll = lonLatOf(s.at);
    files[`photos/xt2/${s.id}.jpg`] = await onPixels(
      xt2Visual({
        dateTimeOriginal: '2026:10:01 10:10:00',
        lat: ll[1],
        lon: ll[0],
        absAlt: -16,
        relAlt: s.relAlt,
        gimbal: { yaw: s.yaw, pitch: -45, roll: 0 },
      }),
    );
  }
  const dir = await createPositionProject(dataRoot.root, {
    files,
    extraLayers: [
      {
        kind: 'photos',
        id: XT2,
        name: 'XT2 photos',
        capture: 'c1',
        items: shots.map((s) => ({
          id: s.id,
          src: { path: `photos/xt2/${s.id}.jpg` },
          takenAt: '2026-10-01T10:10:00+03:00',
          pos: s.stale,
        })),
      },
    ],
  });
  await writeFile(
    join(dir, 'orientation.json'),
    JSON.stringify({
      schema: 'aio.orientation/1',
      clips: {},
      photos: { [XT2]: { v2: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, 10, 0] } } },
    }),
  );
  await win.reload();
  await openPositionProject(win);

  // right-click the dataset in the sidebar: Re-read photo positions, confirm
  const folder = win.getByTestId('date-folder-c1');
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await win.getByTestId('date-name-c1').click();
  const group = folder.getByTestId('tree-group-toggle-photos');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  const row = win.getByTestId(`tree-row-${XT2}`);
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layers.rereadPhotos').click();
  await expect(win.getByTestId('reread-confirm')).toBeVisible({ timeout: 30_000 });
  await win.getByTestId('reread-yes').click();
  const toast = win.getByTestId('export-toast-message');
  await expect(toast).toContainText('Re-read 2 photos.', { timeout: 30_000 });
  await expect(toast).toContainText('1 moved by hand kept its place.');

  // v1: the height under the relative rule (take-off at the origin, H 0) and the gimbal's view
  const s1 = shots[0];
  if (!s1) throw new Error('no shot');
  const v1 = await itemOf(dir, XT2, 'v1');
  expect(near(v1?.pos, [s1.at[0], s1.relAlt, s1.at[2]], 0.01)).toBe(true);
  const ll1 = lonLatOf(s1.at);
  const q1 = cameraQuatFromGimbal(s1.yaw - gridConvergenceDeg(ll1[0], ll1[1], EPSG), -45, 0);
  expect(near(v1?.q, [q1[0], q1[1], q1[2], q1[3]], 1e-5)).toBe(true);
  expect(await correctionOf(dir, XT2, 'v1')).toBeUndefined();

  // v2: re-read too, but its corrected place stays where it was put (the offset re-anchored)
  const v2 = await itemOf(dir, XT2, 'v2');
  expect(near(v2?.pos, [-5, 25, -30], 0.01)).toBe(true);
  expect(v2?.q).toBeDefined();
  const off = (await offsetOf(dir, 'v2', XT2)) ?? [0, 0, 0];
  const placed = (v2?.pos ?? [NaN, NaN, NaN]).map((v, i) => v + (off[i] ?? 0));
  expect(near(placed, [-5, -30, -30])).toBe(true);
  // the other dataset is left alone
  expect((await itemOf(dir, POS_LAYER, 'g1'))?.pos).toEqual(G1_POS);
});
