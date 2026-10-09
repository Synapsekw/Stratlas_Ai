/**
 * Hydrology in the site view (M11 G10, HYD-1 and HYD-2) on G13's quarry demo: prepare the survey
 * DSMs from the Hydrology panel, flood the benched pit to a typed level (the area, the volume and
 * the outline as DXF) and show the catchment of the site's main outlet. The jobs run on the
 * development pipeline Python; off-screen and with no network, as every test.
 */
import { HydroRun } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, openProject, PIPELINE_ENV, test } from './fixtures';

test.use({ appEnv: PIPELINE_ENV });
test.setTimeout(300_000);

interface PitTruth {
  rect: [number, number, number, number];
  floorLevelM: number;
  floorHalfM: number;
}
interface GroundTruth {
  H0: number;
  E0: number;
  N0: number;
}

/**
 * The Hydrology button is in the Survey measurements popover (Site data), whose tool sits on the
 * toolbar, or under More tools when the toolbar is narrow.
 */
async function openHydrology(win: Page): Promise<void> {
  const panel = win.getByTestId('hydro-panel');
  if (await panel.isVisible()) return;
  const survey = win.getByRole('button', { name: 'Survey measurements', exact: true });
  if (!(await survey.isVisible())) await win.getByRole('button', { name: 'More tools' }).click();
  await survey.click();
  await win.getByRole('button', { name: 'Hydrology', exact: true }).click();
  await expect(panel).toBeVisible();
}

async function runOf(dir: string, id: string): Promise<HydroRun> {
  const raw = JSON.parse(
    await readFile(join(dir, 'survey', 'hydro', id, 'run.json'), 'utf8'),
  ) as unknown;
  return HydroRun.parse(raw);
}

test('flood the quarry pit to a typed level, download its outline and show a catchment', async ({
  quarryProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), 'no development pipeline Python (python/.venv)');
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: quarryProject.name }).first().click();
  await expect
    .poll(async () => (await openProject(win)).id, { timeout: 60_000 })
    .toBe(quarryProject.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();

  // the demo has no prepared surface yet: prepare the DSMs from the panel
  await openHydrology(win);
  await win.getByRole('button', { name: 'Prepare surfaces' }).click();
  const surface = win.getByRole('combobox', { name: 'Surface' });
  await expect(surface).toBeVisible({ timeout: 180_000 });
  await surface.selectOption('dsm-m1');

  // flood the pit 5 m above its floor (the ground plane's height at the pit's centre, less 25 m)
  const pit = (quarryProject.truth.pit as { m1: PitTruth }).m1;
  const ground = quarryProject.truth.ground as GroundTruth;
  const ce = (pit.rect[0] + pit.rect[2]) / 2;
  const cn = (pit.rect[1] + pit.rect[3]) / 2;
  const groundZ = ground.H0 + 0.004 * (ce - ground.E0) - 0.003 * (cn - ground.N0);
  const level = groundZ + pit.floorLevelM + 5;
  await win.getByRole('tab', { name: 'Flood to level' }).click();
  await win.getByLabel('Water level (m)').fill(level.toFixed(3));
  await win.getByRole('button', { name: 'Flood', exact: true }).click();
  const result = win.getByTestId('hydro-result');
  await expect(result).toContainText('stored volume', { timeout: 120_000 });

  const flood = await runOf(quarryProject.dir, await win.getByLabel('Run').inputValue());
  expect(flood.pipeline).toBe('hydro.flood');
  if (flood.pipeline !== 'hydro.flood') return;
  // water over the floor square and up the lowest face: more than the floor, less than the rim
  const floor = (2 * pit.floorHalfM) ** 2;
  expect(flood.results.areaM2).toBeGreaterThan(floor);
  expect(flood.results.areaM2).toBeLessThan((pit.rect[2] - pit.rect[0]) ** 2);
  expect(flood.results.volumeM3).toBeGreaterThan(floor * 4.5);
  expect(flood.results.levelM).toBeCloseTo(level, 3);

  // the outline as DXF: the panel's link serves the run's file
  const link = result.getByRole('link', { name: 'Download outline (DXF)' });
  await expect(link).toHaveAttribute('download', /outline\.dxf$/);
  const href = await link.getAttribute('href');
  expect(href).toBeTruthy();
  const dxf = await win.evaluate(async (u) => (await fetch(u)).text(), href ?? '');
  expect(dxf).toContain('LWPOLYLINE');
  expect(dxf).toContain('FLOOD-OUTLINE');
  expect(dxf).toBe(
    await readFile(join(quarryProject.dir, 'survey', 'hydro', flood.id, 'outline.dxf'), 'utf8'),
  );

  // the catchment of the site's main outlet, with the stream network
  await win.getByRole('tab', { name: 'Catchment' }).click();
  await win.getByRole('button', { name: 'Delineate' }).click();
  await expect(win.getByTestId('hydro-outlet').first()).toContainText('Catchment 1:', {
    timeout: 120_000,
  });
  const flow = await runOf(quarryProject.dir, await win.getByLabel('Run').inputValue());
  expect(flow.pipeline).toBe('hydro.flow');
  if (flow.pipeline !== 'hydro.flow') return;
  const [outlet] = flow.results.outlets ?? [];
  expect(outlet?.areaM2).toBeGreaterThan(1000);
  expect(flow.files.catchments).toBe('catchments.geojson');
  const runs = await win.evaluate(async (projectId) => {
    const w = window as unknown as { aio: { invoke(c: string, r: unknown): Promise<unknown> } };
    return w.aio.invoke('survey:readHydroRuns', { projectId });
  }, quarryProject.id);
  expect((runs as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual([flow.id, flood.id]);
});
