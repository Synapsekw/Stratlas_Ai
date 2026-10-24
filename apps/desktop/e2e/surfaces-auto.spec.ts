/**
 * Survey surfaces prepared on open (volumetrics redesign, spec section 2) in the real app, on the
 * synthetic earthworks demo (three survey dates, each with a DSM, none prepared). Opening it starts
 * one quiet `survey.prepare` job for every date; a distance line's card lists each date as a chip,
 * preparing and then ready, and the stage shows the preparing card. With the setting off nothing
 * starts and a chip's Prepare starts the job for its date. A cancelled job is not followed by
 * another until the project is opened again. The preparing card leaves the view free in the
 * smallest window. Off-screen, zero network, pipeline Python needed.
 */
import { MeasurementsFile } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  hasPipelinePython,
  openProject,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import { measureTree } from './island';
import { focusMeasure } from './measureCard';
import {
  activePrepare as active,
  openDemo,
  prepareJobs,
  preparesSettled as settled,
  setAutoPrepare,
} from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const DATES = ['d1', 'd2', 'd3'];
const LINE = 'Line across the pad';

/** A distance line across the pad, filed under the second survey. */
async function seedLine(p: SurveyDemoProject): Promise<void> {
  const mfile = join(p.dir, 'survey', 'measurements.json');
  const m = MeasurementsFile.parse(JSON.parse(await readFile(mfile, 'utf8')));
  m.measurements.push({
    id: 'line-pad',
    family: 'line',
    tool: 'distance',
    label: LINE,
    scope: { kind: 'survey', capture: 'd2' },
    points: [
      [551140, 2331400, 120],
      [551260, 2331400, 121.2],
    ],
    items: [],
    results: [],
    createdAt: '2026-10-20T00:00:00Z',
  });
  await writeFile(mfile, JSON.stringify(MeasurementsFile.parse(m), null, 1));
}

/**
 * Record every state a date chip shows from now on (`window.__chipStates`): a job on the quick
 * demo can pass a state between two polls.
 */
async function watchChipStates(win: Page): Promise<void> {
  await win.evaluate(() => {
    const seen: Record<string, string[]> = {};
    const w = window as unknown as { __chipStates?: Record<string, string[]> };
    w.__chipStates = seen;
    const note = () => {
      for (const el of document.querySelectorAll('[data-testid="line-chips"] [data-chip]')) {
        const key = el.getAttribute('data-chip') ?? '';
        const state = el.getAttribute('data-state') ?? '';
        const list = (seen[key] ??= []);
        if (list[list.length - 1] !== state) list.push(state);
      }
    };
    note();
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
  });
}

/** The dates the chips show, in order. */
const chipKeys = (chips: Locator): Promise<string[]> =>
  chips
    .locator('[data-chip]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-chip') ?? ''));

const chipStates = (win: Page) =>
  win.evaluate(
    () => (window as unknown as { __chipStates?: Record<string, string[]> }).__chipStates ?? {},
  );

test('opening a project with unprepared dates starts one quiet prepare job; the distance card lists both dates, preparing then ready', async ({
  earthworksProject: p,
  win,
}) => {
  test.setTimeout(360_000);
  await seedLine(p);
  await openDemo(win, p.name, p.id);
  await measureTree(win, 'd2');
  const card = await focusMeasure(win, LINE);
  const chips = card.getByTestId('line-chips');
  // the date in view and the one before it, whatever their state
  await expect(chips.locator('[data-chip]')).toHaveCount(2, { timeout: 30_000 });
  await watchChipStates(win);
  const shown = await chipKeys(chips);

  // one job, for every date, started on its own; the stage says so while it works
  await expect
    .poll(async () => (await prepareJobs(win, p.dir)).length, { timeout: 60_000 })
    .toBe(1);
  expect((await prepareJobs(win, p.dir))[0]?.captures).toEqual(DATES);
  const prep = win.getByTestId('preparing-card');
  await expect(prep).toBeVisible();
  await expect(prep).toContainText('Preparing survey surfaces');
  await expect(prep).toContainText('Started on its own when the project opened');
  const jobs = await settled(win, p.dir);
  expect(jobs.map((j) => j.status)).toEqual(['done']);

  // every chip ends ready, after preparing; the card draws each date's line
  for (const d of shown)
    await expect(chips.locator(`[data-chip="${d}"]`)).toHaveAttribute('data-state', 'ready', {
      timeout: 30_000,
    });
  const seen = await chipStates(win);
  for (const d of shown) {
    expect(seen[d]?.at(-1)).toBe('ready');
    expect(seen[d]).toContain('preparing');
  }
  for (const d of shown)
    await expect(
      card.getByTestId('line-profile').locator(`polyline[data-series="${d}"]`).first(),
    ).toBeAttached({ timeout: 30_000 });
  await expect(card).not.toContainText('No survey data');
  // the card closes once the job is over
  await expect(prep).toHaveCount(0, { timeout: 10_000 });
  // nothing more to do: no second job
  expect(await prepareJobs(win, p.dir)).toHaveLength(1);
});

