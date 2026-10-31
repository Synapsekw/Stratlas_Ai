/**
 * Measurements as layers of the Datasets tree, in the real app: a polygon "Pad A" in the folder
 * "Pads" and a line "Line B" seeded in the synthetic tiny project. A row's eye hides a
 * measurement for this person only (no unsaved change, the file untouched, still hidden after
 * reopening); a right-click on a shape in the 3D view opens its menu and a left click selects it,
 * but not while a tool draws; Rename and Move to folder from the tree menu are edits that wait
 * for Save; a Delete is taken back with the notice's Undo, on disk too with Autosave on; the
 * group's filter box shows only the matching rows and leaves the view alone. Off-screen, zero
 * network.
 */
import { MeasurementsFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';
import { measureControl, measureFilter, measureRow, measureSaved, measureTree } from './island';
import { dragOnto } from './treeDrag';

/** The tiny project's origin (fixtures.ts `tinyManifest`): its 1 x 1 m quad lies E+, N+ of it. */
const E = 500000;
const N = 3200000;

const SEED = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
  // no stockpile kit piles to convert: marked so, as a project the app has opened before (a first
  // open would write this mark, and the specs below compare the file byte for byte)
  kitPilesConverted: [],
  measurements: [
    {
      id: 'pad-a',
      family: 'polygon',
      tool: 'area',
      label: 'Pad A',
      folder: 'Pads',
      scope: { kind: 'site' },
      points: [
        [E + 0.1, N + 0.1, 0],
        [E + 0.5, N + 0.1, 0],
        [E + 0.5, N + 0.5, 0],
        [E + 0.1, N + 0.5, 0],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-18T00:00:00Z',
    },
    {
      id: 'line-b',
      family: 'line',
      tool: 'distance',
      label: 'Line B',
      scope: { kind: 'site' },
      points: [
        [E + 0.6, N + 0.7, 0],
        [E + 0.9, N + 0.9, 0],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-18T00:00:00Z',
    },
  ],
});

let measurementsPath = '';

test.beforeEach(async ({ dataRoot }) => {
  await mkdir(join(dataRoot.projectDir, 'survey'), { recursive: true });
  measurementsPath = join(dataRoot.projectDir, 'survey', 'measurements.json');
  await writeFile(measurementsPath, JSON.stringify(SEED, null, 1));
});

/** Open the tiny project on the Scene, its two measurements drawn. */
async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe('e2e-tiny');
}

/** Where Pad A's label is anchored on screen (its centroid), and whether the canvas is there. */
async function padAnchor(win: Page): Promise<{ x: number; y: number }> {
  const label = win.locator('.sv-label[data-id="pad-a"]');
  await expect(label).toBeVisible();
  const at = await label.evaluate((el) => {
    const host = el.parentElement?.getBoundingClientRect();
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    if (!host || !m) return null;
    const x = host.left + Number(m[1]);
    const y = host.top + Number(m[2]);
    const hit = document.elementFromPoint(x, y);
    return { x, y, canvas: hit instanceof HTMLCanvasElement };
  });
  if (!at) throw new Error('no anchor for Pad A');
  expect(at.canvas, 'the anchor of Pad A lies on the 3D canvas').toBe(true);
  return { x: at.x, y: at.y };
}

