/**
 * M11 survey demos (stream G13): the four synthetic survey projects are valid against the G0
 * contracts and open as ordinary projects in the current app, off-screen and with no network.
 * Skips when the demos cannot be built (no pipeline Python; see surveyFixtures.ts).
 */
import {
  DesignsFile,
  MeasurementsFile,
  parseManifest,
  SiteCalibration,
  SurveySettings,
} from '@aio/schema';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';
import type { SurveyDemoProject } from './surveyFixtures';

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, 'utf8')) as unknown;

test('the survey demos are valid projects with M11 side files', async ({
  surveyProject,
  earthworksProject,
  quarryProject,
  landfillProject,
}) => {
  for (const p of [surveyProject, earthworksProject, quarryProject, landfillProject]) {
    const m = parseManifest(await readJson(join(p.dir, 'manifest.json')));
    expect(m.ok, p.id).toBe(true);
    if (!m.ok) continue;
    expect(m.value).toMatchObject({ id: p.id, name: p.name, crs: { epsg: 32639 } });
    expect(m.value.captures.length).toBeGreaterThanOrEqual(2);
    for (const c of m.value.captures)
      expect(
        m.value.layers.filter((l) => l.kind === 'raster' && l.capture === c.id),
        `${p.id} ${c.id}`,
      ).toHaveLength(2);
    SurveySettings.parse(await readJson(join(p.dir, 'survey', 'settings.json')));
    DesignsFile.parse(await readJson(join(p.dir, 'survey', 'designs.json')));
    MeasurementsFile.parse(await readJson(join(p.dir, 'survey', 'measurements.json')));
  }
  SiteCalibration.parse(await readJson(join(earthworksProject.dir, 'survey', 'calibration.json')));
  expect(
    existsSync(
      join(
        earthworksProject.dir,
        'survey',
        'designs',
        'earthworks-design',
        'earthworks-design.xml',
      ),
    ),
  ).toBe(true);
  const quarry = SurveySettings.parse(
    await readJson(join(quarryProject.dir, 'survey', 'settings.json')),
  );
  expect(quarry.materials.map((x) => x.id)).toEqual(['crushed-20', 'washed-sand', 'base-course']);
});

async function open(win: Page, p: SurveyDemoProject): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

test('the app lists and opens each survey demo, with no network', async ({
  surveyProject,
  earthworksProject,
  quarryProject,
  landfillProject,
  win,
}) => {
  test.setTimeout(180_000);
  const projects = [earthworksProject, quarryProject, landfillProject, surveyProject];
  const entries = await win.evaluate(() => window.aio.invoke('library:list', {}));
  for (const p of projects) expect(entries.find((e) => e.id === p.id)?.name).toBe(p.name);
  for (const p of projects) await open(win, p);
});
