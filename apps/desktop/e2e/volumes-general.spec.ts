/**
 * Volumes and comparisons in the real app (M11 G4, PRD SRV-1 and SRV-2) on the synthetic
 * earthworks demo (three surveys, survey_synth.py): the surveys are prepared through the real
 * `survey.prepare` job, then the borrow pit gets three comparison items (survey to survey, previous
 * to current, a reference level Set to lowest). The numbers are checked against the demo's
 * truth.json and against G2's executor run here on the same prepared tiles; the deadband toggle
 * changes them; a custom base set to one level equals that typed level and a vertex edit moves the
 * volume; bulk totals add two piles; axe on the panel. Off-screen, zero network.
 */
import type { ComparisonItem, HeightTiles, MeasurementsFile } from '@aio/schema';
import { bilinear, compareItem, densify, projectResolver } from '@aio/survey';
import type { Locator, Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, openProject, PIPELINE_ENV, test } from './fixtures';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });

const readMeasurements = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'survey', 'measurements.json'), 'utf8')) as MeasurementsFile;

async function open(win: Page, p: SurveyDemoProject): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

async function openList(win: Page): Promise<void> {
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-list-open').click();
  await expect(win.getByTestId('survey-list')).toBeVisible();
}

async function focus(win: Page, label: string): Promise<Locator> {
  await win.getByTestId('survey-item').filter({ hasText: label }).locator('.sv-item-main').click();
  const panel = win.getByTestId('survey-panel');
  await expect(panel.getByRole('textbox', { name: 'Measurement name' })).toHaveValue(label);
  return panel;
}

/** Every item shows a result, none stale or computing. */
async function settled(panel: Locator, n: number): Promise<void> {
  await expect(panel.getByTestId('survey-cmp-item')).toHaveCount(n);
  await expect(panel.getByTestId('survey-cmp-result')).toHaveCount(n, { timeout: 60_000 });
  await expect(panel.getByText('Stale, recompute')).toHaveCount(0, { timeout: 60_000 });
  await expect(panel.getByTestId('survey-recompute')).toHaveText('Recompute', { timeout: 60_000 });
}

/** Save and read back the measurement with its results. */
async function saved(win: Page, dir: string, id: string) {
  await win.getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
  const m = (await readMeasurements(dir)).measurements.find((x) => x.id === id);
  if (!m) throw new Error(`no measurement ${id}`);
  return m;
}

const result = (m: { results: { item: string }[] }, item: string) => {
  const r = m.results.find((x) => x.item === item);
  if (!r) throw new Error(`no result for ${item}`);
  return r as unknown as {
    status: string;
    cutM3: number;
    fillM3: number;
    netM3: number;
    usedDeadband: boolean;
    fingerprint: string;
    toCapture?: string;
    fromCapture?: string;
  };
};

/** G2's executor over the prepared tiles on disk, for the expected numbers. */
async function engineOn(dir: string) {
  const sdir = join(dir, 'survey', 'surfaces');
  const surfaces: HeightTiles[] = [];
  for (const id of await readdir(sdir))
    surfaces.push(JSON.parse(await readFile(join(sdir, id, 'tiles.json'), 'utf8')) as HeightTiles);
  const resolve = projectResolver({
    surfaces,
    captures: ['d1', 'd2', 'd3'],
    fetchBytes: async (p) => {
      try {
        return new Uint8Array(await readFile(join(dir, ...p.split('/'))));
      } catch {
        return null;
      }
    },
  });
  return { resolve, surfaces };
}

