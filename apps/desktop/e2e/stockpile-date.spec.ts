/**
 * A stockpile project (volumes over two surveys) reopens on the survey it was left on, not on
 * the volumes' last survey, and showing the timeline does not forget that date. A minimal
 * synthetic project: two dated terrains, a volumes file, no height grids (the volumes reach
 * `ready` without them; the grids are only fetched for a pile profile). Off-screen, no network.
 */
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base, tinyGlb, type DataRoot } from './fixtures';

const ID = 'e2e-stockpile-dates';
const NAME = 'E2E stockpile dates';
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const dates = [
  { id: 'd1', epoch: 'e1', date: '2024-09-04', label: '4 Sep 2024' },
  { id: 'd2', epoch: 'e2', date: '2024-10-02', label: '2 Oct 2024' },
];

async function writeStockpile(dataRoot: DataRoot): Promise<void> {
  const dir = join(dataRoot.root, 'projects', ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await writeFile(join(dir, 'models', 'terrain.glb'), tinyGlb());
  const manifest: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: NAME,
    customer: 'E2E',
    site: 'Synthetic stockpile, 2 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: dates.map((d) => ({ id: d.id, label: d.label, date: d.date })),
    layers: dates.map((d) => ({
      kind: 'mesh' as const,
      id: `terrain-${d.id}`,
      name: `Terrain ${d.date}`,
      capture: d.id,
      src: { path: 'models/terrain.glb' },
      transform: I,
    })),
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
  const fc = { fill: 0, cut: 0, net: 0 };
  await writeFile(
    join(dir, 'volumes.json'),
    JSON.stringify({
      schema: 'aio.volumes/1',
      densityTPerM3: 1.6,
      deadbandM: 0.1,
      defaultBase: 'tin',
      bases: [{ id: 'tin', label: 'Triangulated toe' }],
      captures: dates.map((d) => ({
        epoch: d.epoch,
        captureId: d.id,
        date: d.date,
        label: d.label,
      })),
      piles: [],
      totals: {},
      pileChange: fc,
      siteChange: fc,
    }),
  );
}

/**
 * The stockpile project, written before the app starts (the library is read at launch, not on a
 * reload): list `stockpile` before `win`.
 */
const test = base.extend<{ stockpile: { id: string } }>({
  stockpile: async ({ dataRoot }, use) => {
    await writeStockpile(dataRoot);
    await use({ id: ID });
  },
});

interface Probe {
  __stratlas: { volumetric: { getState(): { status: string; epoch: string } } };
}
const volumes = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas.volumetric.getState();
    return { status: s.status, epoch: s.epoch };
  });

async function openStockpile(win: Page, id: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
  await expect.poll(async () => (await volumes(win)).status, { timeout: 30_000 }).toBe('ready');
}

async function reopen(win: Page, id: string): Promise<void> {
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openStockpile(win, id);
}

test.describe('stockpile survey date', () => {
  test('opens on the last survey the first time, then on the survey it was left on', async ({
    stockpile,
    win,
  }) => {
    await openStockpile(win, stockpile.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await win.getByTestId('date-name-d1').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await expect.poll(async () => (await volumes(win)).epoch).toBe('e1');
    await reopen(win, stockpile.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await expect.poll(async () => (await volumes(win)).epoch).toBe('e1');
  });

  test('showing the timeline does not forget the date', async ({ stockpile, win }) => {
    await openStockpile(win, stockpile.id);
    await win.getByTestId('date-name-d1').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    // a project without video starts with the timeline folded into the thin bar
    await win.getByTestId('timeline-bar').getByRole('button').click();
    await expect(win.getByTestId('timeline-bar')).toHaveCount(0);
    await reopen(win, stockpile.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await expect.poll(async () => (await volumes(win)).epoch).toBe('e1');
    await expect(win.getByTestId('timeline-bar')).toHaveCount(0);
  });
});
