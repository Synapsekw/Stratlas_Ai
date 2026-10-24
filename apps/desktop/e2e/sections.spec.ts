/**
 * Cross-sections in the real app (M11 G5, SRV-7; volumetric parity W1) on the synthetic earthworks
 * demo: two surveys prepared by `survey.prepare`, a **Cross-section** measurement across the pad
 * opens the dock on the shared profile chart with the current survey; the earlier survey and the
 * pad design join as chips; a click pins the shared point and "Add pin here" adds a section pin
 * there, its deltas against Shade vs the earlier survey and its grades; the exaggeration goes to
 * 4:1; the large window opens over the lower stage, not modal (volumetrics redesign B6), and Esc
 * or Close returns it; **DXF…** writes a DXF (2D XZ) through `survey.section` and the save dialog.
 * Off-screen, zero network, pipeline Python needed.
 */
import type { MeasurementsFile } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openDemo, prepareSurveys } from './surveyJobs';
import { measureControl, measureTree, selectMeasure } from './island';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

test('a section across the pad: two surveys and the design, a pin, 4:1, the window, a DXF', async ({
  earthworksProject,
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(420_000);
  const root = earthworksProject.dir;
  await prepareSurveys(win, root);

  // a Cross-section measurement across the pad (E 551140 to 551260 at N 2331400), filed under the
  // newest survey (an undated one whose heights match no survey would wait under Needs a date)
  const mfile = join(root, 'survey', 'measurements.json');
  const m = JSON.parse(await readFile(mfile, 'utf8')) as MeasurementsFile;
  m.measurements.push({
    id: 'sec-pad',
    family: 'line',
    tool: 'section',
    label: 'Section across the pad',
    scope: { kind: 'survey', capture: 'd3' },
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
  await expect(await measureControl(win, 'survey-tool-section')).toBeVisible();
  await measureTree(win, 'd3');
  await selectMeasure(win, 'Section across the pad');

  const dock = win.getByTestId('section-dock');
  await expect(dock).toBeVisible();
  const chart = dock.getByTestId('section-chart');
  await expect(chart).toBeVisible({ timeout: 60_000 });
  // the dock opens on the current survey (the latest prepared one) alone
  const line = (key: string) => chart.locator(`polyline[data-series="${key}"]`).first();
  await expect(line('survey:dsm-d2')).toBeAttached({ timeout: 60_000 });
  await expect(line('survey:dsm-d2')).toHaveAttribute('data-kind', 'current');
  await expect(line('survey:dsm-d1')).toHaveCount(0);

  // the earlier survey and the pad design join as chips, from "+ Add survey or design"
  const chips = dock.getByTestId('section-chips');
  const add = async (group: 'Surveys' | 'Designs', name?: RegExp) => {
    await chips.getByTestId('section-chips-add').click();
    const menu = win.getByRole('menu', { name: '+ Add survey or design' });
    const items = menu.getByRole('group', { name: group }).getByRole('menuitem');
    await (name ? items.filter({ hasText: name }) : items).first().click();
  };
  await add('Surveys');
  await expect(line('survey:dsm-d1')).toBeAttached({ timeout: 60_000 });
  await expect(line('survey:dsm-d1')).toHaveAttribute('data-kind', 'earlier');
  await add('Designs', /pad/i);
  await expect(line('design:earthworks-design/pad')).toBeAttached({ timeout: 60_000 });
  await expect(line('design:earthworks-design/pad')).toHaveAttribute('data-kind', 'design');
  await expect(chips.locator('[data-chip]')).toHaveCount(3);

  // Shade vs the earlier survey: the cut and fill between it and the current survey show
  const shade = dock.getByRole('group', { name: 'Shade vs' });
  await shade.getByRole('button').first().click();
  await expect(shade.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.getByTestId('chart-areas')).toBeVisible();

  // a click pins the shared point (it stays when the pointer leaves); "Add pin here" in its
  // read-out adds a section pin there: every surface has a value, deltas from the Shade vs target
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(chart.getByTestId('chart-pin-badge')).toBeVisible();
  const pin = dock.getByTestId('section-pin');
  await expect(pin).toHaveCount(0);
  await chart.getByTestId('section-add-pin').click();
  await expect(pin).toHaveCount(1);
  await expect(pin.getByTestId('section-pin-z')).toHaveCount(3);
  await expect(pin.getByTestId('section-pin-z').first()).toContainText(' m');
  // the target's own row has no delta; the current survey and the design have one each
  await expect(pin.getByTestId('section-pin-delta').filter({ hasText: 'Δ' })).toHaveCount(2);
  await expect(pin.locator('tr[data-reference]')).toHaveCount(1);
  await expect(pin.getByTestId('section-pin-grade').first()).toContainText('%');
  // the pad is at 122 m, about 2 m over the ground in the middle
  const padZ = await pin
    .locator('tr', { has: win.locator('th', { hasText: /pad/i }) })
    .getByTestId('section-pin-z')
    .innerText();
  expect(Number.parseFloat(padZ)).toBeCloseTo(122, 1);

  // exaggeration 4:1, on the slider and in the chart's note
  await dock.getByTestId('section-exaggeration').fill('4');
  await expect(dock).toContainText('4:1');
  await expect(chart.locator('.pc-axis-note')).toContainText('Vertical exaggeration 4:1');
  await expectAccessible(win, 'Cross-section dock', { include: '[data-testid="section-dock"]' });

  // the large window, then back to the dock
  await dock.getByTestId('section-popout').click();
  const big = win.getByTestId('section-window');
  await expect(big).toBeVisible();
  await expect(big.getByTestId('section-window-chart')).toBeVisible();
  // not a modal: a region over the lower part of the stage, no dialog, no scrim; the top of the
  // stage above it is still the stage's
  await expect(big).toHaveAttribute('role', 'region');
  await expect(win.getByRole('dialog')).toHaveCount(0);
  const stageBox = await win.locator('.stage').first().boundingBox();
  const winBox = await big.boundingBox();
  if (!stageBox || !winBox) throw new Error('no stage or window');
  expect(winBox.y).toBeGreaterThan(stageBox.y + stageBox.height * 0.3);
  const topHit = await win.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return {
        inStage: el?.closest('.stage') !== null,
        inWindow: el?.closest('[data-testid="section-window"]') !== null,
      };
    },
    [stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height * 0.35] as const,
  );
  expect(topHit).toEqual({ inStage: true, inWindow: false });
  // Esc: the section's pinned point first (when one is pinned), then the window
  await win.keyboard.press('Escape');
  await expect(big.getByTestId('chart-pin-badge')).toHaveCount(0);
  if ((await big.count()) > 0) await win.keyboard.press('Escape');
  await expect(big).toHaveCount(0);
  // the window closes from its own button too
  await dock.getByTestId('section-popout').click();
  await expect(big).toBeVisible();
  await big.getByTestId('section-window-close').click();
  await expect(big).toHaveCount(0);

  // DXF… opens the one export dialog with five variants; 2D XZ is the default
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
  await dock.getByTestId('section-dxf').click();
  const dialog = win.getByTestId('export-format-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(5);
  await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(1);
  await dialog.getByTestId('export-go').click();
  await expect(dialog).toHaveCount(0);
  await expect(dock.getByTestId('section-export-note')).toContainText('Saved', {
    timeout: 120_000,
  });
  const dxf = await readFile(join(out, 'Section-across-the-pad-dxf-2d-xz.dxf'), 'utf8');
  expect(dxf).toContain('AC1024');
  // only the lines drawn: both surveys (named by their surfaces) and the design
  expect(dxf).toMatch(/\d\d Survey 1 DSM/);
  expect(dxf).toMatch(/\d\d Survey 2 DSM/);
  expect(dxf).toContain('Section chainage');
});