test.describe('volumes and comparisons', () => {
  test('a polygon with three comparisons, the deadband, Set to lowest, a custom base and bulk totals', async ({
    earthworksProject,
    win,
  }) => {
    test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
    test.setTimeout(420_000);
    const dir = earthworksProject.dir;
    const truth = earthworksProject.truth as {
      comparisons: {
        measurement: string;
        from: string;
        to: string;
        cutM3: number;
        fillM3: number;
      }[];
    };
    const want = (m: string, from: string, to: string) => {
      const t = truth.comparisons.find(
        (c) => c.measurement === m && c.from === from && c.to === to,
      );
      if (!t) throw new Error(`no truth for ${m} ${from} ${to}`);
      return t;
    };
    await open(win, earthworksProject);
    await openList(win);
    let panel = await focus(win, 'Borrow pit');

    // no prepared surface yet: prepare them through the real survey.prepare job
    await panel.getByTestId('survey-prepare').click();
    await expect(panel.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 300_000 });
    await settled(panel, 1);

    // three items: survey to survey (d1 to d2), previous to current (d2 to d3), a reference level
    await panel.getByTestId('survey-add-comparison').click();
    await panel.getByTestId('survey-add-comparison').click();
    const items = panel.getByTestId('survey-cmp-item');
    await expect(items).toHaveCount(3);
    const first = items.nth(0);
    await first.getByTestId('survey-from').selectOption('survey:dsm-d1');
    await first.getByTestId('survey-to').selectOption('survey:dsm-d2');
    const third = items.nth(2);
    await third.getByTestId('survey-from').selectOption('reference');
    await expect(third.getByTestId('survey-ref-level')).toBeVisible();
    await third.getByTestId('survey-ref-lowest').click();
    await expect(third.getByTestId('survey-ref-lowest')).toHaveAttribute('aria-pressed', 'true');
    await settled(panel, 3);

    let pit = await saved(win, dir, 'm-pit');
    const ids = pit.items.map((x) => x.id);
    const [id1 = '', id2 = '', id3 = ''] = ids;
    // survey to survey: the pit dug between the first two surveys
    const t12 = want('m-pit', 'd1', 'd2');
    const r1 = result(pit, id1);
    expect(r1.status).toBe('ok');
    expect(Math.abs(r1.cutM3 - t12.cutM3) / t12.cutM3).toBeLessThan(0.005);
    expect(r1.fillM3).toBeLessThan(1);
    // previous to current resolves to d2 and d3
    const t23 = want('m-pit', 'd2', 'd3');
    const r2 = result(pit, id2);
    expect([r2.fromCapture, r2.toCapture]).toEqual(['d2', 'd3']);
    expect(Math.abs(r2.fillM3 - t23.fillM3) / t23.fillM3).toBeLessThan(0.01);

    // Set to lowest equals a typed level at the perimeter minimum of the current survey
    const { resolve } = await engineOn(dir);
    const ring = pit.points.map((p): [number, number] => [p[0], p[1]]);
    const cur = await resolve({ kind: 'current' });
    if (cur.kind !== 'grid') throw new Error('current is a grid');
    const g = cur.grid;
    const local = ring.map(([e, n]): [number, number] => [e - g.originE, n - g.originN]);
    const { xs, ys } = densify(local, g.cellM);
    const zs = Array.from(await bilinear(g, xs, ys, 0, 0)).filter(Number.isFinite);
    const lowest = Math.min(...zs);
    const typed: ComparisonItem = {
      id: 'typed',
      from: { kind: 'reference', mode: 'level', levelM: lowest },
      to: { kind: 'current' },
      useDeadband: false,
    };
    const expected = await compareItem(ring, typed, resolve);
    const r3 = result(pit, id3);
    expect(r3.status).not.toBe('refused');
    expect(Math.abs(r3.netM3 - expected.netM3)).toBeLessThan(
      1e-6 * Math.max(1, Math.abs(expected.netM3)),
    );
    expect(r3.fillM3).toBeGreaterThan(0);

    // the deadband: the 3 cm lift between d2 and d3 drops out with the 0.1 m deadband used
    const second = items.nth(1);
    await second.getByTestId('survey-use-deadband').check();
    await settled(panel, 3);
    pit = await saved(win, dir, 'm-pit');
    const r2db = result(pit, id2);
    expect(r2db.usedDeadband).toBe(true);
    expect(r2db.fillM3).toBe(0);
    expect(r2db.fingerprint).not.toBe(r2.fingerprint);
    await second.getByTestId('survey-use-deadband').uncheck();
    await settled(panel, 3);

    // a custom base with every vertex at one level equals that typed level
    const level = Math.round((lowest - 0.5) * 1000) / 1000;
    await third.getByTestId('survey-from').selectOption('custom');
    const editor = third.getByTestId('survey-base-editor');
    await expect(editor.getByTestId('survey-base-row')).toHaveCount(4);
    await editor.getByTestId('survey-base-level').fill(String(level));
    await editor.getByTestId('survey-base-level-apply').click();
    await settled(panel, 3);
    pit = await saved(win, dir, 'm-pit');
    const flat = await compareItem(
      ring,
      { ...typed, from: { kind: 'reference', mode: 'level', levelM: level } },
      resolve,
    );
    const rc = result(pit, id3);
    expect(Math.abs(rc.netM3 - flat.netM3) / Math.abs(flat.netM3)).toBeLessThan(0.002);
    // raise one vertex by 2 m: the base rises, the volume above it falls
    await editor
      .getByTestId('survey-base-value')
      .first()
      .fill(String(level + 2));
    await editor.getByTestId('survey-base-value').first().press('Enter');
    await settled(panel, 3);
    pit = await saved(win, dir, 'm-pit');
    expect(result(pit, id3).netM3).toBeLessThan(rc.netM3 - 1);

    await expectAccessible(win, 'Survey comparisons panel', {
      include: '[data-testid="survey-side"]',
    });

    // bulk totals of the two stockpiles' changes (same item positions)
    panel = await focus(win, 'Stockpile A');
    await settled(panel, 2);
    panel = await focus(win, 'Stockpile B');
    await settled(panel, 1);
    for (const label of ['Stockpile A', 'Stockpile B'])
      await win.getByTestId('survey-item').filter({ hasText: label }).getByRole('checkbox').check();
    const bulk = win.getByTestId('survey-bulk');
    await expect(bulk).toBeVisible();
    await win.getByTestId('survey-list-save').click();
    await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
    const file = await readMeasurements(dir);
    const a = file.measurements.find((x) => x.id === 'm-pile-a');
    const b = file.measurements.find((x) => x.id === 'm-pile-b');
    if (!a || !b) throw new Error('the piles');
    const sum = result(a, 'change').netM3 + result(b, 'change').netM3;
    const t =
      want('m-pile-b', 'd2', 'd3').fillM3 +
      want('m-pile-a', 'd2', 'd3').fillM3 -
      want('m-pile-a', 'd2', 'd3').cutM3;
    expect(Math.abs(sum - t)).toBeLessThan(0.02 * Math.abs(t) + 1);
    const shown = (await bulk.getByTestId('survey-bulk-net').first().textContent()) ?? '';
    expect(Number(shown.replace(/[^0-9.-]/g, ''))).toBeCloseTo(sum, 0);
    await expectAccessible(win, 'Survey bulk totals', { include: '[data-testid="survey-bulk"]' });
  });

  test('whole-site cut and fill as a job, with draft regions kept as measurements', async ({
    earthworksProject,
    win,
  }) => {
    test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
    test.setTimeout(420_000);
    const dir = earthworksProject.dir;
    await open(win, earthworksProject);
    await openList(win);
    const panel = await focus(win, 'Borrow pit');
    await panel.getByTestId('survey-prepare').click();
    await expect(panel.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 300_000 });
    await settled(panel, 1);
    const before = (await readMeasurements(dir)).measurements.length;

    await win.getByRole('button', { name: 'Survey measurements' }).click();
    await win.getByTestId('survey-site-open').click();
    const dlg = win.getByTestId('survey-site');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('survey-site-from').selectOption('previous');
    await dlg.getByTestId('survey-site-to').selectOption('current');
    await dlg.getByTestId('survey-site-run').click();
    await expect(dlg.getByTestId('survey-site-result')).toBeVisible({ timeout: 300_000 });
    await expect(dlg.getByTestId('survey-site-result')).toContainText('m³');
    // the job wrote its difference, heat map and contours
    const outs = await readdir(join(dir, 'survey', 'compare'));
    const out = outs.find((x) => x.startsWith('site-'));
    expect(out).toBeTruthy();
    const files = await readdir(join(dir, 'survey', 'compare', out ?? ''));
    expect(files).toEqual(expect.arrayContaining(['result.json', 'difference.json', 'heat']));
    // drafts: pick two, keep them as measurements
    const drafts = dlg.getByTestId('survey-site-draft');
    await expect(drafts.first()).toBeVisible({ timeout: 60_000 });
    expect(await drafts.count()).toBeGreaterThanOrEqual(2);
    await drafts.nth(0).check();
    await drafts.nth(1).check();
    await expectAccessible(win, 'Whole site cut and fill', {
      include: '[data-testid="survey-site"]',
    });
    await dlg.getByTestId('survey-site-accept').click();
    await dlg.getByRole('button', { name: 'Close' }).click();
    await win.getByTestId('survey-list-save').click();
    await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
    const after = (await readMeasurements(dir)).measurements;
    expect(after).toHaveLength(before + 2);
    const kept = after.filter((m) => m.folder === 'Whole-site regions');
    expect(kept).toHaveLength(2);
    for (const m of kept) {
      expect(m.family).toBe('polygon');
      expect(m.points.length).toBeGreaterThanOrEqual(3);
      expect(m.items[0]?.from).toEqual({ kind: 'previous' });
    }
  });
});
