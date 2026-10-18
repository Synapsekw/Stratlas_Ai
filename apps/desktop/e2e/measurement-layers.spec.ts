/**
 * Measurements as layers of the Datasets tree, in the real app: a polygon "Pad A" in the folder
 * "Pads" and a line "Line B" seeded in the synthetic tiny project. A row's eye hides a
 * measurement for this person only (no unsaved change, the file untouched, still hidden after
 * reopening); a right-click on a shape in the 3D view opens its menu and a left click selects it,
 * but not while a tool draws; Rename and Move to folder from the tree menu are edits that wait
 * for Save. Off-screen, zero network.
 */
import { MeasurementsFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';
import { measureControl, measureRow, measureSaved, measureTree } from './island';

/** The tiny project's origin (fixtures.ts `tinyManifest`): its 1 x 1 m quad lies E+, N+ of it. */
const E = 500000;
const N = 3200000;

const SEED = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
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
    'ctx-item-measure.moveToFolder',
    'ctx-item-measure.delete',
  ]);
  await expect(menu.getByTestId('ctx-item-measure.visibility')).toHaveText('Hide');
  await win.screenshot({ path: testInfo.outputPath('measurement-layers-menu.png') });
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // a left click on the shape selects it, in the panel and in the tree
  await win.mouse.click(x, y);
  // (the panel shows the name in its name field, not as text)
  await expect(win.getByTestId('survey-panel').getByTestId('survey-label')).toHaveValue('Pad A');
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
