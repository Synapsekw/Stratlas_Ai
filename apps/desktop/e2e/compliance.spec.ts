/**
 * Compliance to design in the real app (M11 G6 with G4, DSN-3) on the synthetic earthworks demo
 * (survey_synth.py): with "Pad to design" in focus, **Cut/Fill to design** on the pad adds its
 * comparison to the polygon and computes it; the numbers equal G2's executor run here on the
 * same prepared tiles and design TIN, and the in-tolerance share shows under the result.
 * **Remaining to design** leaves the tolerance out; a vertical offset of -0.3 m on the pad layer
 * (Designs panel) lowers the design, so Remaining's net drops by about the area x 0.3. Off-screen,
 * zero network.
 */
import type { DesignsFile, HeightTiles, MeasurementsFile, SurveySettings } from '@aio/schema';
import { compareItem, projectResolver } from '@aio/survey';
import type { Locator, Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, openProject, PIPELINE_ENV, test } from './fixtures';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });

const readJson = async <T>(dir: string, ...path: string[]) =>
  JSON.parse(await readFile(join(dir, ...path), 'utf8')) as T;

async function open(win: Page, p: SurveyDemoProject): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/** Every item shows a result, none stale or computing. */
async function settled(panel: Locator, n: number): Promise<void> {
  await expect(panel.getByTestId('survey-cmp-item')).toHaveCount(n);
  await expect(panel.getByTestId('survey-cmp-result')).toHaveCount(n, { timeout: 60_000 });
  await expect(panel.getByText('Stale, recompute')).toHaveCount(0, { timeout: 60_000 });
  await expect(panel.getByTestId('survey-recompute')).toHaveText('Recompute', { timeout: 60_000 });
}

interface Result {
  item: string;
  status: string;
  cutM3: number;
  fillM3: number;
  netM3: number;
  areaM2: number;
  usedDeadband: boolean;
  toLabel: string;
}

/** Save and read back the measurement with its items and results. */
async function saved(win: Page, dir: string, id: string) {
  await win.getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
  const m = (
    await readJson<MeasurementsFile>(dir, 'survey', 'measurements.json')
  ).measurements.find((x) => x.id === id);
  if (!m) throw new Error(`no measurement ${id}`);
  const result = (item: string) => {
    const r = m.results.find((x) => x.item === item);
    if (!r) throw new Error(`no result for ${item}`);
    return r as unknown as Result;
  };
  return { m, result };
}

/** The Designs panel, in the Survey measurements popover (or under More tools). */
async function openDesigns(win: Page): Promise<Locator> {
  const survey = win.getByRole('button', { name: 'Survey measurements', exact: true });
  if (!(await survey.isVisible())) await win.getByRole('button', { name: 'More tools' }).click();
  await survey.click();
  await win.getByRole('button', { name: 'Designs', exact: true }).click();
  const panel = win.getByTestId('designs-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function closePops(win: Page): Promise<void> {
  // from inside the pop (a button that was used may be disabled now, leaving the focus outside)
  await win.getByTestId('designs-panel').getByRole('button', { name: 'Import design' }).focus();
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('designs-panel')).toHaveCount(0);
}

