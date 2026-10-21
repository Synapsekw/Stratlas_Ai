import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import {
  analyseThermal,
  createThermalProject,
  openThermalProject,
  THERMAL_LAYER,
  THERMAL_PHOTOS,
  VISUAL_PHOTO,
  type ThermalTruth,
} from './thermalFixture';

/**
 * The Thermal bench (thermal analysis M1) on synthetic FLIR photos (`thermal-fixture.py`): Analyse
 * thermal on the photo set opens the bench, which runs `thermal.decode` in the development
 * pipeline runtime for the thermal photos; the temperature under the pointer reads the known hot
 * patch; a new emissivity for this photo decodes it again; the filmstrip lists the thermal photos
 * and not their visual twin. Without ExifTool (QUADRION_EXIFTOOL unset) the decode records the
 * cross-check as skipped. Needs the development Python (`uv sync` in python/, or
 * QUADRION_E2E_PYTHON). Synthetic data only.
 */

const thermalTest = test.extend<{ thermal: { dir: string; truth: ThermalTruth } }>({
  thermal: async ({ dataRoot }, use) => {
    await use(await createThermalProject(dataRoot.root));
  },
});

thermalTest.use({ appEnv: PIPELINE_ENV });
thermalTest.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** The reading under the pointer at photo pixel (x, y) (its centre), or null with no chip. */
async function readingAt(win: Page, truth: ThermalTruth, x: number, y: number) {
  const canvas = win.getByTestId('thermal-canvas');
  const box = await canvas.boundingBox();
  if (!box) return null;
  const at = {
    x: box.x + ((x + 0.5) / truth.width) * box.width,
    y: box.y + ((y + 0.5) / truth.height) * box.height,
  };
  // a new raster drops the chip until the pointer moves again: come in from beside the spot
  await win.mouse.move(at.x - 1, at.y);
  await win.mouse.move(at.x, at.y);
  const chip = win.getByTestId('thermal-hover');
  if (!(await chip.isVisible())) return null;
  const text = (await chip.textContent()) ?? '';
  expect(text).toMatch(/^-?\d+\.\d °C$/);
  return Number.parseFloat(text);
}

thermalTest(
  'Analyse thermal decodes the photo set; hover reads the patch; a new emissivity re-reads it',
  async ({ thermal, win }) => {
    thermalTest.setTimeout(300_000);
    const { truth, dir } = thermal;
    const centre = {
      x: truth.patch.x + Math.floor(truth.patch.size / 2),
      y: truth.patch.y + Math.floor(truth.patch.size / 2),
    };
    await openThermalProject(win);
    await win.locator('canvas').first().waitFor();

    // 1. Right-click the photo set, Analyse thermal: the bench opens and decodes.
    await analyseThermal(win);
    await expect(win.getByTestId('thermal-bench')).toBeVisible();
    await expect(win.getByTestId('thermal-canvas')).toBeVisible({ timeout: 180_000 });
    await expect(win.getByTestId('thermal-error')).toHaveCount(0);

    // 2. The filmstrip lists the two thermal photos, not the visual twin.
    const strip = win.getByTestId('thermal-filmstrip');
    for (const id of THERMAL_PHOTOS)
      await expect(strip.getByTestId(`thermal-thumb-${id}`)).toBeVisible();
    await expect(strip.getByTestId(`thermal-thumb-${VISUAL_PHOTO}`)).toHaveCount(0);
    await expect(strip.locator('[data-testid^="thermal-thumb-"]')).toHaveCount(
      THERMAL_PHOTOS.length,
    );

    // 3. Hover the patch centre: 85.0 °C; the background reads 30.0 °C.
    await expect
      .poll(() => readingAt(win, truth, centre.x, centre.y), { timeout: 15_000 })
      .not.toBeNull();
    const hot = await readingAt(win, truth, centre.x, centre.y);
    expect(Math.abs((hot ?? Number.NaN) - truth.hotC)).toBeLessThanOrEqual(0.1);
    const cool = await readingAt(win, truth, 5, 5);
    expect(Math.abs((cool ?? Number.NaN) - truth.backgroundC)).toBeLessThanOrEqual(0.1);
    await expect(win.getByTestId('thermal-settings-line')).toContainText('Emissivity 0.95');

    // the index lists both photos as ok, with the settings key and the cross-check state
    const indexPath = join(dir, 'thermal', 'rasters', THERMAL_LAYER, 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      crosscheck: string;
      photos: Record<string, { status: string; settingsKey: string; check?: string }>;
    };
    expect(Object.keys(index.photos).sort()).toEqual([...THERMAL_PHOTOS].sort());
    for (const id of THERMAL_PHOTOS) {
      expect(index.photos[id]?.status).toBe('ok');
      expect(index.photos[id]?.settingsKey).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(['ok', 'skipped']).toContain(index.crosscheck);

    // 4. Edit settings, emissivity 0.80, This photo: the patch reads hotter, the background
    // stays near 30 °C.
    await win.getByTestId('thermal-settings-edit').click();
    await win.getByTestId('thermal-setting-emissivity').fill('0.80');
    await win.getByTestId('thermal-apply-photo').click();
    await expect(win.getByTestId('thermal-settings-line')).toContainText('Emissivity 0.80');
    await expect
      .poll(async () => (await readingAt(win, truth, centre.x, centre.y)) ?? 0, {
        timeout: 120_000,
        intervals: [1000],
      })
      .toBeGreaterThan(truth.hotC + 5);
    const hotter = await readingAt(win, truth, centre.x, centre.y);
    expect(hotter ?? 0).toBeLessThan(truth.hotC + 15);
    const background = await readingAt(win, truth, 5, 5);
    expect(Math.abs((background ?? Number.NaN) - truth.backgroundC)).toBeLessThanOrEqual(2);

    // the setting is saved for this photo only
    const file = JSON.parse(await readFile(join(dir, 'thermal', 'thermal.json'), 'utf8')) as {
      schema: string;
      photos: Record<string, { settings: { emissivity: number } }>;
    };
    expect(file.schema).toBe('aio.thermal/1');
    expect(Object.keys(file.photos)).toEqual([`${THERMAL_LAYER}/th1`]);
    expect(file.photos[`${THERMAL_LAYER}/th1`]?.settings.emissivity).toBe(0.8);

    // 5. The other thermal photo keeps its own numbers.
    await win.getByTestId('thermal-thumb-th2').click();
    await expect(win.getByTestId('thermal-settings-line')).toContainText('Emissivity 0.95');
    await expect
      .poll(async () => (await readingAt(win, truth, centre.x, centre.y)) ?? 0, {
        timeout: 15_000,
      })
      .toBeCloseTo(truth.hotC, 1);
  },
);
