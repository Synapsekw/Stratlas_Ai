/**
 * "Search this project" (M1 fact index) in the real app, on the change demo (two dates,
 * synthetic, zero network) at 1100 x 720. The demo ships issues but no survey measurements, so the
 * spec writes one polygon, "North stockpile", into the working copy's `survey/measurements.json`
 * first and opens the project again (as change-area.spec.ts does). Then, once main has built the
 * index (the count line replaces the state line), the Project tab's search finds the measurement
 * by "stockpile" and an issue by "corrosion" (`Corrosion on the T-201 shell`, seeded on both
 * dates by tools/demo/change-scene.mjs); a result opens its history inline (its survey date among
 * the linked records), and Rebuild index gives the same results.
 */
import { MeasurementsFile } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openChangeDemo, reportWindow, test } from './fixtures';
import { openSection } from './panel';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

const MEASUREMENT = 'North stockpile';
const ISSUE = 'Corrosion on the T-201 shell';
/** Building the index of the demo is quick; a slow CI runner gets room. */
const INDEXED = { timeout: 60_000 };

/** One polygon measurement on the later date, 10 m across the site origin. */
async function seedMeasurement(root: string, capture: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    origin: [number, number, number];
  };
  const [ox, oy, oz] = manifest.origin;
  const at = (x: number, y: number): [number, number, number] => [ox + x, oy + y, oz];
  await mkdir(join(root, 'survey'), { recursive: true });
  await writeFile(
    join(root, 'survey', 'measurements.json'),
    JSON.stringify(
      MeasurementsFile.parse({
        schema: 'aio.measurements/1',
        measurements: [
          {
            id: 'north-stockpile',
            family: 'polygon',
            tool: 'area',
            label: MEASUREMENT,
            scope: { kind: 'survey', capture },
            points: [at(-5, -5), at(5, -5), at(5, 5), at(-5, 5)],
            items: [],
            results: [],
            createdAt: '2026-10-19T00:00:00Z',
          },
        ],
      }),
      null,
      1,
    ),
  );
}

/** The search section, open, once the index answers. */
async function searchSection(win: Page): Promise<Locator> {
  const body = await openSection(win, 'project', 'project.search');
  const search = body.getByTestId('project-search');
  await expect(search).toBeVisible();
  await expect(search.getByTestId('project-search-state')).toHaveCount(0, INDEXED);
  await expect(search.getByTestId('project-search-count')).toContainText('indexed', INDEXED);
  return search;
}

/** Type a word and return the labels of the results. */
async function find(search: Locator, word: string, expected: string): Promise<string[]> {
  const field = search.getByRole('searchbox', { name: 'Search this project' });
  await field.fill(word);
  const results = search.getByTestId('project-search-result');
  await expect(results.filter({ hasText: expected }).first()).toBeVisible(INDEXED);
  return results.locator('.fs-label').allTextContents();
}

test('the Project tab search finds a measurement and an issue, with history and rebuild', async ({
  demoProject,
}) => {
  test.setTimeout(180_000);
  const { win, root, truth } = demoProject;
  await reportWindow(win);
  await seedMeasurement(root, truth.captures.to);
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openChangeDemo(win);

  const search = await searchSection(win);
  const field = search.getByRole('searchbox', { name: 'Search this project' });
  await expect(field).toBeVisible();

  // a measurement by a word of its name
  const piles = await find(search, 'stockpile', MEASUREMENT);
  expect(piles).toContain(MEASUREMENT);
  await expect(
    search.getByTestId('project-search-result').filter({ hasText: MEASUREMENT }).first(),
  ).toContainText('Measure');

  // an issue by a word of its title
  const issues = await find(search, 'corrosion', ISSUE);
  // an issue's label is its code and title
  expect(issues.filter((l) => l.endsWith(ISSUE)).length).toBeGreaterThanOrEqual(1);
  await expect(search.getByTestId('project-search-count')).toContainText(/\d+ results?/);

  // a result opens its history inline, and closes again
  const row = search.getByTestId('project-search-result').filter({ hasText: ISSUE }).first();
  const toggle = row.locator('button.fs-line');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const history = row.getByTestId('project-search-history');
  await expect(history).toBeVisible();
  await expect(history).not.toContainText('Reading its history', INDEXED);
  await expect(history.getByTestId('project-search-linked')).toContainText('Survey date');
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(row.getByTestId('project-search-history')).toHaveCount(0);

  // Rebuild index: deleting and building again gives the same results
  const rebuild = search.getByTestId('project-search-rebuild');
  await rebuild.click();
  await expect(rebuild).toHaveText('Rebuild index', INDEXED);
  await expect(rebuild).toBeEnabled(INDEXED);
  await expect(search.getByTestId('project-search-state')).toHaveCount(0, INDEXED);
  await expect
    .poll(
      () => search.getByTestId('project-search-result').locator('.fs-label').allTextContents(),
      INDEXED,
    )
    .toEqual(issues);
  expect(await find(search, 'stockpile', MEASUREMENT)).toEqual(piles);
});
