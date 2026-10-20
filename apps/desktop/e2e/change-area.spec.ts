/**
 * Area-scoped change on the change demo (C8, synthetic): a polygon "Area A" drawn around one of
 * truth's imagery changes, right-clicked in the Datasets tree, "Compare with previous survey",
 * Compare in the confirm box (volumes off). The imagery change runs for that area only: its own
 * set beside the whole-map one (`<pair>-raster-area-area-a`), every region inside the polygon,
 * none from the rest of the site, and the Changes tab shows the area's entry. Both dates are lined
 * up 5 m east (past the polygon's 3 m margin), so the mask must follow the polygon where its date
 * draws it. After that line-up the area's set reads stale, and its Run again replays the area
 * (still scoped, still chosen, cut where the polygon is drawn now) while the whole-map set stays
 * as it was. The pipelines run as jobs with the
 * development Python (`uv sync` in python/, or QUADRION_E2E_PYTHON); skipped without it.
 */
import { fromWgs84 } from '@aio/geo';
import { MeasurementsFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { box, inside, meets, type Item, type RasterTruth } from './changeRaster';
import {
  type ChangeDemoTruth,
  expect,
  hasPipelinePython,
  openChangeDemo,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import { measureRow, measureTree, openBench } from './island';

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

type XZBox = ReturnType<typeof box>;
type Change = RasterTruth['expected'][number];

/** A truth change's x and z extent as region bounds (y unused). */
function bounds(e: Change): NonNullable<Item['bounds']> {
  const b = box(e.outlineLocal);
  return { min: [b.x0, 0, b.z0], max: [b.x1, 0, b.z1] };
}

/** Load the window again and open the change demo: the project is read from disk anew. */
async function reopen(win: Page): Promise<void> {
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openChangeDemo(win);
}

/**
 * Write the polygon "Area A" 3 m around truth's first imagery change R (in survey `to`) and open
 * the project again so the measurements are read. Returns the polygon's box and another change S
 * that lies outside it.
 */
async function seedArea(
  win: Page,
  root: string,
  truth: ChangeDemoTruth,
): Promise<{ area: XZBox; s: Change }> {
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
            scope: { kind: 'survey', capture: truth.captures.to },
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
  await reopen(win);
  return { area, s };
}

/** Right-click Area A in the Datasets tree, Compare with previous survey: the confirm box. */
async function askCompare(win: Page) {
  await measureTree(win);
  // at 1100 px the row's area and date squeeze its name to no width: right-click the row's icon
  const row = measureRow(win, 'Area A');
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right', position: { x: 24, y: 13 } });
  const item = win.getByTestId('ctx-item-change.areaCompare');
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await item.click();
  const dialog = win.getByTestId('area-compare-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Wait for a set's heat and regions layers in the reloaded manifest. */
async function layersOf(win: Page, setId: string): Promise<void> {
  await expect
    .poll(() => layerIds(win), { timeout: 240_000, intervals: [1000] })
    .toEqual(expect.arrayContaining([`${setId}-heat`, `${setId}-regions`]));
}

interface SetFile {
  scope?: unknown;
  items: Item[];
  lineUp?: { from?: { eastM: number }; to?: { eastM: number } };
  run?: { params?: Record<string, unknown> };
}
const readSet = async (root: string, id: string) =>
  JSON.parse(await readFile(join(root, 'change', `${id}.json`), 'utf8')) as SetFile;

/**
 * The area's set: its scope, R's region among them, every region inside the polygon, none near S.
 * `east` is the line-up of both dates: the orthos, so the regions, sit that far east.
 */
function expectScoped(set: SetFile, area: XZBox, s: Change, east = 0): void {
  expect(set.scope).toEqual({ id: 'area-a', name: 'Area A' });
  expect(set.items.length).toBeGreaterThan(0);
  const drawn = { ...area, x0: area.x0 + east, x1: area.x1 + east };
  expect(set.items.some((i) => inside(i.at, drawn))).toBe(true);
  for (const i of set.items) expect(inside(i.at, drawn), JSON.stringify(i.at)).toBe(true);
  const sb = box(s.outlineLocal, 1);
  const near = { ...sb, x0: sb.x0 + east, x1: sb.x1 + east };
  for (const i of set.items) expect(inside(i.at, near), JSON.stringify(i.at)).toBe(false);
}

/** Line both survey dates up `eastM` east, as a saved line-up writes it, and open the project again. */
async function lineUpBoth(win: Page, root: string, truth: ChangeDemoTruth, eastM: number) {
  const { from, to } = truth.captures;
  const file = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as {
    captures: { id: string; lineUp?: unknown }[];
  };
  for (const c of manifest.captures) {
    if (c.id !== from && c.id !== to) continue;
    c.lineUp = {
      eastM,
      northM: 0,
      with: c.id === from ? to : from,
      at: '2026-10-19T00:00:00.000Z',
    };
  }
  await writeFile(file, JSON.stringify(manifest, null, 2));
  await reopen(win);
}

/**
 * The mask an area's run was cut with, as a local box: it must be where the polygon is drawn
 * (its date's line-up applied), not where it is stored.
 */
async function maskBox(root: string, set: SetFile): Promise<XZBox> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    crs: { epsg: number };
    origin: [number, number, number];
  };
  const [ox, oy] = manifest.origin;
  const ring = set.run?.params?.mask as [number, number][];
  return box(
    ring.map(([lon, lat]) => {
      const [e, n] = fromWgs84([lon, lat, 0], manifest.crs.epsg);
      return [e - ox, oy - n] as [number, number];
    }),
  );
}

/** Two boxes within 5 cm of each other. */
function expectSameBox(a: XZBox, b: XZBox): void {
  for (const k of ['x0', 'x1', 'z0', 'z1'] as const)
    expect(Math.abs(a[k] - b[k])).toBeLessThan(0.05);
}

/** A line-up of both dates larger than the polygon's margin around R. */
const EAST = 5;

test('compare one area with the previous survey', async ({ demoProject }, testInfo) => {
  test.setTimeout(420_000);
  const { win, root, truth } = demoProject;
  const { from, to } = truth.captures;
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  const pair = `${from}-${to}`;
  const setId = `${pair}-raster-area-area-a`;

  // 1. both dates lined up 5 m east (past the 3 m margin), and a polygon on the later date stored
  // 3 m around truth's first change R, clear of another change S: it is drawn 5 m east of that,
  // on R where the lined-up orthos show it
  await lineUpBoth(win, root, truth, EAST);
  const { area, s } = await seedArea(win, root, truth);

  // 2. and 3. right-click Area A; the confirm box: both dates and the polygon, volumes off
  const dialog = await askCompare(win);
  await expect(dialog.getByTestId('area-compare-name')).toHaveText('Area A');
  const dates = dialog.getByTestId('area-compare-dates');
  await expect(dates).toContainText('2 Mar 2026');
  await expect(dates).toContainText('13 Apr 2026');
  await expect(dialog.getByTestId('area-compare-volumes')).not.toBeChecked();
  await dialog.getByTestId('area-compare-run').click();

  // 4. the area's layers in the reloaded manifest
  await layersOf(win, setId);
  await expect(dialog).toHaveCount(0);

  // 5. the area's set holds the area only, cut where the polygon is drawn; no whole-map run started
  const set = await readSet(root, setId);
  expectScoped(set, area, s, EAST);
  expectSameBox(await maskBox(root, set), { ...area, x0: area.x0 + EAST, x1: area.x1 + EAST });
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

test('Run again on a stale area replays the area; the whole-map set stays as it was', async ({
  demoProject,
}, testInfo) => {
  test.setTimeout(420_000);
  const { win, root, truth } = demoProject;
  const { from, to } = truth.captures;
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  const pair = `${from}-${to}`;
  const setId = `${pair}-raster-area-area-a`;
  const wholeFile = join(root, 'change', `${pair}-raster.json`);

  // 1. the whole map first, from the Changes panel's own button
  await openBench(win, 'changes');
  const button = win.getByTestId('change-panel').getByTestId('change-producer-raster');
  await expect(button).toBeEnabled();
  await button.click();
  await layersOf(win, `${pair}-raster`);

  // 2. then the area, from its right-click
  const { area, s } = await seedArea(win, root, truth);
  const dialog = await askCompare(win);
  await dialog.getByTestId('area-compare-run').click();
  await layersOf(win, setId);
  await expect(dialog).toHaveCount(0);
  const first = await readSet(root, setId);
  expectScoped(first, area, s);
  expect(first.run?.params).toBeDefined();
  const whole = await readFile(wholeFile, 'utf8');

  // 3. both dates lined up 5 m east (past the polygon's 3 m margin): both sets read stale, and
  // the polygon on the later date is now drawn 5 m east
  await lineUpBoth(win, root, truth, EAST);

  // 4. the area's entry in the Changes tab reads stale: Run again
  const panel = await openBench(win, 'changes');
  const picker = panel.getByTestId('change-area');
  await picker.selectOption('area-a');
  await expect(picker).toHaveValue('area-a');
  const stale = panel.getByTestId('chg-stale');
  await expect(stale).toHaveCount(1);
  await stale.getByTestId('chg-rerun').click();

  // 5. the area's set again, on the lined-up dates: still the area, still chosen, and cut where
  // the polygon is drawn now (not where the first run cut it)
  await expect
    .poll(async () => (await readSet(root, setId)).lineUp?.to?.eastM ?? null, {
      timeout: 240_000,
      intervals: [1000],
    })
    .toBeCloseTo(EAST, 3);
  await expect(stale).toHaveCount(0);
  await expect(picker).toHaveValue('area-a');
  const again = await readSet(root, setId);
  expectScoped(again, area, s, EAST);
  expectSameBox(await maskBox(root, again), { ...area, x0: area.x0 + EAST, x1: area.x1 + EAST });
  await expect(panel.getByTestId('change-row')).toHaveCount(again.items.length);
  await expect(panel.locator('.chg-err')).toHaveCount(0);

  // 6. the whole-map set untouched, and still stale under the whole map
  expect(await readFile(wholeFile, 'utf8')).toBe(whole);
  await picker.selectOption('');
  await expect(panel.getByTestId('chg-stale')).toHaveCount(1);

  await win.screenshot({ path: testInfo.outputPath('change-area-rerun.png') });
  expect(errors).toEqual([]);
});
