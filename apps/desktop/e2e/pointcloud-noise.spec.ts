/**
 * Point cloud cleanup, Remove noise (pointcloud.clean, noise mode) on the noisy synthetic COPC: the
 * 60 planted outliers are marked as class 7, the count shows, class 7 is hidden in the legend, the
 * layer streams the working copy, and Undo returns to the original stream. Needs the pipeline
 * Python and PDAL (skipped without them, as on the CI e2e runners).
 */
import { PIPELINE_ENV, PDAL, expect, hasPdal, hasPipelinePython, test } from './fixtures';
import {
  drawn,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  shot,
  sourceOf,
  writeNoisyProject,
} from './cleanupHelpers';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'no pipeline Python (uv sync in python/, or QUADRION_E2E_PYTHON)');
test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

test('Remove noise marks the outliers, hides class 7 and undoes to the original', async ({
  win,
}) => {
  test.setTimeout(240_000);
  await openNoisyProject(win);
  await openCleanupFromMenu(win);
  const before = await drawn(win);
  await win.getByTestId('cleanup-noise-run').click();
  const result = win.getByTestId('cleanup-noise-result');
  await expect(result).toContainText('marked as noise', { timeout: 180_000 });
  const r = await recipeOf(win);
  expect(r?.noise?.marked ?? 0).toBeGreaterThanOrEqual(60);
  expect(r?.hiddenClasses).toContain(7);
  await expect.poll(() => sourceOf(win)).toContain('edits/pointcloud/noisy.noise-');
  await expect.poll(() => drawn(win), { timeout: 30_000 }).toBeLessThan(before);

  // the legend shows class 7 hidden (colour by classification)
  await win.evaluate(() => {
    (
      window as unknown as {
        __stratlas: { pointcloud: { getState(): { setColourMode(m: string): void } } };
      }
    ).__stratlas.pointcloud
      .getState()
      .setColourMode('classification');
  });
  const legend = win.locator('[data-component="classification-legend"]');
  await expect(legend.getByRole('button', { name: 'Show Low noise' })).toBeVisible({
    timeout: 30_000,
  });
  await shot(win, 'cleanup-noise-marked.png');

  await win.getByTestId('cleanup-noise-undo').click();
  await expect.poll(async () => (await recipeOf(win))?.noise).toBeUndefined();
  await expect.poll(() => sourceOf(win)).toContain('clouds/noisy.copc.laz');
});
