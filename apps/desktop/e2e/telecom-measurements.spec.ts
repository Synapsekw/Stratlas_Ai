/** Real canvas picking on synthetic geometry, without writes to real projects. */
import type { EngineStage } from '@aio/engine';
import { MeasurementsFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, test } from './fixtures';
import {
  measureControl,
  measureFilter,
  measureSaved,
  measureStrip,
  measureTree,
  selectMeasure,
  stageMode,
} from './island';
import { writeTelecomFace } from './telecomFixtures';

interface Inspect {
  __stratlas: { stage(): EngineStage | null };
}

async function openFace(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  // the telecom tools are the Measure workbench's Telecom family
  await expect(await measureControl(win, 'telecom-tool-clearance')).toBeEnabled();
  await expect
    .poll(() =>
      win.evaluate(() => {
        const stage = (window as unknown as Inspect).__stratlas.stage();
        return stage?.contentBounds()?.max.y ?? 0;
      }),
    )
    .toBeGreaterThan(8);
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas
      .stage()
      ?.restoreView({ position: [0, 5, 14], target: [0, 5, 0] }, false);
  });
}

async function screenPoint(win: Page, p: [number, number, number]) {
  return win.evaluate((point) => {
    const stage = (window as unknown as Inspect).__stratlas.stage();
    if (!stage) throw new Error('missing 3D stage');
    stage.camera.updateMatrixWorld();
    const ndc = stage.camera.position
      .clone()
      .set(...point)
      .project(stage.camera);
    const canvas = stage.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + ((ndc.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - ndc.y) / 2) * rect.height;
    return { x, y, free: document.elementFromPoint(x, y) === canvas };
  }, p);
}

async function pick(win: Page, p: [number, number, number]) {
  const at = await screenPoint(win, p);
  expect(at.free, 'measurement point must be reachable on the canvas').toBe(true);
  await win.mouse.click(at.x, at.y);
}

async function expectValue(win: Page, key: string, expected: number) {
  await expect
    .poll(async () =>
      Number.parseFloat(
        await win.getByTestId('telecom-readout').locator(`[data-key="${key}"] dd`).innerText(),
      ),
    )
    .toBeCloseTo(expected, 1);
}

/**
 * From the focused button of the Measure workbench's live strip, Shift+Tab past the strip
 * buttons before it, out of the strip, and past the save controls (`survey-saved`, between the
 * card and the strip): into the live card above them.
 */
async function shiftTabOutOfStrip(win: Page) {
  const before = await measureStrip(win)
    .locator('button')
    .evaluateAll((all) => all.indexOf(document.activeElement as HTMLButtonElement));
  expect(before, 'the focus is in the strip').toBeGreaterThanOrEqual(0);
  const saveStops = await win
    .getByTestId('survey-saved')
    .locator('input:not([disabled]), button:not([disabled])')
    .count();
  for (let i = 0; i <= before + saveStops; i++) await win.keyboard.press('Shift+Tab');
}

async function saved(dir: string) {
  return MeasurementsFile.parse(
    JSON.parse(await readFile(join(dir, 'survey', 'measurements.json'), 'utf8')),
  );
}

