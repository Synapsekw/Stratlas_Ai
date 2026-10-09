/**
 * Site materials and the calculators in the real app (M11 G4, PRD SRV-6) on the synthetic landfill
 * demo: import materials from CSV into the site list (merged by id) and save them to
 * `survey/settings.json`; on the cell's lift (previous to current, prepared through the real
 * `survey.prepare` job) pick a material for its tonnes, and type a weighed tonnage for the density
 * it achieved, shown as the calculators show it. The stored volume never changes. Axe on the dialog
 * and the panel. Off-screen, zero network.
 */
import { formatQuantity } from '@aio/geo';
import type { MeasurementsFile, SurveySettings } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, openProject, PIPELINE_ENV, test } from './fixtures';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, 'utf8')) as T;

async function open(win: Page, p: SurveyDemoProject): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

const CSV =
  'id,name,code,density_t_per_m3,swell_loose,swell_compacted\r\n' +
  'msw,Municipal solid waste,MSW,0.95,,\r\n' +
  'cover,Daily cover soil,DC,1.7,1.25,0.9\r\n' +
  'bad,Bad row,,heavy,,\r\n';

test('site materials from CSV, a material on a measurement, and the weight calculator', async ({
  landfillProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
  test.setTimeout(300_000);
  const dir = landfillProject.dir;
  await open(win, landfillProject);

  // the site list: one material from the demo, the CSV replaces it and adds one
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-materials-tool').click();
  const dlg = win.getByTestId('survey-materials');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('survey-mat-row')).toHaveCount(1);
  await dlg.getByTestId('survey-mat-import').setInputFiles({
    name: 'materials.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });
  await expect(dlg.getByTestId('survey-mat-row')).toHaveCount(2);
  await expect(dlg.getByTestId('survey-mat-note')).toContainText('2 materials read');
  await expect(dlg.getByTestId('survey-mat-error')).toContainText('Line 4');
  await expectAccessible(win, 'Site materials', { include: '[data-testid="survey-materials"]' });
  await dlg.getByTestId('survey-mat-save').click();
  await expect(dlg).toHaveCount(0);
  const settings = await readJson<SurveySettings>(join(dir, 'survey', 'settings.json'));
  expect(settings.materials).toEqual([
    { id: 'msw', name: 'Municipal solid waste', code: 'MSW', densityTPerM3: 0.95 },
    {
      id: 'cover',
      name: 'Daily cover soil',
      code: 'DC',
      densityTPerM3: 1.7,
      swell: { loose: 1.25, compacted: 0.9 },
    },
  ]);

  // the lift: prepare the surveys, then compute previous to current
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-list-open').click();
  await win
    .getByTestId('survey-item')
    .filter({ hasText: 'Cell 1' })
    .locator('.sv-item-main')
    .click();
  const panel = win.getByTestId('survey-panel');
  await panel.getByTestId('survey-prepare').click();
  await expect(panel.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 240_000 });
  const lift = panel.getByTestId('survey-cmp-item').first();
  await expect(lift.getByTestId('survey-cmp-result')).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId('survey-recompute')).toHaveText('Recompute', { timeout: 60_000 });
  await win.getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
  let file = await readJson<MeasurementsFile>(join(dir, 'survey', 'measurements.json'));
  const cell = file.measurements.find((m) => m.id === 'm-cell');
  const r = cell?.results.find((x) => x.item === 'lift');
  if (!r) throw new Error('the lift result');
  const truth = (
    landfillProject.truth as { comparisons: { from: string; to: string; fillM3: number }[] }
  ).comparisons.find((c) => c.from === 'l2' && c.to === 'l3');
  expect(Math.abs(r.fillM3 - (truth?.fillM3 ?? 0)) / (truth?.fillM3 ?? 1)).toBeLessThan(0.01);
  const volume = Math.abs(r.netM3);

  // a material gives tonnes; a weighed tonnage gives the density it achieved
  const calc = panel.getByTestId('survey-calculators');
  await calc.getByTestId('survey-material').selectOption('cover');
  await expect(calc.getByTestId('survey-calc')).toContainText('m³');
  await expect(calc.getByTestId('survey-calc-tonnes')).toContainText(
    formatQuantity(volume * 1.7 * 1000, 'mass', settings.units, settings.precision),
  );
  await expect(calc.getByTestId('survey-calc')).toContainText(
    formatQuantity(volume * 1.25, 'volume', settings.units, settings.precision),
  );
  await calc.getByTestId('survey-weight').fill('63000');
  await expect(calc.getByTestId('survey-achieved-density')).toContainText(
    formatQuantity(63_000 / volume, 'density', settings.units, 3),
  );
  await expectAccessible(win, 'Survey calculators', { include: '[data-testid="survey-side"]' });

  // the material is stored on the measurement; the volume is not changed by the calculators
  await win.getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
  file = await readJson<MeasurementsFile>(join(dir, 'survey', 'measurements.json'));
  const after = file.measurements.find((m) => m.id === 'm-cell');
  expect(after?.material).toBe('cover');
  expect(after?.results.find((x) => x.item === 'lift')?.netM3).toBe(r.netM3);
});
