/**
 * The groups of the Project tab's "In this project" list in the real app, and the order a
 * project's category gives them: a telecom project lists Antennas, Sectors, Coverage plan,
 * Measurements, Issues; a survey project Measurements then Issues, with Antennas at the end once
 * some are detected. A measurement picked in the left tree is the selected row in Measurements
 * with its panel under it, an issue row opens the issue's card in Selection, a saved sector shows
 * its bearing and opens in Coverage, and the new project wizard offers Telecom towers. The
 * inventory is the synthetic RF fixture; only the survey order's detection runs the pipeline.
 */
import { MeasurementsFile, ProjectManifest, RfSectorsFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_ENV, expect, hasPipelinePython, test } from './fixtures';
import { measureBench, measureControl, measureTree, selectMeasure } from './island';
import { writeRfProject } from './rfFixtures';
import { writeTelecomTower } from './telecomFixtures';

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string, atTop = false): Promise<void> {
  if (!EVIDENCE) return;
  if (atTop)
    await win
      .locator('.right .wb-scroll')
      .first()
      .evaluate((el) => (el.scrollTop = 0));
  // a beat and two frames: a fold or a dialog that was just opened has stopped moving
  await win.evaluate(
    () =>
      new Promise((r) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 400),
      ),
  );
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `project-groups-${name}.png`) });
}

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/** Write the manifest's project type (`purpose`) into the project the fixture wrote. */
async function setPurpose(dir: string, purpose: 'telecom' | 'survey'): Promise<void> {
  const file = join(dir, 'manifest.json');
  const manifest = ProjectManifest.parse(JSON.parse(await readFile(file, 'utf8')));
  await writeFile(file, JSON.stringify(ProjectManifest.parse({ ...manifest, purpose })));
}

/** The titles of the list's groups in the order shown, and which of them are open. */
async function groups(win: Page): Promise<{ order: string[]; open: string[] }> {
  await measureBench(win);
  return win.evaluate(() => {
    const sections = [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="wb-section-project-"]'),
    ];
    return {
      order: sections.map((s) => s.querySelector('.wb-section-title')?.textContent ?? ''),
      open: sections
        .filter(
          (s) => s.querySelector('.wb-section-head')?.getAttribute('aria-expanded') === 'true',
        )
        .map((s) => s.querySelector('.wb-section-title')?.textContent ?? ''),
    };
  });
}

/** Open a group of the list by its id, if it is folded, and return its section. */
async function openGroup(win: Page, id: string) {
  const section = win.getByTestId(`wb-section-project-${id}`);
  const head = section.locator('.wb-section-head').first();
  await head.scrollIntoViewIfNeeded();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  return section;
}

/** One measurement of each family, filed under the tiny project's only survey date. */
const SEED = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
  kitPilesConverted: [],
  measurements: [
    {
      id: 'line-b',
      family: 'line',
      tool: 'distance',
      label: 'Line B',
      scope: { kind: 'survey', capture: 'capture-1' },
      points: [
        [500000.6, 3200000.7, 10.5],
        [500003.6, 3200004.7, 11.5],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'spot-c',
      family: 'point',
      tool: 'elevation',
      label: 'Spot C',
      scope: { kind: 'survey', capture: 'capture-1' },
      points: [[500002, 3200002, 10.8]],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
  ],
});

/** One issue on the tiny project's quad, as the fixtures write them. */
const ISSUE = {
  id: 'issue-f01',
  code: 'F01',
  classId: 'damage',
  severityModelId: 'none',
  severity: 'uncertain',
  status: 'reviewed',
  title: 'Damage on the quad',
  note: '',
  author: 'E2E',
  createdAt: '2026-03-02T10:00:00.000Z',
  updatedAt: '2026-03-02T10:00:00.000Z',
  sightings: [
    { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] } },
  ],
  measurements: [{ kind: 'area', value: 0.4, unit: 'm2' }],
  source: 'human',
  capture: 'capture-1',
};

