/**
 * Cross-sections in the real app (M11 G5, SRV-7) on the synthetic earthworks demo: two surveys
 * prepared by `survey.prepare`, a **Cross-section** measurement across the pad opens the dock with
 * a line per survey and per design surface; a click pins a chainage with values, deltas and
 * grades; the exaggeration goes to 1:4; the large window opens; **Download** writes a DXF (2D XZ)
 * through `survey.section` and the save dialog. Off-screen, zero network, pipeline Python needed.
 */
import type { MeasurementsFile } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openDemo, prepareSurveys } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

test('a section across the pad: two surveys and the design, a pin, 1:4, the window, a DXF', async ({
  earthworksProject,
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(420_000);
  const root = earthworksProject.dir;
  await prepareSurveys(win, root);

  // a Cross-section measurement across the pad (E 551140 to 551260 at N 2331400)
  const mfile = join(root, 'survey', 'measurements.json');
  const m = JSON.parse(await readFile(mfile, 'utf8')) as MeasurementsFile;
  m.measurements.push({
    id: 'sec-pad',
    family: 'line',
    tool: 'section',
    label: 'Section across the pad',
    scope: { kind: 'site' },
    points: [
      [551140, 2331400, 120],
      [551260, 2331400, 121.2],
    ],
    items: [],
    results: [],
    createdAt: '2026-10-09T00:00:00Z',
  });
  await writeFile(mfile, JSON.stringify(m, null, 1));

  // the tool is on the toolbar
  await openDemo(win, earthworksProject.name, earthworksProject.id);
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await expect(win.getByTestId('survey-tool-section')).toBeVisible();
  await win.getByTestId('survey-list-open').click();
  await win
    .getByTestId('survey-item')
    .filter({ hasText: 'Section across the pad' })
    .locator('.sv-item-main')
    .click();

  const dock = win.getByTestId('section-dock');
  await expect(dock).toBeVisible();
  const chart = dock.getByTestId('section-chart');
  await expect(chart).toBeVisible({ timeout: 60_000 });
  for (const key of ['survey:dsm-d1', 'survey:dsm-d2', 'design:earthworks-design/pad'])
    await expect(chart.locator(`polyline[data-surface="${key}"]`).first()).toBeAttached({
      timeout: 60_000,
    });

  // pin the middle of the pad: every surface has a value, deltas to the first survey
  const box = await chart.locator('svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pin = dock.getByTestId('section-pin');
  await expect(pin).toHaveCount(1);
  await expect(pin.getByTestId('section-pin-z').first()).toContainText(' m');
  await expect(pin.getByTestId('section-pin-delta').nth(2)).toContainText('Δ');
  await expect(pin.getByTestId('section-pin-grade').first()).toContainText('%');
  // the pad is at 122 m, about 2 m over the ground in the middle
  const padZ = await pin.getByTestId('section-pin-z').nth(2).innerText();
  expect(Number.parseFloat(padZ)).toBeCloseTo(122, 1);

  // exaggeration 1:4
  await dock.getByTestId('section-exaggeration').fill('4');
  await expect(dock).toContainText('1:4');
  await expectAccessible(win, 'Cross-section dock', { include: '[data-testid="section-dock"]' });

  // the large window, then back to the dock
  await dock.getByTestId('section-popout').click();
  const big = win.getByTestId('section-window');
  await expect(big).toBeVisible();
  await expect(big.getByTestId('section-window-chart')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(big).toHaveCount(0);

  // Download as DXF (2D XZ) through the save dialog
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'section.dxf';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    out.replace(/\\/g, '/'),
  );
  await dock.getByTestId('section-format').selectOption('dxf-2d-xz');
  await dock.getByTestId('section-download').click();
  await expect(dock.getByTestId('section-export-note')).toContainText('Saved', {
    timeout: 120_000,
  });
  const dxf = await readFile(join(out, 'Section-across-the-pad-dxf-2d-xz.dxf'), 'utf8');
  expect(dxf).toContain('AC1024');
  expect(dxf).toContain('01 Survey 1 DSM');
  expect(dxf).toContain('Section chainage');
});