test('with the setting off nothing starts and the chip offers Prepare, which starts it', async ({
  earthworksProject: p,
  win,
}) => {
  test.setTimeout(360_000);
  await seedLine(p);
  await setAutoPrepare(win, false);
  await openDemo(win, p.name, p.id);
  await measureTree(win, 'd2');
  const card = await focusMeasure(win, LINE);
  const chips = card.getByTestId('line-chips');
  await expect(chips.locator('[data-chip]')).toHaveCount(2, { timeout: 30_000 });
  const [first, other] = await chipKeys(chips);
  if (!first || !other) throw new Error('two date chips expected');

  // well past the moment a job would start on its own: none did
  await win.waitForTimeout(6_000);
  expect(await prepareJobs(win, p.dir)).toEqual([]);
  await expect(win.getByTestId('preparing-card')).toHaveCount(0);
  for (const d of [first, other]) {
    const chip = chips.locator(`[data-chip="${d}"]`);
    await expect(chip).toHaveAttribute('data-state', 'missing');
    await expect(chip.getByTestId('chip-prepare')).toHaveText('Prepare');
  }

  // Prepare on one chip: one job for that date only
  await chips.locator(`[data-chip="${first}"]`).getByTestId('chip-prepare').click();
  await expect
    .poll(async () => (await prepareJobs(win, p.dir)).map((j) => j.captures), { timeout: 30_000 })
    .toEqual([[first]]);
  const jobs = await settled(win, p.dir);
  expect(jobs.map((j) => j.status)).toEqual(['done']);
  await expect(chips.locator(`[data-chip="${first}"]`)).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await expect(chips.locator(`[data-chip="${other}"]`)).toHaveAttribute('data-state', 'missing');
  // still nothing started on its own
  expect(await prepareJobs(win, p.dir)).toHaveLength(1);
});

test('a cancelled prepare is not restarted until the project reopens', async ({
  earthworksProject: p,
  win,
}) => {
  test.setTimeout(360_000);
  await openDemo(win, p.name, p.id);
  await expect
    .poll(async () => (await prepareJobs(win, p.dir)).filter(active).length, {
      timeout: 60_000,
      intervals: [200],
    })
    .toBe(1);
  const [job] = await prepareJobs(win, p.dir);
  const cancelled = await win.evaluate(
    (jobId) =>
      (
        window as unknown as {
          aio: { invoke(c: string, r: unknown): Promise<{ ok: boolean; error?: string }> };
        }
      ).aio.invoke('jobs:cancel', { jobId }),
    job?.id ?? '',
  );
  expect(cancelled.error ?? '').toBe('');
  const after = await settled(win, p.dir);
  expect(after.map((j) => j.status)).toEqual(['cancelled']);

  // the person stopped it: nothing starts again while the project stays open
  await win.waitForTimeout(6_000);
  expect(await prepareJobs(win, p.dir)).toHaveLength(1);

  // opened again: the dates still lack surfaces, so a new job starts
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openDemo(win, p.name, p.id);
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect
    .poll(async () => (await prepareJobs(win, p.dir)).length, { timeout: 60_000 })
    .toBe(2);
  expect((await prepareJobs(win, p.dir))[1]?.captures).toEqual(DATES);
});

test.describe('in the smallest window', () => {
  test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the preparing card does not cover the view at 1100 x 700', async ({
    earthworksProject: p,
    win,
  }) => {
    test.setTimeout(360_000);
    await openDemo(win, p.name, p.id);
    const prep = win.getByTestId('preparing-card');
    await expect(prep).toBeVisible({ timeout: 60_000 });
    // clicks at the view's centre and just above the card reach the 3D view
    const hits = await win.evaluate(() => {
      const card = document.querySelector('[data-testid="preparing-card"]');
      const canvas = document.querySelector('[data-scene-view] canvas');
      if (!card || !canvas) return null;
      const c = card.getBoundingClientRect();
      const v = canvas.getBoundingClientRect();
      const reaches = (x: number, y: number) => document.elementFromPoint(x, y) === canvas;
      return {
        centre: reaches(v.left + v.width / 2, v.top + v.height / 2),
        aboveCard: reaches(c.left + c.width / 2, c.top - 40),
        cardInView: c.left >= v.left && c.right <= v.right && c.bottom <= v.bottom + 1,
        // 330 px where the corner has room; the corner keeps to its half of the view
        fits: c.width > 0 && c.width <= 330,
      };
    });
    expect(hits).toEqual({ centre: true, aboveCard: true, cardInView: true, fits: true });
    await settled(win, p.dir);
  });
});
