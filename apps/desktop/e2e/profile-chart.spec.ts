/**
 * The one profile chart (volumetric parity W1) in the real app, on the synthetic earthworks demo:
 * two surveys and the pad design (from the demo's DXF and LandXML design files) prepared through
 * the real `survey.prepare` job. On a distance line's card the earlier survey and the design join
 * as chips, each line drawn in its kind's style; Shade vs the design shades the cut and fill
 * between it and the current survey and names their areas; the hover read-out gives both
 * elevations and the difference. A chip switched off takes its line away (and the shading aimed
 * at it); the cross-section's DXF… opens the one export dialog with its five variants. The
 * earthworks demo is used rather than the change demo: it has prepared-surface truth and a design.
 * Off-screen, zero network, pipeline Python needed.
 */
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { measureTree, selectMeasure } from './island';
import { focusMeasure } from './measureCard';
import { openDemo, runJob } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** The second survey's label (survey_synth.py `earthworks_site`): the current one here. */
const CURRENT = 'Survey 6 April 2026';
const EARLIER = 'Survey 2 March 2026';
/** The pad design's prepared surface, as the card keys it. */
const DESIGN_KEY = 'design:design-pad';
const DESIGN = 'Pad design';

/**
 * The first two surveys' DSMs and the pad design as height tiles, then a distance line and a
 * cross-section across the pad (E 551140 to 551260 at N 2331400) in the measurements.
 */
async function prepared(win: Page, p: SurveyDemoProject): Promise<void> {
  // two surveys only: a card lists every survey date and starts on the latest, so the demo's third
  // survey is left out of this copy (its files stay, unlisted)
  const mpath = join(p.dir, 'manifest.json');
  const manifest = ProjectManifest.parse(JSON.parse(await readFile(mpath, 'utf8')));
  await writeFile(
    mpath,
    JSON.stringify(
      ProjectManifest.parse({
        ...manifest,
        captures: manifest.captures.filter((c) => c.id !== 'd3'),
        layers: manifest.layers.filter((l) => l.capture !== 'd3'),
      }),
      null,
      2,
    ),
  );
  await runJob(win, 'survey.prepare', p.dir, {
    surfaces: [
      {
        id: 'dsm-d1',
        name: 'Survey 1 DSM',
        source: { kind: 'dsm', layer: 'dsm-d1' },
        capture: 'd1',
      },
      {
        id: 'dsm-d2',
        name: 'Survey 2 DSM',
        source: { kind: 'dsm', layer: 'dsm-d2' },
        capture: 'd2',
      },
      {
        id: 'design-pad',
        name: DESIGN,
        source: { kind: 'design', design: 'earthworks-design', layer: 'pad' },
      },
    ],
    geodesy: false,
  });
  const mfile = join(p.dir, 'survey', 'measurements.json');
  const m = MeasurementsFile.parse(JSON.parse(await readFile(mfile, 'utf8')));
  const across = {
    family: 'line' as const,
    scope: { kind: 'survey' as const, capture: 'd2' },
    points: [
      [551140, 2331400, 120],
      [551260, 2331400, 121.2],
    ] as [number, number, number][],
    items: [],
    results: [],
    createdAt: '2026-10-20T00:00:00Z',
  };
  m.measurements.push(
    { ...across, id: 'line-pad', tool: 'distance', label: 'Line across the pad' },
    { ...across, id: 'sec-pad', tool: 'section', label: 'Section across the pad' },
  );
  await writeFile(mfile, JSON.stringify(MeasurementsFile.parse(m), null, 1));
  await openDemo(win, p.name, p.id);
  await measureTree(win, 'd2');
}

/** Add a survey or design from the chips' "+ Add survey or design" menu. */
async function addChip(chips: Locator, group: 'Surveys' | 'Designs', name: string): Promise<void> {
  await chips.getByTestId('line-chips-add').click();
  const menu = chips.page().getByRole('menu', { name: '+ Add survey or design' });
  await expect(menu).toBeVisible();
  await menu.getByRole('group', { name: group }).getByRole('menuitem', { name }).click();
  await expect(menu).toHaveCount(0);
}

