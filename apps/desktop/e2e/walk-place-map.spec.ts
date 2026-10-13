/**
 * Placing a walk on the map: a project with a coordinate system and no drawing, the walk placed
 * by its start and end on the map, its End handle dragged, saved; the pose keeps the walk's L.
 * Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import { toWgs84 } from '@aio/geo';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  createWalkProject,
  ffmpegReady,
  openWalkProject,
  poseBendM,
  rowAction,
  UTM,
  WALK_END,
  WALK_LAYER,
  WALK_START,
} from './walkFixture';

/** The overlay layer of the walk's preview: `aio-ov-<overlay id>-<layer id>` (maps controller). */
const PREVIEW_LAYER = `aio-ov-walk-${WALK_LAYER}-preview-preview`;

/** Lon/lat of a model point (x east, z south) in the fixture's UTM frame. */
function lonLat(local: [number, number]): [number, number] {
  const ll = toWgs84([UTM.origin[0] + local[0], UTM.origin[1] - local[1], 0], UTM.epsg);
  return [ll[0], ll[1]];
}

/** The page point of a model point on the main map (the one on screen). */
async function mapPoint(win: Page, local: [number, number]): Promise<{ x: number; y: number }> {
  return win.evaluate((ll) => {
    interface MapEl extends Element {
      __aioMap: {
        project(ll: [number, number]): { x: number; y: number };
        getContainer(): HTMLElement;
      };
    }
    const el = [...document.querySelectorAll('*')].find(
      (e) => '__aioMap' in e && e.getBoundingClientRect().width > 0,
    ) as MapEl | undefined;
    if (!el) throw new Error('no map on screen');
    const p = el.__aioMap.project(ll);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, lonLat(local));
}

test.describe('placing a walk on the map', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a walk is placed on the map by its start and end, and keeps its shape', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const dir = await createWalkProject(dataRoot.root, { crs: 'utm', drawing: false });
    await win.reload();
    await openWalkProject(win);
    await rowAction(win, 'place');
    const strip = win.getByTestId('walk-place-strip');
    await expect(strip).toHaveAttribute('data-step', 'start', { timeout: 30_000 });
    await expect(strip.getByTestId('walk-place-on')).toHaveValue('@model');

    // frame the walk: the middle of the L at zoom 18 (about 0.4 m a pixel here)
    const centre = lonLat([20, -15]);
    await expect
      .poll(() =>
        win.evaluate((c) => {
          const el = [...document.querySelectorAll('*')].find(
            (e) => '__aioMap' in e && e.getBoundingClientRect().width > 0,
          ) as
            | (Element & {
                __aioMap: {
                  jumpTo(o: { center: [number, number]; zoom: number }): void;
                  loaded(): boolean;
                };
              })
            | undefined;
          if (!el) return false;
          el.__aioMap.jumpTo({ center: c, zoom: 18 });
          return true;
        }, centre),
      )
      .toBe(true);
    await win.waitForTimeout(500);

    // the ghost follows the pointer
    const s = await mapPoint(win, WALK_START);
    await win.mouse.move(s.x, s.y);
    await win.mouse.move(s.x + 2, s.y + 1);
    await expect
      .poll(() =>
        win.evaluate((id) => {
          const el = [...document.querySelectorAll('*')].find(
            (e) => '__aioMap' in e && e.getBoundingClientRect().width > 0,
          ) as (Element & { __aioMap: { getLayer(id: string): unknown } }) | undefined;
          return Boolean(el?.__aioMap.getLayer(id));
        }, PREVIEW_LAYER),
      )
      .toBe(true);

    // start and end, as the synthetic walk went
    await win.mouse.click(s.x, s.y);
    await expect(strip).toHaveAttribute('data-step', 'end');
    const e = await mapPoint(win, WALK_END);
    await win.mouse.click(e.x, e.y);
    await expect(strip).toHaveAttribute('data-step', 'placed');

    // drag End 5 m south
    const to = await mapPoint(win, [WALK_END[0], WALK_END[1] + 5]);
    await win.mouse.move(e.x, e.y);
    await win.mouse.down();
    await win.mouse.move(to.x, to.y, { steps: 6 });
    await win.mouse.up();
    await expect(strip).toHaveAttribute('data-step', 'placed');

    await strip.getByTestId('walk-place-save').click();
    await expect(win.getByTestId('walk-place-strip')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => poseBendM(dir), { timeout: 30_000 }).toBeGreaterThan(15);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      layers: { id: string; place?: { pins: { at: [number, number] }[]; placedOn?: string } }[];
    };
    const layer = manifest.layers.find((l) => l.id === WALK_LAYER);
    expect(layer?.place?.placedOn).toBe('@model');
    // the End pin moved south with the drag (z grows southward)
    expect(layer?.place?.pins[1]?.at[1]).toBeGreaterThan(-28);
  });
});
