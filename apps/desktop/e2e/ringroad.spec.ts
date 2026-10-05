/**
 * End to end on the real 1st Ring Road project (2,115 defects, kit-pyramid ortho, road.json).
 * Runs only on machines that hold the project at E:\Stratlas Data\projects\ringroad (or under
 * STRATLAS_RINGROAD_DATA); skipped elsewhere. Read-only: it never edits the project.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_RINGROAD_DATA ?? 'E:\\Stratlas Data';
const RR = join(DATA, 'projects', 'ringroad');

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const base = await mkdtemp(join(tmpdir(), 'aio-rr-'));
    const network = new NetworkGuard();
    const app = await launchApp({
      base,
      root: DATA,
      userData: join(base, 'user'),
      projectId: 'ringroad',
      projectDir: RR,
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.skip(!existsSync(join(RR, 'road.json')), `Ring Road project not found at ${RR}`);
test.setTimeout(180_000);

interface MapLike {
  getStyle(): { layers: { id: string }[]; sources: Record<string, unknown> };
  getLayoutProperty(layer: string, name: string): unknown;
  queryRenderedFeatures(o: { layers: string[] }): unknown[];
  loaded(): boolean;
}

/** Facts about the MapLibre map behind the map pane (through the controller's test hook). */
function mapFacts(win: Page) {
  return win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find(
      (d) => '__aioMap' in d,
    ) as unknown as { __aioMap: MapLike } | undefined;
    const map = host?.__aioMap;
    // a restarted map (flight paths toggled) has no style until the new one replaces it
    const style = map?.getStyle();
    if (!map || !style) return null;
    const ids = style.layers.map((l) => l.id);
    const rendered = (id: string) =>
      ids.includes(id) ? map.queryRenderedFeatures({ layers: [id] }).length : -1;
    return {
      shapes: rendered('aio-issue-shape-line'),
      pci: rendered('aio-ov-road-pci-fill'),
      centreline: rendered('aio-ov-road-centreline-line'),
      pyramidTiles: Object.keys(map.getStyle().sources).filter((s) => s.startsWith('aio-pyr-'))
        .length,
      pciVisible: map.getLayoutProperty('aio-ov-road-pci-fill', 'visibility'),
    };
  });
}

test('the Ring Road opens in the native road workspace with its map overlays', async ({ win }) => {
  await win.getByTestId('project-card').filter({ hasText: 'Ring Road' }).first().click();

  // Map first, the chainage ruler in place of the timeline, every defect listed.
  await expect(win.getByLabel('Chainage', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'map');
  await expect(win.getByTestId('defect-count')).toHaveText('2,115 of 2,115 defects');
  // The list is virtualised: far fewer rows in the DOM than defects.
  expect(await win.locator('.rr-row').count()).toBeLessThan(80);

  // The centreline overlay renders.
  await expect
    .poll(async () => (await mapFacts(win))?.centreline ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Pick the worst defect: the map frames its polygon over the ortho at full detail, and the
  // close-up opens beside it.
  await win.locator('.rr-row').first().click();
  await expect(win.getByRole('complementary', { name: 'Close-up' })).toBeVisible();
  await expect(
    win.getByRole('complementary', { name: 'Close-up' }).locator('img').first(),
  ).toBeVisible();
  await expect
    .poll(async () => (await mapFacts(win))?.shapes ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await mapFacts(win))?.pyramidTiles ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // P shows the PCI grid (with its legend); the severity assumption switches the colouring.
  await win.keyboard.press('p');
  await expect(win.getByLabel('PCI legend')).toBeVisible();
  await expect.poll(async () => (await mapFacts(win))?.pciVisible).toBe('visible');
  await expect
    .poll(async () => (await mapFacts(win))?.pci ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await win.keyboard.press('d');
  await expect(win.getByLabel('Density legend')).toBeVisible();
  await win.keyboard.press('d');

  // Filters: only High severity.
  await win
    .getByRole('group', { name: 'Severity' })
    .getByRole('button', { name: 'Medium' })
    .click();
  await win.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'Low' }).click();
  await expect(win.getByTestId('defect-count')).toHaveText('29 of 2,115 defects');
  await win.getByRole('button', { name: 'Reset' }).click();

  // Dragging on the ruler filters a chainage range.
  const track = win.getByRole('slider', { name: 'Chainage, km' });
  const t = await track.boundingBox();
  if (!t) throw new Error('no chainage track');
  await win.mouse.move(t.x + t.width * 0.2, t.y + 10);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width * 0.4, t.y + 10, { steps: 6 });
  await win.mouse.up();
  await expect(win.getByTestId('defect-count')).toContainText(' · km ');
  await win.getByRole('button', { name: 'Clear range' }).click();
  await expect(win.getByTestId('defect-count')).toHaveText('2,115 of 2,115 defects');

  // Measure a distance on the map.
  await win.getByRole('button', { name: 'Measure on the map' }).click();
  const canvas = win.locator('.pane-map canvas').first();
  const c = await canvas.boundingBox();
  if (!c) throw new Error('no map canvas');
  await win.mouse.click(c.x + c.width * 0.3, c.y + c.height * 0.5);
  await win.mouse.click(c.x + c.width * 0.6, c.y + c.height * 0.5);
  await expect(win.getByTestId('measure-value')).toHaveText(/^\d+\.\d\d (k?m)$/);
  await win.getByRole('button', { name: 'Done', exact: true }).click();

  // In 3D the defects lie draped on the ortho.
  await win.keyboard.press('1');
  await expect
    .poll(() =>
      win.evaluate(() => {
        const stage = (
          window as unknown as {
            __stratlas: {
              stage(): {
                scene: { getObjectByName(n: string): { children: unknown[] } | undefined };
              } | null;
            };
          }
        ).__stratlas.stage();
        return stage?.scene.getObjectByName('annotate-map-shapes')?.children.length ?? 0;
      }),
    )
    .toBeGreaterThanOrEqual(2);
});
