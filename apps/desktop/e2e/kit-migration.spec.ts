/**
 * Old stockpile projects (volumetric parity W3) in the real app: the synthetic tiny project, given
 * two survey dates and a fictional stockpile kit result (`volumes.json`, two piles, and one toe
 * line corrected by hand in `edits/boundaries.json`), opens with each kit pile as a volume
 * measurement in the Stockpiles folder showing exactly its old figure, labelled "From an earlier
 * version (kit, Triangulated)", with nothing marked unsaved; the conversion is written once and
 * never again, so a pile deleted afterwards stays deleted; a package of it shows the same figures
 * and writes nothing. No pipeline Python: nothing is computed. Off-screen, zero network.
 */
import { BoundaryEditsFile, MeasurementsFile, ProjectManifest, VolumesFile } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  launchApp,
  NetworkGuard,
  openProject,
  test,
  tinyManifest,
  type DataRoot,
} from './fixtures';
import { measureRow, measureSaved, measureTree, volumesView } from './island';
import { focusMeasure } from './measureCard';

/**
 * The kit's figures (net on its default base, `tin`), per pile and date: exact at the site's
 * volume precision (one decimal), so the card shows them as they are.
 */
const NORTH_E1 = 10.4;
/** The hand-corrected toe line of the north pile on the second date: its figure wins. */
const NORTH_E2_EDITED = 12.5;
const NORTH_E2_AUTO = 11.8;
const SOUTH_E1 = 4.5;

const fc = (net: number) => ({ fill: net, cut: 0, net });
/** One kit figure on all four bases (the kit's `tin` is the one carried). */
const bases = (net: number) => ({
  tin: fc(net),
  plane: fc(net * 0.9),
  avg: fc(net * 0.8),
  low: fc(net * 1.1),
});

/** Toe lines in the kit's local frame (x east, z south): just north-east of the origin. */
const NORTH_RING: [number, number][] = [
  [0.1, -0.6],
  [0.4, -0.6],
  [0.4, -0.9],
  [0.1, -0.9],
];
const NORTH_RING_EDITED: [number, number][] = [
  [0.08, -0.58],
  [0.42, -0.58],
  [0.42, -0.92],
  [0.08, -0.92],
];
const SOUTH_RING: [number, number][] = [
  [0.6, -0.1],
  [0.9, -0.1],
  [0.9, -0.4],
  [0.6, -0.4],
];

const epoch = (captureId: string, net: number, ring: [number, number][]) => ({
  captureId,
  areaM2: 0.09,
  topM: 1.2,
  heightM: 0.4,
  ring,
  volumes: bases(net),
});

const VOLUMES = VolumesFile.parse({
  schema: 'aio.volumes/1',
  source: 'Synthetic stockpile kit result (e2e)',
  densityTPerM3: 1.6,
  deadbandM: 0.05,
  defaultBase: 'tin',
  bases: [
    { id: 'tin', label: 'TIN toe' },
    { id: 'plane', label: 'Plane' },
    { id: 'avg', label: 'Average toe' },
    { id: 'low', label: 'Lowest toe' },
  ],
  captures: [
    { epoch: 'e1', captureId: 'capture-1', date: '2026-01-01', label: 'Synthetic capture' },
    { epoch: 'e2', captureId: 'capture-2', date: '2026-02-01', label: 'Second capture' },
  ],
  piles: [
    {
      id: 'p01',
      name: 'Pile North',
      material: null,
      zoneRing: NORTH_RING,
      change: fc(NORTH_E2_AUTO - NORTH_E1),
      epochs: {
        e1: epoch('capture-1', NORTH_E1, NORTH_RING),
        e2: epoch('capture-2', NORTH_E2_AUTO, NORTH_RING),
      },
    },
    {
      // on the first date only: gone by the last, so it has no headline figure
      id: 'p02',
      name: 'Pile South',
      material: null,
      zoneRing: SOUTH_RING,
      change: fc(-SOUTH_E1),
      epochs: { e1: epoch('capture-1', SOUTH_E1, SOUTH_RING) },
    },
  ],
  totals: { e1: { tin: NORTH_E1 + SOUTH_E1 }, e2: { tin: NORTH_E2_AUTO } },
  pileChange: fc(NORTH_E2_AUTO - NORTH_E1 - SOUTH_E1),
  siteChange: fc(NORTH_E2_AUTO - NORTH_E1 - SOUTH_E1),
});