test('add an earlier survey and the design as chips, shade vs design, hover shows both elevations and the difference', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const card = await focusMeasure(win, 'Line across the pad');
  const chips = card.getByTestId('line-chips');
  const chart = card.getByTestId('line-profile');
  const line = (key: string) => chart.locator(`polyline[data-series="${key}"]`).first();

  // the latest prepared survey is current; the card starts with the date before it too: take
  // that one off, then add it back with the design
  await expect(line('d2')).toHaveAttribute('data-kind', 'current', { timeout: 60_000 });
  await chips
    .locator('[data-chip="d1"]')
    .getByRole('button', { name: `Remove ${EARLIER}` })
    .click();
  await expect(chart.locator('polyline[data-series="d1"]')).toHaveCount(0);
  // with the current survey alone there is nothing to shade against
  await expect(card.getByRole('group', { name: 'Shade vs' })).toHaveCount(0);

  await addChip(chips, 'Surveys', EARLIER);
  await expect(line('d1')).toHaveAttribute('data-kind', 'earlier', { timeout: 60_000 });
  await addChip(chips, 'Designs', DESIGN);
  await expect(line(DESIGN_KEY)).toHaveAttribute('data-kind', 'design', { timeout: 60_000 });
  // the design is dashed, the current survey solid: styles by kind, never by order
  await expect(line(DESIGN_KEY)).toHaveAttribute('stroke-dasharray', '6 4');
  await expect(line('d2')).not.toHaveAttribute('stroke-dasharray', /./);
  await expect(chips.locator('[data-chip]')).toHaveCount(3);

  // Shade vs the design: the cut and fill between it and the current survey, with their areas
  const shade = card.getByRole('group', { name: 'Shade vs' });
  await expect(shade.getByRole('button')).toHaveText([EARLIER, DESIGN, 'None']);
  await shade.getByRole('button', { name: DESIGN, exact: true }).click();
  await expect(shade.getByRole('button', { name: DESIGN, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(chart.locator('polygon.pc-cut, polygon.pc-fill').first()).toBeAttached();
  const areas = chart.getByTestId('chart-areas');
  await expect(areas).toBeVisible();
  await expect(areas.locator('[data-kind="cut"]')).toContainText(/^Cut [\d.,]+ m²$/);
  await expect(areas.locator('[data-kind="fill"]')).toContainText(/^Fill [\d.,]+ m²$/);

  // hover the middle of the pad: both elevations and the difference between them
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const readout = chart.getByTestId('chart-readout');
  await expect(readout).toBeVisible();
  await expect(readout).toContainText(CURRENT);
  await expect(readout).toContainText(DESIGN);
  await expect(readout).toContainText('Difference');
  const z = async (row: string) =>
    Number.parseFloat(await readout.locator(`[data-row="${row}"] dd`).innerText());
  const current = await z('d2');
  const design = await z(DESIGN_KEY);
  // the pad is built at 122 m on ground about 2 m lower: the difference is current less design
  expect(design).toBeCloseTo(122, 0);
  const diff = Number.parseFloat(
    (await readout.locator('[data-row="diff"] dd').innerText()).replace('−', '-'),
  );
  expect(diff).toBeCloseTo(current - design, 2);
  await expect(chart.getByTestId('chart-crosshair')).toBeAttached();
  // the screen reader hears the chainage and the difference
  await expect(chart.getByTestId('chart-live')).toContainText('Difference');
  await expectAccessible(win, 'Profile chart', { include: '[data-testid="survey-panel"]' });
});

test('turning a chip off removes its line; DXF opens one dialog with five variants', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const card = await focusMeasure(win, 'Line across the pad');
  const chips = card.getByTestId('line-chips');
  const chart = card.getByTestId('line-profile');
  const lines = (key: string) => chart.locator(`polyline[data-series="${key}"]`);
  await expect(lines('d1').first()).toBeAttached({ timeout: 60_000 });

  // Shade vs the earlier survey, then switch its chip off: its line goes, the shading with it
  const shade = card.getByRole('group', { name: 'Shade vs' });
  await shade.getByRole('button', { name: EARLIER, exact: true }).click();
  await expect(chart.getByTestId('chart-areas')).toBeVisible();
  const chip = chips.locator('[data-chip="d1"]');
  const toggle = chip.getByRole('button', { name: EARLIER, exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(lines('d1')).toHaveCount(0);
  await expect(chip).toHaveCount(1);
  await expect(chart.getByTestId('chart-areas')).toHaveCount(0);
  await expect(card.getByRole('group', { name: 'Shade vs' })).toHaveCount(0);
  // on again: the line is back, and Shade vs offers it again
  await toggle.click();
  await expect(lines('d1').first()).toBeAttached();
  await expect(shade.getByRole('button', { name: EARLIER, exact: true })).toBeVisible();

  // the cross-section's DXF… opens the one export dialog: five DXF variants, 2D XZ first picked
  await selectMeasure(win, 'Section across the pad');
  const dock = win.getByTestId('section-dock');
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId('section-chart')).toBeVisible({ timeout: 60_000 });
  await dock.getByTestId('section-dxf').click();
  const dialog = win.getByTestId('export-format-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(5);
  await expect(dialog.getByRole('radio', { name: 'DXF 2D (XZ plane)' })).toBeChecked();
  for (const name of ['DXF 2D (XY plane)', 'DXF 2D (YZ plane)', 'DXF 3D (Z up)', 'DXF 3D (Y up)'])
    await expect(dialog.getByRole('radio', { name })).toBeVisible();
  await expectAccessible(win, 'Export dialog', { include: '[data-testid="export-format-dialog"]' });
  // closing it exports nothing
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(dock.getByTestId('section-export-note')).toHaveCount(0);
});
