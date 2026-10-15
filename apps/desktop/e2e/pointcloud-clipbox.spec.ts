/**
 * Point cloud cleanup, the clip box (FUS-9) on the noisy synthetic COPC: opened from the layer's
 * right-click menu, Fit to layer, the east face dragged inward hides the points beyond it, Reset
 * and Undo. No PDAL, no pipeline: runs on every CI shard.
 */
import { expect, test } from './fixtures';
import {
  drawn,
  handleAt,
  middleReachesView,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  setView,
  shot,
  writeNoisyProject,
} from './cleanupHelpers';

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

test('a clip box hides the points outside it, and Reset and Undo bring them back', async ({
  win,
}) => {
  await openNoisyProject(win);
  const all = await drawn(win);
  await openCleanupFromMenu(win);

  // the panel leaves the middle of the view to the view
  expect(await middleReachesView(win)).toBe(true);

  await win.getByTestId('cleanup-box-fit').click();
  await expect.poll(async () => (await recipeOf(win))?.clipBox?.keep).toBe('inside');
  await expect.poll(() => drawn(win)).toBe(all); // the box holds the whole cloud

  // straight down on the cloud: the east and west handles lie right and left of the middle
  await setView(win, [20, 90, -20], [20, 0, -20.01]);
  await win.getByTestId('cleanup-box-edit').click();
  await expect(win.getByTestId('cleanup-box-edit')).toHaveAttribute('aria-pressed', 'true');
  const east = await handleAt(win, 'east');
  const west = await handleAt(win, 'west');
  if (!east || !west) throw new Error('box handles are off screen');
  await shot(win, 'cleanup-clipbox-fitted.png');
  // drag the east face half way to the west face
  await win.mouse.move(east.x, east.y);
  await win.mouse.down();
  await win.mouse.move((east.x + west.x) / 2, (east.y + west.y) / 2, { steps: 8 });
  await win.mouse.up();
  await expect.poll(async () => (await recipeOf(win))?.clipBox?.size[0] ?? 0).toBeLessThan(25);
  await expect.poll(() => drawn(win)).toBeLessThan(all * 0.75);
  const cut = await drawn(win);
  expect(cut).toBeGreaterThan(all * 0.25);
  await expect(win.getByTestId('cleanup-box-size')).toContainText(' m');
  await shot(win, 'cleanup-clipbox-cut.png');

  // Reset all cleanup: one step, every point again
  await win.getByTestId('cleanup-reset').click();
  await expect.poll(() => drawn(win)).toBe(all);
  await expect(win.getByTestId('cleanup-notice')).toContainText('Cleanup reset.');

  // Ctrl+Z brings the cut box back
  await win.keyboard.press('Control+Z');
  await expect.poll(() => drawn(win)).toBe(cut);
});

test.describe('the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the Clean up panel leaves the middle of the view free at 1100 x 700', async ({ win }) => {
    await expect.poll(() => win.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700]);
    await openNoisyProject(win);
    await openCleanupFromMenu(win);
    await win.getByTestId('cleanup-box-fit').click();
    await expect.poll(async () => (await recipeOf(win))?.clipBox?.keep).toBe('inside');
    expect(await middleReachesView(win)).toBe(true);
    await shot(win, 'cleanup-panel-1100x700.png');
  });
});