const EDITS = BoundaryEditsFile.parse({
  schema: 'aio.boundaries/1',
  edits: [
    {
      pile: 'p01',
      epoch: 'e2',
      ring: NORTH_RING_EDITED,
      volumes: bases(NORTH_E2_EDITED),
      areaM2: 0.1156,
      topM: 1.25,
      heightM: 0.45,
      autoNet: NORTH_E2_AUTO,
      updatedAt: '2026-02-02T09:00:00Z',
    },
  ],
});

/** Write the old project's kit files and a second survey date into a tiny project folder. */
async function writeOldProject(dir: string): Promise<void> {
  const base = tinyManifest();
  const manifest = ProjectManifest.parse({
    ...base,
    captures: [...base.captures, { id: 'capture-2', label: 'Second capture', date: '2026-02-01' }],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'volumes.json'), JSON.stringify(VOLUMES, null, 1));
  await mkdir(join(dir, 'edits'), { recursive: true });
  await writeFile(join(dir, 'edits', 'boundaries.json'), JSON.stringify(EDITS, null, 1));
  // no measurements.json yet: a project from before the measurements existed
}

const readMeasurements = async (dir: string) =>
  MeasurementsFile.parse(
    JSON.parse(await readFile(join(dir, 'survey', 'measurements.json'), 'utf8')),
  );

/** A number the app shows ("12.500 m³"): its first figure. */
const figure = (text: string): number => {
  const m = /-?[\d ,]*\d(?:\.\d+)?/.exec(text.replaceAll(String.fromCharCode(0xa0), ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,]/g, ''));
};

async function openTiny(win: Page): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe('e2e-tiny');
}

/** Open the tiny project again after a reload (the app may come back on it, or on the library). */
async function reopen(win: Page): Promise<void> {
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
}

/**
 * The north pile's card: its old figure carried and labelled, no Recompute (no surfaces here),
 * its area split and method left out, and its two dates in the over-time table.
 */
async function expectNorthCarried(win: Page, readOnly = false): Promise<void> {
  let card: Locator;
  if (readOnly) {
    // a package: the name is a heading, not a field
    await measureRow(win, 'Pile North').locator('.tn').click();
    card = win.getByTestId('survey-panel');
    await expect(card.getByTestId('card-name')).toHaveText('Pile North');
    await expect(card.getByRole('textbox', { name: 'Rename' })).toHaveCount(0);
  } else card = await focusMeasure(win, 'Pile North');
  await expect(card.getByTestId('survey-cmp-status').first()).toHaveText(
    'From an earlier version (kit, Triangulated)',
  );
  expect(figure(await card.getByTestId('card-primary').innerText())).toBeCloseTo(
    NORTH_E2_EDITED,
    2,
  );
  const result = card.getByTestId('survey-cmp-result');
  await expect(result).toHaveCount(1);
  expect(figure(await result.locator('tr[data-key="net"] td').first().innerText())).toBeCloseTo(
    NORTH_E2_EDITED,
    2,
  );
  await expect(result.locator('td.vd-area')).toHaveCount(0);
  await expect(card.getByTestId('vol-method')).toHaveCount(0);
  await expect(card.getByTestId('survey-recompute')).toHaveCount(0);
  await expect(card.getByTestId('vol-recompute-standard')).toHaveCount(0);
  // both dates, the latest the hand-corrected figure
  const rows = card.getByTestId('vol-time-table').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  expect(figure(await rows.nth(0).locator('td').first().innerText())).toBeCloseTo(NORTH_E1, 2);
  expect(figure(await rows.nth(1).locator('td').first().innerText())).toBeCloseTo(
    NORTH_E2_EDITED,
    2,
  );
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'date');
}

