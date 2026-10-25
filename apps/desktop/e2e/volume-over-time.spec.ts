/**
 * Volume over time (volumetric parity W4) in the real app, on the synthetic quarry demo: three
 * monthly surveys prepared through the real `survey.prepare` job; a stockpile's volume card charts
 * its volume on every survey date (the latest marked) and lists it with the change in a table; the
 * dates strip under the stage stacks the site inventory by material, and the Volumes tab's header
 * gives each date's total as it comes into focus. Every figure is checked against
 * the demo's `truth.json` (the quick grid, within its 2 % tolerance: the bases equal the planar
 * ground, so each pile's volume is its shape's). The quarry demo is used rather than the change
 * demo: it has the volume measurements and the per-date truth. Off-screen, zero network, pipeline
 * Python needed.
 */
import type { Locator, Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';
import { measureTree, volumesView } from './island';
import { focusMeasure, volumeSettled } from './measureCard';
import { openDemo, setAutoPrepare } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');

/** The quarry's survey dates, oldest first (survey_synth.py `quarry_site`). */
const DATES = ['m1', 'm2', 'm3'] as const;

interface QuarryTruth {
  stockpiles: Record<string, { dates: Partial<Record<string, { volumeM3: number }>> }>;
  /** The pit: the sump cut on the last date (its month-on-month change then). */
  pit: { sumpCutM3: number };
}

/**
 * A number the app shows ("1 234.5 m³", "+56.7 m³"): its first figure, signed. Its digit groups
 * may be split by any space (the card's primary value uses a narrow no-break one).
 */
const figure = (text: string): number => {
  const m = /[-+−]?[\d ,]*\d(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,+]/g, '').replace('−', '-'));
};

/** Within the quick demo's tolerance: 2 % of the truth, and half a cubic metre. */
function near(got: number, want: number): void {
  expect(Math.abs(got - want), `${String(got)} against ${String(want)}`).toBeLessThanOrEqual(
    0.02 * Math.abs(want) + 0.5,
  );
}

/**
 * Open the quarry, prepare every survey's surface from the first pile's card, and wait. Preparing
 * on open is switched off first: Prepare here is the one job (a background one already at work
 * would keep Prepare waiting, or have prepared the surfaces and taken it away, before the click).
 */
async function prepared(win: Page, name: string, id: string): Promise<Locator> {
  await setAutoPrepare(win, false);
  await openDemo(win, name, id);
  await measureTree(win);
  const card = await focusMeasure(win, 'Stockpile SP1');
  await card.getByTestId('survey-prepare').click();
  await expect(card.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 240_000 });
  await volumeSettled(card, 1, 120_000);
  return card;
}

test('a volume measurement shows a bar per survey date with the latest highlighted and the change in the table', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(480_000);
  const truth = (quarryProject.truth as unknown as QuarryTruth).stockpiles.sp1?.dates ?? {};
  const want = (d: string) => truth[d]?.volumeM3 ?? Number.NaN;
  const card = await prepared(win, quarryProject.name, quarryProject.id);

  // the chart: one mark per survey date, the latest (31 March) marked
  const chart = card.getByTestId('time-chart');
  await expect(chart).toBeVisible({ timeout: 120_000 });
  await expect(chart).toHaveAttribute('data-kind', 'volume');
  const dots = chart.locator('circle[data-dot]');
  await expect(dots).toHaveCount(DATES.length, { timeout: 120_000 });
  await expect(chart.locator('circle[data-latest]')).toHaveCount(1);
  await expect(chart.locator('circle[data-latest]')).toHaveAttribute('data-dot', 'm3');
  // no date is missing or stale
  await expect(chart.locator('[data-gap], [data-stale]')).toHaveCount(0);
  // every date names itself on the card's axis, in the short form (only the first used to)
  const ticks = chart.locator('[data-axis="t"] text');
  await expect(ticks).toHaveText(['31 Jan', '28 Feb', '31 Mar']);
  for (const tick of await ticks.all()) await expect(tick).toBeVisible();

  // the table: a row per date, oldest first, the latest highlighted, the change from the date before
  const table = card.getByTestId('vol-time-table');
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(DATES.length);
  await expect(rows.last()).toHaveAttribute('aria-current', 'date');
  await expect(rows.last()).toHaveAttribute('data-latest', '');
  await expect(table.locator('tbody tr[data-latest]')).toHaveCount(1);
  await expect(rows.first().locator('td').nth(1)).toHaveText('');
  const shown: number[] = [];
  for (const [i, d] of DATES.entries()) {
    const value = figure(await rows.nth(i).locator('td').first().innerText());
    near(value, want(d));
    shown.push(value);
  }
  // the change column is each date less the one before (the cone grows: positive)
  for (let i = 1; i < DATES.length; i++) {
    const change = figure(await rows.nth(i).locator('td').nth(1).innerText());
    expect(change).toBeGreaterThan(0);
    expect(Math.abs(change - ((shown[i] ?? 0) - (shown[i - 1] ?? 0)))).toBeLessThanOrEqual(0.15);
    near(change, want(DATES[i] ?? '') - want(DATES[i - 1] ?? ''));
  }
  // "Since 28 February": the latest change again, beside the material
  await expect(card.getByTestId('vol-since')).toContainText(/28 Feb/);
  await expect(card.getByTestId('vol-material')).toContainText('Crushed rock 20 mm');
  // the primary value is the latest date's figure
  near(figure(await card.getByTestId('card-primary').locator('.mc-value').innerText()), want('m3'));

  // hovering the last date reads its volume and change
  const plot = chart.getByTestId('time-plot');
  await plot.focus();
  await expect(chart.getByTestId('time-readout')).toBeVisible();
  await expect(chart.getByTestId('time-readout')).toContainText(/31 Mar/);
  await expectAccessible(win, 'Volume over time', { include: '[data-testid="survey-panel"]' });

  // the same figures in the pile's panel (the Volumes tab, where a picked pile opens): the latest
  // volume, its tonnes at the material's density (1.6 t/m³) and the change since 28 February
  const view = await volumesView(win);
  const panel = view.getByTestId('pile-panel');
  await expect(panel).toHaveAttribute('aria-label', 'Stockpile SP1');
  near(figure(await panel.getByTestId('pile-kpi-volume').innerText()), want('m3'));
  near(figure(await panel.getByTestId('pile-kpi-tonnes').innerText()) / 1.6, want('m3'));
  await expect(panel.getByTestId('pile-kpi-vs')).toHaveAttribute('data-sign', 'gain');
  await expect(panel.getByTestId('pile-kpi-vs')).toContainText(/28 Feb/);
  near(
    figure(await panel.getByTestId('pile-kpi-vs').locator('b').innerText()),
    want('m3') - want('m2'),
  );
  // History: a row per date, newest first, the earliest "first"
  await panel.getByTestId('pile-tab-history').click();
  const hist = panel.getByTestId('pile-history-table').locator('tbody tr');
  await expect(hist).toHaveCount(DATES.length);
  for (const [i, d] of [...DATES].reverse().entries())
    near(figure(await hist.nth(i).locator('td').first().innerText()), want(d));
  await expect(hist.last().locator('td').last()).toHaveText('first');
});