for (const kind of ['mesh', 'cloud'] as const) {
  test.describe(`telecom measurements on ${kind}`, () => {
    test.beforeEach(async ({ dataRoot }) => {
      await writeTelecomFace(dataRoot.projectDir, kind);
    });

    test('measures orientation and clearance, edits endpoints, saves and reopens', async ({
      win,
      dataRoot,
    }, testInfo) => {
      test.setTimeout(120_000);
      await openFace(win);
      const panel = win.getByTestId('telecom-tools');
      await win.getByTestId('telecom-tool-azimuth').click();
      await pick(win, [-2, 3, 0]);
      await pick(win, [2, 3, 0]);
      await pick(win, [-2, 7, 0]);
      await expectValue(win, 'azimuth', 180);
      await expect(panel).toContainText('Grid north');
      await panel.getByTestId('telecom-flip-direction').click();
      await expectValue(win, 'azimuth', 0);
      await expect(win.locator('.sv-label').filter({ hasText: 'Azimuth' })).toBeVisible();
      await panel.getByTestId('telecom-save').click();
      await expect(panel).toContainText('Measurements saved.');
      const azimuth = (await saved(dataRoot.projectDir)).measurements[0];
      if (!azimuth) throw new Error('missing saved azimuth');
      const facing = await win.evaluate((id) => {
        const stage = (window as unknown as Inspect).__stratlas.stage();
        const line = stage?.scene.getObjectByName(`measure-facing:${id}`);
        return Boolean(line?.visible);
      }, azimuth.id);
      expect(facing).toBe(true);
      await win.screenshot({ path: testInfo.outputPath('azimuth.png') });

      await win.getByTestId('telecom-tool-antenna-tilt').click();
      await pick(win, [-2, 3, 0]);
      await pick(win, [-2, 7, 0]);
      await expectValue(win, 'inclination', 0);

      await win.getByTestId('telecom-tool-clearance').click();
      await pick(win, [-2, 3, 0]);
      await pick(win, [1, 7, 0]);
      await expectValue(win, 'direct-gap', 5);
      await expectValue(win, 'horizontal-gap', 3);
      await expectValue(win, 'vertical-gap', 4);
      await panel.getByTestId('telecom-save').click();
      await expect.poll(async () => (await saved(dataRoot.projectDir)).measurements.length).toBe(3);

      // Drag the second endpoint on the actual mesh/cloud; its height remains 3D.
      await panel.getByRole('button', { name: 'Edit endpoints in 3D' }).click();
      const from = await screenPoint(win, [1, 7, 0]);
      const to = await screenPoint(win, [1, 6, 0]);
      expect(from.free && to.free).toBe(true);
      await win.mouse.move(from.x, from.y);
      await win.mouse.down();
      await win.mouse.move(to.x, to.y, { steps: 6 });
      await win.mouse.up();
      await expectValue(win, 'vertical-gap', 3);
      await panel.getByRole('button', { name: 'Done editing' }).click();
      await panel.getByTestId('telecom-save').click();
      await expect
        .poll(async () => {
          const points = (await saved(dataRoot.projectDir)).measurements[2]?.points;
          return points?.[1]?.[2];
        })
        .toBeCloseTo(6, 1);
      await expectAccessible(win, 'Telecom tools', { include: '[data-testid="telecom-tools"]' });
      await win.screenshot({ path: testInfo.outputPath('clearance.png') });

      await win.reload();
      await expect(
        win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
      ).toBeVisible();
      if (await win.getByTestId('project-card').first().isVisible()) await openFace(win);
      // the panel's Measurements reveals them in the Datasets tree, unfolding the sidebar
      await win
        .getByTestId('telecom-tools')
        .getByRole('button', { name: 'Measurements', exact: true })
        .click();
      await expect(win.getByTestId('measure-row')).toHaveCount(3);
      await selectMeasure(win, 'Azimuth');
      await expectValue(win, 'azimuth', 0);
      expect((await saved(dataRoot.projectDir)).measurements[0]?.points).toEqual(azimuth.points);

      // The group eye of the tree covers every measurement, even while the tree is filtered,
      // and is not an edit to save.
      const group = (await measureTree(win)).getByTestId('tree-group-measurements');
      const footer = await measureSaved(win);
      const beforeVisibility = await saved(dataRoot.projectDir);
      const filter = await measureFilter(win);
      await filter.fill('Azimuth');
      await expect(win.getByTestId('measure-row')).toHaveCount(1);
      await expect(group.locator('.gcount')).toHaveText('1 of 3');
      await expect(win.locator('.sv-label')).toHaveCount(3);
      await group.getByRole('button', { name: 'Measurements: hide all' }).click();
      await expect(win.locator('.sv-label')).toHaveCount(0);
      await expect(win.getByTestId('measure-row')).toHaveCount(1);
      await expect(footer.getByTestId('survey-list-save')).toBeDisabled();
      const anyVisible = await win.evaluate(
        (ids) => {
          const stage = (window as unknown as Inspect).__stratlas.stage();
          return ids.some((id) => {
            let object = stage?.scene.getObjectByName(`measure:${id}`);
            if (!object) return false;
            while (object) {
              if (!object.visible) return false;
              object = object.parent ?? undefined;
            }
            return true;
          });
        },
        beforeVisibility.measurements.map((m) => m.id),
      );
      expect(anyVisible).toBe(false);
      await group.getByRole('button', { name: 'Measurements: show all' }).click();
      await expect(win.locator('.sv-label')).toHaveCount(3);
      await expect(footer.getByTestId('survey-list-save')).toBeDisabled();
      expect(await saved(dataRoot.projectDir)).toEqual(beforeVisibility);
      await filter.fill('');
      await expect(win.getByTestId('measure-row')).toHaveCount(3);
      await win.screenshot({ path: testInfo.outputPath('measurement-visibility.png') });
    });

    test('supports undo and cancel and prevents map-only drawing', async ({ win, dataRoot }) => {
      await openFace(win);
      const panel = win.getByTestId('telecom-tools');
      const azimuthButton = win.getByTestId('telecom-tool-azimuth');
      const cancelButton = panel.getByRole('button', { name: 'Cancel', exact: true });
      await azimuthButton.focus();
      await win.keyboard.press('Enter');
      // live, the bench is a strip of tools: the focus stays on the live one, the next one Tab on
      await expect(azimuthButton).toHaveAttribute('aria-pressed', 'true');
      await expect(azimuthButton).toBeFocused();
      await win.keyboard.press('Tab');
      await expect(win.getByTestId('telecom-tool-antenna-tilt')).toBeFocused();
      // the live card sits above the strip: Shift+Tab back past the strip's first tools reaches
      // its Cancel (Undo is disabled with no point yet)
      await win.keyboard.press('Shift+Tab');
      await expect(azimuthButton).toBeFocused();
      await shiftTabOutOfStrip(win);
      await expect(cancelButton).toBeFocused();
      await win.keyboard.press('Space');
      await expect(cancelButton).toHaveCount(0);

      await (await measureControl(win, 'telecom-tool-azimuth')).click();
      await pick(win, [-2, 3, 0]);
      await expect(panel).toContainText('1 / 3 points picked');
      // from the live tool in the strip, back to the card: Cancel, then the enabled Undo
      await azimuthButton.focus();
      await shiftTabOutOfStrip(win);
      await expect(cancelButton).toBeFocused();
      await win.keyboard.press('Shift+Tab');
      await expect(panel.getByRole('button', { name: 'Undo last point' })).toBeFocused();
      await win.keyboard.press('Enter');
      await expect(panel).toContainText('0 / 3 points picked');
      await win.keyboard.press('Tab');
      await expect(cancelButton).toBeFocused();
      await win.keyboard.press('Space');
      await expect(panel.getByTestId('telecom-save')).toHaveCount(0);

      await win.getByTestId('telecom-tool-clearance').click();
      await pick(win, [-2, 3, 0]);
      await stageMode(win, 'Map');
      await expect(win.getByTestId('telecom-tool-clearance')).toBeDisabled();
      await expect(panel).toContainText('Switch to 3D');
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await stageMode(win, '3D');
      await expect(win.getByTestId('telecom-tool-clearance')).toBeEnabled();
      // nothing measured: the panel's Measurements unfolds the tree, with no Measurements group
      await panel.getByRole('button', { name: 'Measurements', exact: true }).click();
      await expect(win.getByTestId('panel-handle-left')).toHaveAttribute('aria-expanded', 'true');
      await expect(win.getByTestId('tree-group-measurements')).toHaveCount(0);
      await expect(win.getByTestId('measure-row')).toHaveCount(0);
      await expect(
        readFile(join(dataRoot.projectDir, 'survey', 'measurements.json')),
      ).rejects.toThrow();
    });
  });
}