test.beforeEach(async ({ dataRoot }) => {
  await writeOldProject(dataRoot.projectDir);
});

test('an old stockpile project opens with its kit figures labelled and no unsaved mark', async ({
  win,
  dataRoot,
}) => {
  const dir = dataRoot.projectDir;
  const kitBefore = await readFile(join(dir, 'volumes.json'));
  await openTiny(win);
  await measureTree(win);

  // both kit piles, in the Stockpiles folder
  await expect(win.getByTestId('measure-folder').filter({ hasText: 'Stockpiles' })).toBeVisible();
  await expect(win.getByTestId('measure-row')).toHaveCount(2);
  await expect(measureRow(win, 'Pile North')).toHaveCount(1);
  await expect(measureRow(win, 'Pile South')).toHaveCount(1);

  // nothing to save: the conversion is not an edit
  const saved = await measureSaved(win);
  await expect(saved).toContainText('All saved');
  await expect(saved.getByTestId('survey-list-save')).toBeDisabled();

  await expectNorthCarried(win);

  // the south pile is gone by the last date: no figure on it, its first date kept
  const south = await focusMeasure(win, 'Pile South');
  await expect(south.getByTestId('survey-cmp-status').first()).toHaveText('No survey data');
  await expect(south.getByTestId('survey-cmp-result')).toHaveCount(0);
  const rows = south.getByTestId('vol-time-table').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  expect(figure(await rows.nth(0).locator('td').first().innerText())).toBeCloseTo(SOUTH_E1, 2);
  await expect(rows.nth(1).locator('td').first()).toHaveText('No survey data');
  await expect(saved).toContainText('All saved');

  // written once, as converted measurements; the kit's own files are left as they were
  await expect
    .poll(async () => (await readMeasurements(dir).catch(() => null))?.kitPilesConverted ?? null)
    .toEqual(['p01', 'p02']);
  const file = await readMeasurements(dir);
  expect(file.measurements.map((m) => [m.label, m.folder, m.tool, m.origin])).toEqual([
    ['Pile North', 'Stockpiles', 'volume', { kind: 'kit-pile', pile: 'p01' }],
    ['Pile South', 'Stockpiles', 'volume', { kind: 'kit-pile', pile: 'p02' }],
  ]);
  const north = file.measurements[0];
  expect(north?.results[0]?.carried).toMatchObject({ from: 'kit', base: 'tin', pile: 'p01' });
  expect(north?.results[0]?.netM3).toBe(NORTH_E2_EDITED);
  // the outline is the corrected toe line, placed through the project origin (z south: N up)
  expect(north?.points.map((p) => [p[0], p[1]])).toEqual(
    NORTH_RING_EDITED.map(([x, z]) => [500000 + x, 3200000 - z]),
  );
  expect(file.measurements[1]?.results).toEqual([]);
  expect(await readFile(join(dir, 'volumes.json'))).toEqual(kitBefore);
});

test('reopening adds nothing; a deleted pile stays deleted', async ({ win, dataRoot }) => {
  const dir = dataRoot.projectDir;
  await openTiny(win);
  await measureTree(win);
  await expect(win.getByTestId('measure-row')).toHaveCount(2);
  await expect
    .poll(async () => (await readMeasurements(dir).catch(() => null))?.kitPilesConverted ?? null)
    .toEqual(['p01', 'p02']);
  const once = await readFile(join(dir, 'survey', 'measurements.json'));

  // opened again: the same two, the file untouched
  await reopen(win);
  await measureTree(win);
  await expect(win.getByTestId('measure-row')).toHaveCount(2);
  await expect(await measureSaved(win)).toContainText('All saved');
  expect(await readFile(join(dir, 'survey', 'measurements.json'))).toEqual(once);

  // delete the south pile and save
  await measureRow(win, 'Pile South').press('Delete');
  await expect(measureRow(win, 'Pile South')).toHaveCount(0);
  await (await measureSaved(win)).getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-saved')).toContainText('Measurements saved.');
  await expect
    .poll(async () => (await readMeasurements(dir)).measurements.map((m) => m.label))
    .toEqual(['Pile North']);

  // opened again: the kit still lists it, but it stays deleted
  await reopen(win);
  await measureTree(win);
  await expect(win.getByTestId('measure-row')).toHaveCount(1);
  await expect(measureRow(win, 'Pile South')).toHaveCount(0);
  await expect(await measureSaved(win)).toContainText('All saved');
  const file = await readMeasurements(dir);
  expect(file.measurements.map((m) => m.label)).toEqual(['Pile North']);
  expect(file.kitPilesConverted).toEqual(['p01', 'p02']);
  await expectNorthCarried(win);
});

