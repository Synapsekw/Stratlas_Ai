/**
 * A project with thermal photos for thermal-bench.spec.ts, written into a test's own data root
 * (the pattern of `pinFixture.ts`): one survey date (1 Oct 2026) with the e2e unit quad as its
 * model and a photo set `thermal-2026-10-01` holding two FLIR radiometric JPEGs (`th1`, `th2`)
 * and their visual twin (`vis1`). The photos come from `thermal-fixture.py`, run with the pipeline
 * Python: a 3 x 3 patch at 85.0 °C on a 30.0 °C background, written with the design default
 * settings (emissivity 0.95, distance 10 m, air 25 °C, humidity 50 %). Synthetic data only.
 */
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, tinyGlb, VENV_PYTHON } from './fixtures';

export const THERMAL_PROJECT = { id: 'e2e-thermal', name: 'E2E thermal photos' } as const;
export const THERMAL_CAPTURE = 'c1';
export const THERMAL_LAYER = 'thermal-2026-10-01';
/** The thermal photos, in the set's order. */
export const THERMAL_PHOTOS = ['th1', 'th2'] as const;
/** The visual twin: an ordinary photo of the same camera, never on the bench. */
export const VISUAL_PHOTO = 'vis1';

const FIXTURE = join(import.meta.dirname, 'thermal-fixture.py');

/** What `thermal-fixture.py` reports about the photos it wrote. */
export interface ThermalTruth {
  width: number;
  height: number;
  /** The hot patch's top-left pixel and its side, pixels. */
  patch: { x: number; y: number; size: number };
  hotC: number;
  backgroundC: number;
}

/** Write `projects/e2e-thermal/` into `root` (a data root); returns its folder and the truth. */
export async function createThermalProject(
  root: string,
): Promise<{ dir: string; truth: ThermalTruth }> {
  const dir = join(root, 'projects', THERMAL_PROJECT.id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  const truth = JSON.parse(
    execFileSync(VENV_PYTHON, [FIXTURE, join(dir, 'photos')], { encoding: 'utf8' }),
  ) as ThermalTruth;

  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: THERMAL_PROJECT.id,
    name: THERMAL_PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site, thermal photos',
    crs: { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' },
    origin: [0, 0, 0],
    captures: [{ id: THERMAL_CAPTURE, label: '1 Oct 2026', date: '2026-10-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        capture: THERMAL_CAPTURE,
        src: { path: 'models/quad.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'photos',
        id: THERMAL_LAYER,
        name: 'Thermal photos',
        capture: THERMAL_CAPTURE,
        items: [
          { id: 'th1', src: { path: 'photos/th1.jpg' }, takenAt: '2026-10-01T09:00:00Z' },
          { id: VISUAL_PHOTO, src: { path: 'photos/vis1.jpg' }, takenAt: '2026-10-01T09:00:01Z' },
          { id: 'th2', src: { path: 'photos/th2.jpg' }, takenAt: '2026-10-01T09:00:10Z' },
        ],
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return { dir, truth };
}

/** Open the thermal project from the projects list and wait until it is the open project. */
export async function openThermalProject(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: THERMAL_PROJECT.name }).first().click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: {
                  workspace: { getState(): { project: { manifest: { id: string } } | null } };
                };
              }
            ).__stratlas.workspace.getState().project?.manifest.id ?? null,
        ),
      { timeout: 30_000 },
    )
    .toBe(THERMAL_PROJECT.id);
}

/** Right-click the thermal photo set in the sidebar and choose Analyse thermal. */
export async function analyseThermal(win: Page): Promise<void> {
  const folder = win.getByTestId(`date-folder-${THERMAL_CAPTURE}`);
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await win.getByTestId(`date-name-${THERMAL_CAPTURE}`).click();
  const photos = folder.getByTestId('tree-group-toggle-photos');
  if ((await photos.getAttribute('aria-expanded')) !== 'true') await photos.click();
  const row = win.getByTestId(`tree-row-${THERMAL_LAYER}`);
  await row.scrollIntoViewIfNeeded();
  // the menu asks the probe's answer, which comes in shortly after the project opens
  await expect(async () => {
    await row.click({ button: 'right' });
    const item = win.getByTestId('ctx-item-thermal.analyse');
    try {
      await expect(item).toBeVisible({ timeout: 2_000 });
    } catch (e) {
      await win.keyboard.press('Escape');
      throw e;
    }
    await item.click();
  }).toPass({ timeout: 30_000 });
}
