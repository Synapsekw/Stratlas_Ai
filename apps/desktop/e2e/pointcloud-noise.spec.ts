/**
 * Point cloud cleanup, Remove noise (pointcloud.clean, noise mode) on the noisy synthetic COPC: the
 * 60 planted outliers are marked as class 7, the count shows, class 7 is hidden in the legend and
 * the view draws every other point of the working copy, and Undo returns to the original stream
 * and its full count. Needs the pipeline Python and PDAL (skipped without them, as on the CI e2e
 * runners).
 */
import { PIPELINE_ENV, PDAL, expect, hasPdal, hasPipelinePython, test } from './fixtures';
import {
  CLOUD_POINTS,
  NOISY_POINTS,
  PLANTED,
  drawn,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  sourceOf,
  writeNoisyProject,
} from './cleanupHelpers';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'no pipeline Python (uv sync in python/, or QUADRION_E2E_PYTHON)');
test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

/**
 * At most this many of the real points may be marked besides the planted ones: the statistical
 * outlier filter is global (a point's mean distance to its neighbours against the cloud's mean
 * plus a multiple of the deviation), so the sparsest real points (tree tops, building edges) can
 * cross it too. 0.25 % of the 16 000 real points; the fixture with PDAL 2.10 marks 20.
 */
const EXTRA = Math.round(CLOUD_POINTS * 0.0025);

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

test('Remove noise marks the outliers, hides class 7 and undoes to the original', async ({
  win,
}) => {
  test.setTimeout(240_000);
  // every node loaded: the view draws all 16 060 points (openNoisyProject waits for it)
  await openNoisyProject(win);
  await openCleanupFromMenu(win);
  await win.getByTestId('cleanup-noise-run').click();
  const result = win.getByTestId('cleanup-noise-result');
  await expect(result).toContainText('marked as noise', { timeout: 180_000 });
  const r = await recipeOf(win);
  const marked = r?.noise?.marked ?? 0;
  // every planted outlier and at most a few sparse real points
  expect(marked).toBeGreaterThanOrEqual(PLANTED);
  expect(marked).toBeLessThanOrEqual(PLANTED + EXTRA);
  expect(r?.hiddenClasses).toContain(7);
  await expect(result).toContainText(`${String(marked)} points`);
  await expect.poll(() => sourceOf(win)).toContain('edits/pointcloud/noisy.noise-');
  // the working copy streams with class 7 hidden: every point but the marked ones
  await expect.poll(() => drawn(win), { timeout: 30_000 }).toBe(NOISY_POINTS - marked);

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

  await win.getByTestId('cleanup-noise-undo').click();
  await expect.poll(async () => (await recipeOf(win))?.noise).toBeUndefined();
  await expect.poll(() => sourceOf(win)).toContain('clouds/noisy.copc.laz');
  // the original stream draws again, all of it
  await expect.poll(() => drawn(win), { timeout: 30_000 }).toBe(NOISY_POINTS);
});
