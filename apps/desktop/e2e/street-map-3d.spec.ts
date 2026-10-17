/**
 * The 3D scene sits on the street map. The tiny project (a model on the ground, placed on the
 * Earth) with a synthetic street pack over its site (empty vector tiles: valid, nothing drawn)
 * opens with the street map under it: the rings in the scene, nearest first, instead of the plain
 * ground, and the island's button pressed. The button takes it away and brings it back, and the
 * choice is kept for the project. The button is in the island's Display set, at every width.
 */
import { toWgs84 } from '@aio/geo';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, test as base, tinyManifest, type DataRoot } from './fixtures';
import { islandGroup } from './island';

const NAME = 'E2E tiny project';

interface Probe {
  __stratlas: {
    stage(): {
      scene: {
        getObjectByName(n: string): { visible: boolean; children: unknown[] } | undefined;
      };
    } | null;
  };
}

/** A street pack over the tiny project's site, down to street zoom. */
async function writePack(data: DataRoot): Promise<void> {
  const m = tinyManifest();
  const epsg = 'epsg' in m.crs ? m.crs.epsg : 0;
  const [lon, lat] = toWgs84([m.origin[0], m.origin[1], 0], epsg);
  const bbox: [number, number, number, number] = [lon - 0.03, lat - 0.03, lon + 0.03, lat + 0.03];
  const archive = pmtilesArchive({
    tiles: tilesOver(bbox, 0, 14, () => Buffer.alloc(0)),
    bbox,
    minZoom: 0,
    maxZoom: 14,
  });
  await writeFile(join(data.root, 'packs', 'e2e-site.pmtiles'), archive);
  await writeFile(
    join(data.root, 'packs', 'e2e-site.json'),
    JSON.stringify({
      id: 'e2e-site',
      label: 'E2E site streets',
      bbox,
      maxZoom: 14,
      sizeBytes: archive.length,
    }),
  );
}

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    await writePack(dataRoot);
    await use(dataRoot);
  },
});

test.setTimeout(180_000);

/** The street map group's rings and whether the plain ground is drawn. */
const ground = (win: Page) =>
  win.evaluate(() => {
    const scene = (window as unknown as Probe).__stratlas.stage()?.scene;
    const group = scene?.getObjectByName('basemap:site-street-map');
    return {
      rings: group?.visible ? group.children.length : 0,
      plain: scene?.getObjectByName('env:ground')?.visible ?? null,
    };
  });

async function openProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 30_000 });
}

/** The street map button, in the Display workbench. */
async function streetButton(win: Page) {
  const full = await islandGroup(win, 'display');
  const button = full.getByTestId('street-map-3d');
  await expect(button).toBeVisible();
  return button;
}

test('a project opens on the street map, and the button takes it away and brings it back', async ({
  win,
}) => {
  await openProject(win);

  // on by default, though the project has a model of its own: the near ring first, then the rest
  await expect.poll(() => ground(win), { timeout: 60_000 }).toMatchObject({ plain: false });
  await expect.poll(async () => (await ground(win)).rings, { timeout: 90_000 }).toBe(3);

  const button = await streetButton(win);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAccessibleName('Hide the street map under the site');
  // the Layers popover no longer has the checkbox
  await expect(win.getByText('Street map under the site', { exact: true })).toHaveCount(0);

  // off: the rings go and the plain ground is back
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAccessibleName('Show the street map under the site');
  await expect.poll(() => ground(win), { timeout: 15_000 }).toEqual({ rings: 0, plain: true });

  // the choice is kept for the project: after a reload it opens without the street map
  await win.reload();
  await openProject(win);
  const again = await streetButton(win);
  await expect(again).toHaveAttribute('aria-pressed', 'false');
  // longer than the wait for the scene and the first ring took above
  await win.waitForTimeout(6000);
  expect(await ground(win)).toEqual({ rings: 0, plain: true });

  // and on again
  await again.click();
  await expect(again).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => ground(win), { timeout: 60_000 }).toMatchObject({ plain: false });
  await expect.poll(async () => (await ground(win)).rings, { timeout: 90_000 }).toBe(3);
});

test.describe('the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the street map button is in the Display set there too, and works from there', async ({
    win,
  }) => {
    await openProject(win);
    await expect.poll(() => ground(win), { timeout: 60_000 }).toMatchObject({ plain: false });
    // the island keeps every tool where it is at every width (D6): nothing folds away
    await expect(win.getByTestId('street-map-3d')).toHaveCount(0);
    const button = await streetButton(win);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    await expect.poll(() => ground(win), { timeout: 15_000 }).toEqual({ rings: 0, plain: true });
  });
});
