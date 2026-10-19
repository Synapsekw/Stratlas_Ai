/**
 * Area-scoped change on the change demo (C8, synthetic): a polygon "Area A" drawn around one of
 * truth's imagery changes, right-clicked in the Datasets tree, "Compare with previous survey",
 * Compare in the confirm box (volumes off). The imagery change runs for that area only: its own
 * set beside the whole-map one (`<pair>-raster-area-area-a`), every region inside the polygon,
 * none from the rest of the site, and the Changes tab shows the area's entry. The pipelines run
 * as jobs with the development Python (`uv sync` in python/, or QUADRION_E2E_PYTHON); skipped
 * without it.
 */
import { MeasurementsFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { box, inside, meets, type Item, type RasterTruth } from './changeRaster';
import {
  expect,
  hasPipelinePython,
  openChangeDemo,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import { measureRow, measureTree } from './island';

test.use({ appEnv: PIPELINE_ENV });

interface Win {
  __stratlas: {
    workspace: { getState(): { project: { manifest: { layers: { id: string }[] } } | null } };
  };
}

const layerIds = (win: Page) =>
  win.evaluate(() =>
    ((window as unknown as Win).__stratlas.workspace.getState().project?.manifest.layers ?? []).map(
      (l) => l.id,
    ),
  );

test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);

test('compare one area with the previous survey', async ({ demoProject }, testInfo) => {
  test.setTimeout(420_000);
  const { win, root, truth } = demoProject;
  const { from, to } = truth.captures;
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  const pair = `${from}-${to}`;
  const setId = `${pair}-raster-area-area-a`;

  // 1. a polygon 3 m around truth's first change R, clear of another change S
  const rt = truth.changes.raster as unknown as RasterTruth;
  const r = rt.expected[0];
  if (!r) throw new Error('no imagery change in truth.json');
  const area = box(r.outlineLocal, 3);
  const s = rt.expected.find((e) => e !== r && !meets({ verdict: '', bounds: bounds(e) }, area));
  if (!s) throw new Error('no change outside the area');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    origin: [number, number, number];
  };
  const [ox, oy, oz] = manifest.origin;
  // local x grows east, z grows south
  const corner = (x: number, z: number): [number, number, number] => [ox + x, oy - z, oz];
  await mkdir(join(root, 'survey'), { recursive: true });
  await writeFile(
    join(root, 'survey', 'measurements.json'),
    JSON.stringify(
      MeasurementsFile.parse({
        schema: 'aio.measurements/1',
        measurements: [
          {
            id: 'area-a',
            family: 'polygon',
            tool: 'area',
            label: 'Area A',
            scope: { kind: 'survey', capture: to },
            points: [
              corner(area.x0, area.z0),
              corner(area.x1, area.z0),
              corner(area.x1, area.z1),
              corner(area.x0, area.z1),
            ],
            items: [],
            results: [],
            createdAt: '2026-10-19T00:00:00Z',
          },
        ],
      }),
      null,
      1,
    ),
  );
  // open the project again so the measurements are read
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openChangeDemo(win);

  // 2. right-click Area A in the Datasets tree: Compare with previous survey
  await measureTree(win);
  // at 1100 px the row's area and date squeeze its name to no width: right-click the row's icon
  const row = measureRow(win, 'Area A');
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right', position: { x: 24, y: 13 } });
  const item = win.getByTestId('ctx-item-change.areaCompare');
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await item.click();

  // 3. the confirm box: both dates and the polygon, volumes off by default
  const dialog = win.getByTestId('area-compare-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('area-compare-name')).toHaveText('Area A');
  const dates = dialog.getByTestId('area-compare-dates');
  await expect(dates).toContainText('2 Mar 2026');
  await expect(dates).toContainText('13 Apr 2026');
  await expect(dialog.getByTestId('area-compare-volumes')).not.toBeChecked();
  await dialog.getByTestId('area-compare-run').click();

  // 4. the area's layers in the reloaded manifest
  await expect
    .poll(() => layerIds(win), { timeout: 240_000, intervals: [1000] })
    .toEqual(expect.arrayContaining([`${setId}-heat`, `${setId}-regions`]));
  await expect(dialog).toHaveCount(0);

  // 5. the area's set: its scope, R found, every region inside the polygon, nothing near S
  const set = JSON.parse(await readFile(join(root, 'change', `${setId}.json`), 'utf8')) as {
    scope?: unknown;
    items: Item[];
  };
  expect(set.scope).toEqual({ id: 'area-a', name: 'Area A' });
  expect(set.items.length).toBeGreaterThan(0);
  expect(set.items.some((i) => inside(i.at, area))).toBe(true);
  for (const i of set.items) expect(inside(i.at, area), JSON.stringify(i.at)).toBe(true);
  const near = box(s.outlineLocal, 1);
  for (const i of set.items) expect(inside(i.at, near), JSON.stringify(i.at)).toBe(false);
  // no whole-map run started
  expect(existsSync(join(root, 'change', `${pair}-raster.json`))).toBe(false);

  // 6. the Changes tab on the area's entry: its regions only
  const panel = win.getByTestId('change-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('change-area')).toHaveValue('area-a');
  await expect(panel.getByTestId('change-row')).toHaveCount(set.items.length);

  // 7. the picture, checked by eye
  await win.screenshot({ path: testInfo.outputPath('change-area.png') });
  expect(errors).toEqual([]);
});

/** A truth change's x and z extent as region bounds (y unused). */
function bounds(e: RasterTruth['expected'][number]): NonNullable<Item['bounds']> {
  const b = box(e.outlineLocal);
  return { min: [b.x0, 0, b.z0], max: [b.x1, 0, b.z1] };
}
