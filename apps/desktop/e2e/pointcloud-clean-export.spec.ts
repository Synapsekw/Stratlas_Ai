/**
 * Point cloud cleanup end to end on the noisy synthetic COPC: a lasso delete and a clip box, Save
 * cleaned copy gives a new layer with the expected point count (the evaluator over the regenerated
 * fixture), and a LAZ export of the original with Apply cleanup holds the same count (read back with
 * PDAL). Needs the pipeline Python and PDAL.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_ENV, PDAL, expect, hasPdal, hasPipelinePython, test } from './fixtures';
import {
  HIGH_OUTLIERS,
  NOISY_POINTS,
  drawn,
  expectedDrawn,
  expectedKept,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  writeNoisyProject,
} from './cleanupHelpers';
import { measureControl } from './island';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'no pipeline Python (uv sync in python/, or QUADRION_E2E_PYTHON)');
test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

interface Workspace {
  __stratlas: {
    workspace: {
      getState(): {
        project: { manifest: { layers: { id: string; pointCount?: number }[] } } | null;
      };
    };
  };
}

test('lasso delete and clip box, saved as a copy and exported with the same points', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(300_000);
  await openNoisyProject(win);
  await openCleanupFromMenu(win);

  // a lasso over the middle of the view (the panel is a tab in the sidebar, off the stage), then Delete
  await win.getByTestId('cleanup-select-lasso').click();
  const box = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const left = box.x + box.width * 0.1;
  const right = box.x + box.width * 0.9;
  const at = (fx: number, fy: number) =>
    [left + (right - left) * fx, box.y + box.height * fy] as const;
  const path = [at(0.1, 0.45), at(0.9, 0.45), at(0.9, 0.75), at(0.1, 0.75)];
  await win.mouse.move(...(path[0] ?? at(0.1, 0.45)));
  await win.mouse.down();
  for (const p of path.slice(1)) await win.mouse.move(...p, { steps: 6 });
  await win.mouse.up();
  await expect(win.getByTestId('cleanup-selection-count')).toContainText('loaded points selected');
  await win.getByTestId('cleanup-delete').click();
  await expect.poll(async () => (await recipeOf(win))?.regions.length).toBe(1);

  // a fitted clip box (it keeps every point) and a height range that drops the high outliers
  await win.getByTestId('cleanup-box-fit').click();
  await expect.poll(async () => (await recipeOf(win))?.clipBox).toBeTruthy();
  // Highest 20 m
  await win.getByTestId('cleanup-height-max').fill('20');
  await win.getByTestId('cleanup-height-max').press('Enter');
  await expect.poll(async () => (await recipeOf(win))?.height?.max).toBe(20);

  const recipe = await recipeOf(win);
  if (!recipe) throw new Error('no recipe');
  const expected = expectedKept(recipe);
  // anchors from the fixture's construction: the fitted box keeps everything, Highest 20 m drops
  // exactly the 40 high outliers (the building top is at 10 m, the trees at 6 m), and the lasso
  // deletes some points of its own
  const { clipBox, ...noBox } = recipe;
  expect(clipBox).toBeTruthy();
  expect(expectedKept({ ...noBox, regions: [] })).toBe(NOISY_POINTS - HIGH_OUTLIERS);
  expect(expectedKept({ ...recipe, regions: [] })).toBe(NOISY_POINTS - HIGH_OUTLIERS);
  expect(expected).toBeLessThan(NOISY_POINTS - HIGH_OUTLIERS);
  // the view agrees with the evaluator (every node is loaded)
  await expect.poll(() => drawn(win)).toBe(expectedDrawn(recipe));

  // Save cleaned copy: a new layer with that many points
  await win.getByTestId('cleanup-save-name').fill('Noisy scan');
  await win.getByTestId('cleanup-save').click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (window as unknown as Workspace).__stratlas.workspace
              .getState()
              .project?.manifest.layers.find((l) => l.id === 'noisy-cleaned')?.pointCount ?? 0,
        ),
      { timeout: 240_000 },
    )
    .toBe(expected);

  // export the original as LAZ with Apply cleanup: the same points
  const out = join(dataRoot.base, 'exports');
  await mkdir(out, { recursive: true });
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    out.replace(/\\/g, '/'),
  );
  // Export survey data as survey-export.spec.ts opens it (the Measure workbench, Site data)
  await (await measureControl(win, 'survey-export-open')).click();
  const dlg = win.getByTestId('survey-export-dialog');
  await dlg.getByTestId('survey-export-what').selectOption('cloud');
  await dlg.getByTestId('survey-export-source').selectOption({ label: 'Noisy scan' });
  await dlg.getByTestId('survey-export-format').selectOption('laz');
  await expect(dlg.getByTestId('survey-export-cleanup')).toBeChecked();
  await dlg.getByTestId('survey-export-run').click();
  await expect(dlg.getByTestId('survey-export-note')).toContainText('Saved', { timeout: 120_000 });
  const [file] = (await readdir(out)).filter((f) => f.endsWith('.laz'));
  if (!file) throw new Error('no export');
  const info = JSON.parse(
    execFileSync(PDAL, ['info', '--summary', join(out, file)], { encoding: 'utf8' }),
  ) as { summary: { num_points: number } };
  expect(info.summary.num_points).toBe(expected);
});