test('the site inventory stacks the materials in the dates strip, each date its total', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(480_000);
  const truth = quarryProject.truth as unknown as QuarryTruth;
  const piles = truth.stockpiles;
  const at = (pile: string, d: string) => piles[pile]?.dates[d]?.volumeM3 ?? 0;
  // the pit's month-on-month change: nothing in February, the sump cut (a negative net) in March
  const pit = (d: string) => (d === 'm3' ? -truth.pit.sumpCutM3 : 0);
  await prepared(win, quarryProject.name, quarryProject.id);

  // the Volumes tab (the pile picked to prepare opened in its panel: back to the inventory first)
  const view = await volumesView(win);
  await view.getByTestId('pile-back').click();
  await expect(view.getByTestId('volumes-pile')).toHaveCount(4);
  await expect(view.getByTestId('volumes-inventory')).toBeVisible({ timeout: 180_000 });

  // the site inventory over time is the dates strip under the stage (volumetrics redesign C4b):
  // the materials stacked, a point on each survey's total
  const strip = win.locator('[aria-label="Survey dates chart"]');
  await expect(strip).toBeVisible();
  await expect(strip.locator('circle.ds-dot')).toHaveCount(DATES.length, { timeout: 180_000 });
  await expect(strip.locator('g[data-stack="crushed-20"]')).toHaveCount(1);
  await expect(strip.locator('g[data-stack="washed-sand"]')).toHaveCount(1);
  // the legend names the materials stacked
  await expect(strip.getByTestId('strip-legend')).toContainText('Crushed rock 20 mm');
  await expect(strip.getByTestId('strip-legend')).toContainText('Washed sand');

  // each date's total, in the Volumes header as the date comes into focus, is the truth of every
  // volume measurement counted on it (SP3 lies on the bare ground until March: about 0); the
  // pit's month-on-month change has no date before the first, so it is not counted there
  const header = view.getByTestId('volumes-header');
  for (const d of DATES) {
    await strip.locator(`[data-survey="${d}"]`).click();
    await expect(strip.locator(`[data-survey="${d}"]`)).toHaveAttribute('aria-current', 'date');
    const want = at('sp1', d) + at('sp2', d) + at('sp3', d) + pit(d);
    await expect
      .poll(async () => figure(await header.getByTestId('volumes-kpi-volume').innerText()))
      .toBeCloseTo(want, -1);
    near(figure(await header.getByTestId('volumes-kpi-volume').innerText()), want);
    // the strip's readout reads the same survey
    await expect(strip.getByTestId('strip-readout')).toContainText(
      d === 'm1' ? '31 Jan 2026' : d === 'm2' ? '28 Feb 2026' : '31 Mar 2026',
    );
  }
  await strip.locator('[data-survey="m1"]').click();
  await expect(header.getByTestId('volumes-status')).toContainText('Pit (month on month)');
  await expectAccessible(win, 'Site inventory', { include: '[data-testid="volumes-view"]' });
});
