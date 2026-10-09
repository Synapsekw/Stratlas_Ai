/**
 * Haul-road compliance (M11 G11, HRD-1) on the quarry demo (G13's `quarryProject`, synthetic): the
 * Haul road panel prepares the DSMs (`survey.prepare`), runs `haul.analyse` along the design
 * alignment with the site's limits, and the results by station show the planted 12 % stretch
 * (stations 1+220 to 1+240) and the planted 0.8 m left berm (1+110) red while the clean stretch is
 * green. The run is on disk (`aio.haul-run/1`) and listed by `survey:readHaulRuns`. Development
 * pipeline Python; off-screen; zero network (the fixture asserts it).
 */
import { HaulRun } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, openProject, PIPELINE_ENV, test } from './fixtures';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.setTimeout(300_000);

async function open(win: Page, p: SurveyDemoProject): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/**
 * The Haul road button is in the Survey measurements popover (Site data), whose tool sits on the
 * toolbar, or under More tools when the toolbar is narrow.
 */
async function openHaulRoad(win: Page): Promise<void> {
  const survey = win.getByRole('button', { name: 'Survey measurements', exact: true });
  if (!(await survey.isVisible())) await win.getByRole('button', { name: 'More tools' }).click();
  await survey.click();
  await win.getByRole('button', { name: 'Haul road', exact: true }).click();
  await expect(win.getByTestId('haul-panel')).toBeVisible();
}

const row = (win: Page, station: string) => win.getByTestId(`haul-station-${station}`);

test('the planted steep stretch and low berm of the quarry road show red', async ({
  quarryProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), 'no development pipeline Python (python/.venv)');
  const truth = (quarryProject.truth as { haulRoad: { limits: Record<string, number> } }).haulRoad;
  await open(win, quarryProject);
  await openHaulRoad(win);
  const panel = win.getByTestId('haul-panel');

  // no prepared surface yet: prepare the three monthly DSMs
  await panel.getByRole('button', { name: 'Prepare the DSMs' }).click();
  const surface = panel.getByRole('combobox', { name: 'Surface' });
  await expect(surface.locator('option')).toHaveCount(3, { timeout: 180_000 });
  await surface.selectOption({ label: 'DSM 31 March 2026 (shaded relief)' });

  // the design alignment of the haul road, every 10 m, the site's limits
  const centreline = panel.getByRole('combobox', { name: 'Centreline' });
  await expect(centreline).toContainText('(alignment)');
  await centreline.selectOption({ index: 0 });
  await expect(centreline.locator('option:checked')).toContainText('alignment');
  await panel.getByLabel('Section interval in metres').fill('10');
  const labels: Record<string, string> = {
    minWidthM: 'Minimum width (m)',
    maxGradePct: 'Maximum grade (%)',
    crossFallMinPct: 'Cross fall from (%)',
    crossFallMaxPct: 'Cross fall to (%)',
    minBermHeightM: 'Minimum berm height (m)',
  };
  for (const [key, label] of Object.entries(labels))
    await panel.getByLabel(label, { exact: true }).fill(String(truth.limits[key]));
  await panel.getByRole('button', { name: 'Run analysis' }).click();

  // the results by station
  await expect(win.getByTestId('haul-table')).toBeVisible({ timeout: 180_000 });
  await expect(win.getByTestId('haul-summary')).toContainText('25 stations');
  for (const st of ['1+220.000', '1+230.000', '1+240.000']) {
    await expect(row(win, st)).toHaveAttribute('data-status', 'fail');
    await expect(row(win, st).locator('td[data-check="grade"]')).toHaveClass(/is-fail/);
  }
  await expect(row(win, '1+110.000')).toHaveAttribute('data-status', 'fail');
  await expect(row(win, '1+110.000').locator('td[data-check="bermLeft"]')).toHaveClass(/is-fail/);
  await expect(row(win, '1+110.000').locator('td[data-check="bermRight"]')).not.toHaveClass(
    /is-fail/,
  );
  // the clean stretch: tangents, the curve and its transitions
  for (const st of ['1+010.000', '1+030.000', '1+050.000', '1+080.000', '1+140.000', '1+200.000'])
    await expect(row(win, st)).toHaveAttribute('data-status', 'pass');
  for (const st of ['1+250.000', '1+260.000', '1+270.000', '1+280.000'])
    await expect(row(win, st)).toHaveAttribute('data-status', 'pass');
  await expect(row(win, '1+200.000').locator('td[data-check="grade"]')).toHaveText('8.0');
  await expect(panel.getByRole('list', { name: 'Failing stretches' })).toContainText(
    'Grade: 1+220.000 to 1+240.000',
  );
  await row(win, '1+110.000').getByRole('button', { name: 'Fly to 1+110.000' }).click();

  // the run on disk and through the read channel
  const dir = join(quarryProject.dir, 'survey', 'haul');
  const [runId] = await readdir(dir);
  expect(runId).toBeTruthy();
  const run = HaulRun.parse(
    JSON.parse(await readFile(join(dir, runId ?? '', 'run.json'), 'utf8')) as unknown,
  );
  expect(run.params.limits).toEqual(truth.limits);
  expect(run.surface.id).toBe('dsm-m3');
  expect(run.centreline.source).toBe('alignment');
  const listed = await win.evaluate(
    (projectId) => window.aio.invoke('survey:readHaulRuns', { projectId }),
    quarryProject.id,
  );
  expect(listed.ok && listed.runs.map((r) => r.id)).toEqual([run.id]);
});