test('in a package the figures show and nothing is written', async ({ app, win, dataRoot }) => {
  test.setTimeout(240_000);
  await openTiny(win);
  await measureTree(win);
  await expect(win.getByTestId('measure-row')).toHaveCount(2);

  // export the package
  const pkg = join(dataRoot.base, 'old-stockpiles.aio');
  await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
  await win.getByTestId('export-package').click();
  const exportDlg = win.getByTestId('package-export');
  await expect(exportDlg.getByTestId('pkg-size')).not.toContainText('...');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, pkg);
  await exportDlg.getByTestId('pkg-export').click();
  await expect(exportDlg.getByTestId('pkg-done')).toBeVisible({ timeout: 120_000 });
  const before = await stat(pkg);
  const bytes = await readFile(pkg);

  // a customer machine: an empty data folder, the package passed as by a double-click
  const customer: DataRoot = {
    base: dataRoot.base,
    root: join(dataRoot.base, 'customer-data'),
    userData: join(dataRoot.base, 'customer-user'),
    projectId: '',
    projectDir: '',
  };
  await mkdir(customer.root, { recursive: true });
  const network = new NetworkGuard();
  const player = await launchApp(customer, {}, [pkg]);
  try {
    await network.attach(player);
    const pw = await player.firstWindow();
    await pw.waitForLoadState('domcontentloaded');
    await expect(pw.getByTestId('readonly-chip')).toHaveText('Read-only package');
    await pw.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
    await expect(pw.locator('[data-scene-view] canvas').first()).toBeVisible();
    await measureTree(pw);
    await expect(pw.getByTestId('measure-row')).toHaveCount(2);
    const saved = await measureSaved(pw);
    await expect(saved.getByTestId('survey-list-readonly')).toBeVisible();
    await expect(saved.getByTestId('survey-list-save')).toHaveCount(0);

    // the same old figures, labelled; no Recompute, no error
    await expectNorthCarried(pw, true);
    await expect(pw.getByTestId('survey-panel').getByRole('alert')).toHaveCount(0);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await player.close();
  }
  // the package is as it was exported
  const after = await stat(pkg);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(pkg)).toEqual(bytes);
});

test('the Volumes view lists the kit piles; picking one shows its carried figure', async ({
  win,
}) => {
  await openTiny(win);
  const view = await volumesView(win);
  const piles = view.getByTestId('volumes-pile');
  await expect(piles).toHaveCount(2, { timeout: 30_000 });
  // the list is as tall as its rows: none is clipped away by it
  const heights = await view.locator('.vv-piles').evaluate((ul) => ({
    list: ul.getBoundingClientRect().height,
    rows: [...ul.children].reduce((s, li) => s + li.getBoundingClientRect().height, 0),
  }));
  expect(heights.list).toBeGreaterThanOrEqual(heights.rows);
  await piles.filter({ hasText: 'Pile North' }).click({ timeout: 15_000 });
  const detail = view.getByTestId('volumes-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('survey-cmp-status').first()).toHaveText(
    'From an earlier version (kit, Triangulated)',
  );
  expect(figure(await detail.getByTestId('card-primary').innerText())).toBeCloseTo(
    NORTH_E2_EDITED,
    1,
  );
});