test.describe('project list: groups and category order', () => {
  test('a telecom project lists Antennas, Sectors, Coverage plan, Measurements, Issues in that order', async ({
    win,
    dataRoot,
  }) => {
    await writeRfProject(dataRoot.projectDir, { cloud: true });
    await setPurpose(dataRoot.projectDir, 'telecom');
    await openTiny(win);
    const { order, open } = await groups(win);
    expect(order).toEqual(['Antennas', 'Sectors', 'Coverage plan', 'Measurements', 'Issues']);
    // only the first group starts open; the others wait folded behind their counts
    expect(open).toEqual(['Antennas']);
    await evidence(win, 'a-telecom-order', true);
  });

  test.describe('with the pipeline', () => {
    test.use({ appEnv: PIPELINE_ENV });
    test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

    test('a survey project lists Measurements then Issues, and Antennas appears at the end once detected', async ({
      win,
      dataRoot,
    }) => {
      test.setTimeout(300_000);
      await writeTelecomTower(dataRoot.projectDir);
      await setPurpose(dataRoot.projectDir, 'survey');
      await openTiny(win);
      const before = await groups(win);
      expect(before.order).toEqual(['Measurements', 'Issues']);
      expect(before.open).toEqual(['Measurements']);

      await measureControl(win, 'telecom-tool-clearance');
      const detect = win.getByTestId('detect-antennas');
      await expect(detect).toBeEnabled({ timeout: 60_000 });
      await detect.click();
      await expect
        .poll(async () => (await groups(win)).order, { timeout: 180_000 })
        .toEqual(['Measurements', 'Issues', 'Antennas']);
      await evidence(win, 'b-survey-order', true);
    });
  });

  test('a measurement picked in the left tree is the selected row in Measurements with its panel inline', async ({
    win,
    dataRoot,
  }) => {
    const dir = dataRoot.projectDir;
    await mkdir(join(dir, 'survey'), { recursive: true });
    await writeFile(join(dir, 'survey', 'measurements.json'), JSON.stringify(SEED, null, 1));
    await openTiny(win);
    await measureTree(win);
    await selectMeasure(win, 'Line B');
    const side = win.getByTestId('project-measurements');
    const row = side.getByTestId('project-measurement-row').filter({ hasText: 'Line B' });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-current', 'true');
    // the one panel for the measurement sits under its row, not in a card of the bench
    const panel = side.getByTestId('survey-side');
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(win.locator('.right #wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
    await expect(
      side.getByTestId('project-measurement-row').filter({ hasText: 'Spot C' }),
    ).not.toHaveAttribute('aria-current', 'true');
    await evidence(win, 'c-measurement-inline');

    // another pick moves the panel with it
    await selectMeasure(win, 'Spot C');
    await expect(
      side.getByTestId('project-measurement-row').filter({ hasText: 'Spot C' }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(panel).toHaveCount(1);
  });

  test('an issue row opens its card in Selection', async ({ win, dataRoot }) => {
    await writeFile(
      join(dataRoot.projectDir, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [ISSUE] }),
    );
    await openTiny(win);
    await groups(win);
    const section = await openGroup(win, 'issues');
    await expect(section.locator('.wb-section-count')).toHaveText('1');
    await section.getByTestId('project-issue-row').click();
    await expect(win.locator('.right #wb-tab-selection')).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByTestId('issue-card')).toHaveAttribute('data-issue', ISSUE.id);
    await evidence(win, 'd-issue-opened');
  });

  test('a saved sector shows its bearing and opens in Coverage', async ({ win, dataRoot }) => {
    const dir = dataRoot.projectDir;
    await writeRfProject(dir, { cloud: true });
    await setPurpose(dir, 'telecom');
    await mkdir(join(dir, 'rf'), { recursive: true });
    await writeFile(
      join(dir, 'rf', 'sectors.json'),
      JSON.stringify(
        RfSectorsFile.parse({
          schema: 'aio.rf-sectors/1',
          sectors: [{ id: 'sec-alpha', name: 'Alpha', antennaIds: ['ant-p2'] }],
          antennas: [],
          study: {},
        }),
      ),
    );
    await openTiny(win);
    await groups(win);
    const section = await openGroup(win, 'sectors');
    await expect(section.locator('.wb-section-count')).toHaveText('1');
    const row = section.getByRole('listitem').filter({ hasText: 'Alpha' });
    // the unit's azimuth, 120 degrees, is the sector's bearing
    await expect(row).toContainText('120°');
    await expect(row).toContainText('1 antenna');
    await evidence(win, 'e-sector-row', true);
    // the row's actions show when it is pointed at
    await row.hover();
    await row.getByRole('button', { name: 'Open in Coverage' }).click();
    await expect(win.locator('.right #wb-tab-rf')).toHaveAttribute('aria-selected', 'true');
  });

  test('the new project wizard offers Telecom towers', async ({ win }) => {
    await win.getByTestId('new-project').first().click();
    const wiz = win.getByTestId('new-project-wizard');
    const cards = wiz.getByRole('group', { name: 'Project type' }).getByRole('button');
    await expect(cards.filter({ hasText: /^Telecom towers/ })).toHaveCount(1);
    await cards.filter({ hasText: /^Telecom towers/ }).click();
    await expect(
      wiz.getByRole('group', { name: 'Project type' }).locator('[aria-pressed="true"] b'),
    ).toHaveText('Telecom towers');
    await evidence(win, 'f-wizard-telecom');
  });
});
