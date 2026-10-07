/**
 * Ground control in the Builder (M10 G4): import the site's GCP CSV with a column mapping, mark
 * every point on the photos with the keyboard (the prediction ring sits on the painted target),
 * **Adjust**, and read the accuracy report: checkpoints measured, never adjusted, the planted bad
 * point (GCP6) flagged. Saves are atomic with a `.bak`.
 *
 * Runs on the e2e stand-in pipelines (`e2e/photo-fake`) until streams G2 and G3 land;
 * `STRATLAS_E2E_PHOTO_REAL=1` runs it on the real ones. Synthetic photos only; zero network.
 */
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, test as base, VENV_PYTHON } from './fixtures';
import {
  CAMERAS,
  expectedPixel,
  GCPS,
  openPhotoSite,
  photoFixtures,
  runId,
  startRun,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const test = base.extend<PhotoFixtures, PhotoWorkerFixtures>(photoFixtures);

test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** The marker's current photo and where its prediction ring is drawn. */
async function ringOffset(win: Page, point: (typeof GCPS)[number]): Promise<number> {
  const marker = win.getByTestId('gcp-marker');
  const name = await marker.locator('.ph-mk-list button[aria-current="true"] .mono').innerText();
  const cam = CAMERAS.find((c) => c.file === name.trim());
  if (!cam) throw new Error(`No camera for ${name}`);
  const want = expectedPixel(cam, point.local);
  if (!want) throw new Error(`${point.id} is not in ${name}`);
  const at = await marker.getByTestId('prediction-ring').getAttribute('data-px');
  const [x = Number.NaN, y = Number.NaN] = (at ?? '').split(',').map(Number);
  return Math.hypot(x - want[0], y - want[1]);
}

test('import GCPs, mark them with the keyboard, adjust and read an honest report', async ({
  win,
  photoSite,
}) => {
  test.setTimeout(240_000);
  await openPhotoSite(win);
  const panel = await startRun(win, { groundControl: true });
  const run = await runId(win);
  await expect(panel.getByRole('region', { name: 'Next steps' })).toBeVisible({ timeout: 60_000 });

  // import: the mapping is read from the header, the CRS is the project's
  await panel.getByRole('tab', { name: 'Ground control' }).click();
  const importer = panel.getByTestId('gcp-import');
  await importer.getByTestId('gcp-file').setInputFiles(photoSite.csv);
  await expect(importer.getByRole('combobox', { name: /Column 2/ })).toHaveValue('x');
  await expect(importer.getByRole('combobox', { name: /Column 5/ })).toHaveValue('role');
  await expect(importer.getByRole('option', { name: /EPSG:32639/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectAccessible(win, 'GCP import', { include: '[data-testid="photo-run"]' });
  await importer.getByTestId('gcp-save').click();

  const table = panel.getByTestId('gcp-table');
  await expect(table.locator('tbody tr')).toHaveCount(GCPS.length);
  await expect(table.getByRole('combobox', { name: 'Role of GCP5' })).toHaveValue('check');
  await expect(table.getByTestId('gcp-adjust')).toBeDisabled();
  await expectAccessible(win, 'GCP table', { include: '[data-testid="photo-run"]' });

  // mark every point in three photos: the ring is on the target, Enter confirms and moves on
  for (const [i, point] of GCPS.entries()) {
    await table.getByRole('button', { name: `Mark ${point.id}` }).click();
    const marker = panel.getByTestId('gcp-marker');
    await expect(marker).toBeVisible();
    const viewer = marker.getByTestId('marker-viewer');
    await expect(viewer).toBeFocused();
    for (let n = 1; n <= 3; n++) {
      expect(await ringOffset(win, point)).toBeLessThan(10);
      await win.keyboard.press('Enter');
      await expect(marker.getByTestId('marker-count')).toContainText(`${String(n)} of 3`);
    }
    if (i === 0)
      await expectAccessible(win, 'GCP marker', { include: '[data-testid="photo-run"]' });
    await win.keyboard.press('Escape');
    await expect(table).toBeVisible();
    await expect(table.getByTestId(`marks-${point.id}`)).toHaveText('3 confirmed');
  }

  // saved as the person marked them, with the previous file kept
  const gcpFile = join(photoSite.dir, 'photogrammetry', run, 'gcp.json');
  const saved = JSON.parse(await readFile(gcpFile, 'utf8')) as {
    points: { id: string; marks: { state: string; by: string }[] }[];
  };
  expect(saved.points.map((p) => p.marks.filter((m) => m.state === 'confirmed').length)).toEqual(
    GCPS.map(() => 3),
  );
  expect(saved.points[0]?.marks[0]?.by).toBe('person');
  expect(existsSync(`${gcpFile}.bak`)).toBe(true);

  // Adjust runs photo.georef; the report shows checkpoints measured and the planted bad point
  await table.getByTestId('gcp-adjust').click();
  await expect(panel.getByTestId('photo-job').locator('[data-status="done"]')).toBeVisible({
    timeout: 60_000,
  });
  await panel.getByRole('tab', { name: 'Accuracy' }).click();
  const report = panel.getByTestId('accuracy-report');
  await expect(report.getByTestId('accuracy-headline')).toContainText('Checkpoint RMSE');
  await expect(report.getByTestId('accuracy-rmse').locator('[data-role="check"]')).toContainText(
    'Within',
  );
  await expect(report.getByTestId('accuracy-warnings')).toContainText('GCP6 is 1.0 m off');
  await expect(report.getByTestId('accuracy-points').locator('[data-point="GCP6"]')).toHaveClass(
    /flag/,
  );
  await expect(report).toContainText('Checkpoints are measured only');
  await expectAccessible(win, 'accuracy report', { include: '[data-testid="photo-run"]' });
});