test('hiding in the tree is personal: not unsaved, and still hidden after reopening', async ({
  win,
}, testInfo) => {
  const before = await readFile(measurementsPath);
  await openTiny(win);
  await measureTree(win);
  await expect(win.getByTestId('measure-folder').filter({ hasText: 'Pads' })).toBeVisible();
  await expect(win.locator('.sv-label')).toHaveCount(2);
  await measureRow(win, 'Line B').getByTestId('measure-row-eye').click();
  await expect(win.locator('.sv-label')).toHaveCount(1);
  const saved = await measureSaved(win);
  await expect(saved).toContainText('All saved');
  await expect(saved.getByTestId('survey-list-save')).toBeDisabled();
  expect(await readFile(measurementsPath)).toEqual(before);

  // open the tiny project again
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
  await measureTree(win);
  await expect(measureRow(win, 'Line B').getByTestId('measure-row-eye')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(win.locator('.sv-label')).toHaveCount(1);
  expect(await readFile(measurementsPath)).toEqual(before);
  // the group sits low in the tree: bring its rows into view for the picture
  await measureRow(win, 'Line B').scrollIntoViewIfNeeded();
  await win.screenshot({ path: testInfo.outputPath('measurement-layers-hidden.png') });
});

test('right-click a shape in 3D opens its menu; a left click selects it; not while drawing', async ({
  win,
}, testInfo) => {
  await openTiny(win);
  await measureTree(win);
  await expect(win.locator('.sv-label')).toHaveCount(2);
  const { x, y } = await padAnchor(win);

  await win.mouse.click(x, y, { button: 'right' });
  const menu = win.getByTestId('measure-menu');
  await expect(menu).toBeVisible();
  // Colour is `present: 'picks'`: a heading over a row of `menuitemradio` swatches, not one menuitem
  const order = await menu
    .locator('[data-testid^="ctx-item-measure."], [data-testid^="measure-colour-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(
    order.filter((id) => !id?.startsWith('measure-colour-') || id === 'measure-colour-yellow'),
  ).toEqual([
    'ctx-item-measure.rename',
    'measure-colour-yellow',
    'ctx-item-measure.visibility',
    'ctx-item-measure.flyTo',
    // an outline's vertex edit in the view
    'ctx-item-measure.editBoundary',
    'ctx-item-measure.moveToFolder',
    'ctx-item-measure.moveToDate',
    // Add to report and Export (a submenu of CSV, DXF and PNG) send it out (W2, W8)
    'ctx-item-measure.addToReport',
    'ctx-item-measure.export',
    'ctx-item-measure.delete',
  ]);
  await expect(menu.getByTestId('ctx-item-measure.visibility')).toHaveText('Hide');
  await win.screenshot({ path: testInfo.outputPath('measurement-layers-menu.png') });
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // a left click on the shape selects it, in the panel and in the tree
  await win.mouse.click(x, y);
  // (the panel shows the name in its name field, not as text)
  await expect(win.getByTestId('survey-panel').getByTestId('card-name')).toHaveValue('Pad A');
  await expect(measureRow(win, 'Pad A')).toHaveClass(/sel/);

  // while a tool draws, a right-click is the tool's, not the measurement's
  await (await measureControl(win, 'survey-tool-distance')).click();
  await expect(win.getByTestId('survey-drawbar')).toBeVisible();
  const drawing = await padAnchor(win);
  await win.mouse.click(drawing.x, drawing.y, { button: 'right' });
  await expect(menu).toHaveCount(0);
});

test('Rename and Move to folder from the tree menu are edits that wait for Save', async ({
  win,
}) => {
  const before = await readFile(measurementsPath);
  await openTiny(win);
  await measureTree(win);

  // Rename: the row's name field
  await measureRow(win, 'Line B').locator('.tn').click({ button: 'right' });
  await win.getByTestId('ctx-item-measure.rename').click();
  const field = win.getByTestId('measure-rename');
  await expect(field).toBeFocused();
  await field.fill('Line C');
  await field.press('Enter');
  await expect(measureRow(win, 'Line C')).toHaveCount(1);
  await expect(await measureSaved(win)).toContainText('Unsaved changes');

  // Move to folder: into Pads, which then holds both
  await measureRow(win, 'Line C').locator('.tn').click({ button: 'right' });
  await win.getByTestId('ctx-item-measure.moveToFolder').click();
  await win.getByTestId('measure-folder-to-Pads').click();
  await expect(win.getByTestId('measure-folder').filter({ hasText: 'Pads' })).toContainText('2');
  await expect(await measureSaved(win)).toContainText('Unsaved changes');
  expect(await readFile(measurementsPath)).toEqual(before);

  // Save writes both edits
  await (await measureSaved(win)).getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-saved')).toContainText('Measurements saved.');
  const file = MeasurementsFile.parse(JSON.parse(await readFile(measurementsPath, 'utf8')));
  expect(file.measurements.find((m) => m.id === 'line-b')).toMatchObject({
    label: 'Line C',
    folder: 'Pads',
  });
});

test('a row drags into a folder and out again, and waits for Save', async ({ win }) => {
  const before = await readFile(measurementsPath);
  await openTiny(win);
  const group = await measureTree(win);
  const pads = win.getByTestId('measure-folder').filter({ hasText: 'Pads' });
  await expect(pads).toContainText('1');

  // into Pads: listed there, and Save is offered
  await dragOnto(win, measureRow(win, 'Line B'), pads);
  await expect(pads).toContainText('2');
  await expect(
    pads.locator('..').getByTestId('measure-row').filter({ hasText: 'Line B' }),
  ).toHaveCount(1);
  const saved = await measureSaved(win);
  await expect(saved).toContainText('Unsaved changes');
  await expect(saved.getByTestId('survey-list-save')).toBeEnabled();
  expect(await readFile(measurementsPath)).toEqual(before);

  // onto the Measurements header: loose again
  await dragOnto(win, measureRow(win, 'Line B'), group.getByTestId('tree-group-measurements'));
  await expect(pads).toContainText('1');
  // (a folder's rows sit in its tree item, next to its own row)
  const inPads = pads.locator('..').getByTestId('measure-row');
  await expect(inPads.filter({ hasText: 'Line B' })).toHaveCount(0);
  await expect(measureRow(win, 'Line B')).toHaveCount(1);
  expect(await readFile(measurementsPath)).toEqual(before);

  // Save writes it with no folder
  await (await measureSaved(win)).getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-saved')).toContainText('Measurements saved.');
  const file = MeasurementsFile.parse(JSON.parse(await readFile(measurementsPath, 'utf8')));
  const line = file.measurements.find((m) => m.id === 'line-b');
  expect(line).toBeDefined();
  expect(line?.folder).toBeUndefined();
  expect(file.measurements.find((m) => m.id === 'pad-a')?.folder).toBe('Pads');
});

test('a stray Delete is taken back with Undo, on disk too with Autosave on', async ({
  win,
}, testInfo) => {
  await openTiny(win);
  await measureTree(win);
  const saved = await measureSaved(win);
  await saved.getByTestId('survey-autosave').check();
  const onDisk = async () =>
    MeasurementsFile.parse(JSON.parse(await readFile(measurementsPath, 'utf8'))).measurements;

  // the Delete key on a focused row deletes it at once, and Autosave writes it
  await measureRow(win, 'Line B').press('Delete');
  await expect(measureRow(win, 'Line B')).toHaveCount(0);
  await expect.poll(async () => (await onDisk()).map((m) => m.id)).toEqual(['pad-a']);
  const notice = win.getByTestId('measure-undo');
  await expect(notice).toContainText('Line B deleted');
  await win.screenshot({ path: testInfo.outputPath('measurement-layers-undo.png') });

  // Undo: the same measurement back in its place, and saved again
  await notice.getByTestId('measure-undo-button').click();
  await expect(notice).toHaveCount(0);
  await expect(measureRow(win, 'Line B')).toHaveCount(1);
  await expect.poll(async () => (await onDisk()).map((m) => m.id)).toEqual(['pad-a', 'line-b']);
  expect((await onDisk()).find((m) => m.id === 'line-b')).toEqual(
    SEED.measurements.find((m) => m.id === 'line-b'),
  );
  await expect(saved).not.toContainText('Unsaved changes');
});

test('the filter box shows only the matching rows; clearing it brings them all back', async ({
  win,
}, testInfo) => {
  await openTiny(win);
  const filter = await measureFilter(win);
  const rows = win.getByTestId('measure-row');
  const count = win.getByTestId('tree-group-measurements').locator('.gcount');
  await expect(rows).toHaveCount(2);

  // a folder name matches: Pads opens on its one row; the view still draws both
  await filter.fill('pads');
  await expect(rows).toHaveCount(1);
  await expect(measureRow(win, 'Pad A')).toBeVisible();
  await expect(count).toHaveText('1 of 2');
  await expect(win.locator('.sv-label')).toHaveCount(2);
  // a matching row still selects with a click on its name
  await measureRow(win, 'Pad A').locator('.tn').click();
  await expect(measureRow(win, 'Pad A')).toHaveAttribute('aria-selected', 'true');
  await win.screenshot({ path: testInfo.outputPath('measurement-filter.png') });

  // nothing matches: the group says so; Escape empties the box
  await filter.fill('nothing like this');
  await expect(rows).toHaveCount(0);
  await expect(win.getByTestId('measure-filter-none')).toHaveText('No measurements match');
  await win.screenshot({ path: testInfo.outputPath('measurement-filter-none.png') });
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(rows).toHaveCount(2);
  await expect(count).toHaveText('2');

  // the tool's name matches too; the clear button empties the box
  await filter.fill('distance');
  await expect(rows).toHaveCount(1);
  await expect(measureRow(win, 'Line B')).toBeVisible();
  await win.getByTestId('measure-filter-clear').click();
  await expect(filter).toHaveValue('');
  await expect(rows).toHaveCount(2);
});