test('compliance presets compute cut/fill and remaining to the pad design, with the offset', async ({
  earthworksProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
  test.setTimeout(480_000);
  const dir = earthworksProject.dir;
  await open(win, earthworksProject);
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-list-open').click();
  await expect(win.getByTestId('survey-list')).toBeVisible();
  await win
    .getByTestId('survey-item')
    .filter({ hasText: 'Pad to design' })
    .locator('.sv-item-main')
    .click();
  const panel = win.getByTestId('survey-panel');
  await expect(panel.getByRole('textbox', { name: 'Measurement name' })).toHaveValue(
    'Pad to design',
  );
  // the surveys as height tiles, through the real survey.prepare job
  await panel.getByTestId('survey-prepare').click();
  await expect(panel.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 300_000 });
  await settled(panel, 1);

  // Cut/Fill to design on the pad, 50 mm tolerance: added to the polygon in focus and computed
  let designs = await openDesigns(win);
  const compliance = designs.getByTestId('compliance');
  await expect(compliance.getByTestId('compliance-target')).toContainText('Pad to design');
  await compliance.getByRole('combobox').first().selectOption('earthworks-design/pad');
  await compliance.getByRole('button', { name: 'Cut/Fill to design' }).click();
  await expect(compliance.getByTestId('compliance-note')).toContainText(
    'Cut/Fill to design added to "Pad to design"',
  );
  await closePops(win);
  await settled(panel, 2);
  const share = panel.getByTestId('survey-cmp-item').nth(1).getByTestId('survey-cmp-share');
  await expect(share).toContainText('% in tolerance');

  let { m, result } = await saved(win, dir, 'm-pad');
  const cfItem = m.items[1];
  if (!cfItem) throw new Error('no Cut/Fill item');
  expect(cfItem).toMatchObject({
    id: 'cut-fill-to-design-pad',
    to: { kind: 'design', design: 'earthworks-design', layer: 'pad' },
    deadbandM: 0.05,
    useDeadband: false,
  });
  const cf = result(cfItem.id);
  expect(cf.status).not.toBe('refused');

  // the same numbers from G2's executor here, over the prepared tiles and the design TIN
  const sdir = join(dir, 'survey', 'surfaces');
  const surfaces: HeightTiles[] = [];
  for (const id of await readdir(sdir))
    surfaces.push(await readJson<HeightTiles>(sdir, id, 'tiles.json'));
  const designsFile = await readJson<DesignsFile>(dir, 'survey', 'designs.json');
  const settings = await readJson<SurveySettings>(dir, 'survey', 'settings.json');
  const resolve = projectResolver({
    surfaces,
    captures: ['d1', 'd2', 'd3'],
    designs: designsFile.designs,
    fetchBytes: async (p) => {
      try {
        return new Uint8Array(await readFile(join(dir, ...p.split('/'))));
      } catch {
        return null;
      }
    },
  });
  const site = {
    verticalDatum: settings.verticalDatum,
    ...(settings.calibration ? { calibration: settings.calibration } : {}),
  };
  const ring = m.points.map((p): [number, number] => [p[0], p[1]]);
  const expected = await compareItem(ring, cfItem, resolve, { site });
  for (const k of ['cutM3', 'fillM3', 'netM3'] as const)
    expect(Math.abs(cf[k] - expected[k])).toBeLessThan(1e-6 * Math.max(1, Math.abs(expected[k])));
  // the pad is a fill pad: mostly fill, and most of the area outside the tolerance
  expect(cf.fillM3).toBeGreaterThan(1000);
  const shareOf = async (n: number) =>
    Number(
      await panel
        .getByTestId('survey-cmp-item')
        .nth(n)
        .getByTestId('survey-cmp-share')
        .getAttribute('data-share'),
    );
  const s1 = await shareOf(1);
  expect(s1).toBeGreaterThan(0);
  expect(s1).toBeLessThan(0.5);

  // Remaining to design: the tolerance is its deadband
  designs = await openDesigns(win);
  await designs
    .getByTestId('compliance')
    .getByRole('combobox')
    .first()
    .selectOption('earthworks-design/pad');
  await designs
    .getByTestId('compliance')
    .getByRole('button', { name: 'Remaining to design' })
    .click();
  await closePops(win);
  await settled(panel, 3);
  ({ m, result } = await saved(win, dir, 'm-pad'));
  const remItem = m.items[2];
  if (!remItem) throw new Error('no Remaining item');
  expect(remItem).toMatchObject({ deadbandM: 0.05, useDeadband: true });
  const before = result(remItem.id);
  expect(before.usedDeadband).toBe(true);

  // a vertical offset of -0.3 m on the pad: the design is lower, Remaining drops by area x 0.3
  designs = await openDesigns(win);
  const padRow = designs.getByTestId('design-layer-pad');
  await padRow.getByRole('spinbutton').fill('-0.3');
  await padRow.getByRole('button', { name: 'Apply vertical offset' }).click();
  await expect
    .poll(async () => (await readJson<DesignsFile>(dir, 'survey', 'designs.json')).designs)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layers: expect.arrayContaining([
            expect.objectContaining({ id: 'pad', verticalOffsetM: -0.3 }),
          ]),
        }),
      ]),
    );
  await closePops(win);
  // the results go stale and the focused polygon is computed again
  await expect
    .poll(async () => (await panel.getByTestId('survey-cmp-item').allTextContents()).join('|'), {
      timeout: 60_000,
    })
    .toContain('offset');
  await settled(panel, 3);
  ({ result } = await saved(win, dir, 'm-pad'));
  const after = result(remItem.id);
  expect(after.toLabel).toContain('offset');
  const drop = before.netM3 - after.netM3;
  const want = after.areaM2 * 0.3;
  expect(Math.abs(drop - want) / want).toBeLessThan(0.05);
});
