/**
 * RF coverage in the real app, end to end: a project with a CRS and a synthetic antenna inventory
 * (three accepted panels, one draft, no `rf/` folder, `rfFixtures.ts`), the Coverage... project
 * action, the Coverage tab (the AI card, three steps and a folded Advanced), the real
 * `rf.coverage` pipeline job in the development venv (as the antenna
 * detection spec runs its job), the live preview, a second run, a GeoTIFF export and a reload.
 * The classes are checked in the RF tab's class table, the Display bench's Coverage group and the
 * compact coverage legend in its stage corner (ruling I3, bottom left first), which keeps clear
 * of the readout, the volumes hint, the island and the Map menu chip.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_ENV, expect, hasPipelinePython, test, tinyManifest } from './fixtures';
import { stageMode } from './island';
import { RF_DRAFT, RF_PANELS, RF_SITE, readRfSectors, writeRfProject } from './rfFixtures';

interface Hooks {
  __stratlas: {
    workbench: { getState(): { open(id: string): void } };
    antennas: { setState(patch: Record<string, unknown>): void };
    stage(): {
      scene: { getObjectByName(n: string): { visible: boolean } | undefined };
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
    } | null;
  };
}

// a small window: the map beside the RF tab is narrow, so its "No map pack installed" note goes
// above the scale bar and the credits, up into the legend's corner, and the legend must keep clear
test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x720' } });
test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

const TINY_ORIGIN = tinyManifest().origin;
/** The generic n78 AAU (ruling R16): no generic panel or RRU in the catalogue covers 3.5 GHz. */
const AAU = 'generic-aau-64t64r-n78';
const AAU_NAME = /AAU 64T64R 3\.5 GHz 200 W/;
const CLASS_NAMES = ['Excellent', 'Good', 'Fair', 'Poor', 'No service'];
const CLASS_KEYS = ['excellent', 'good', 'fair', 'poor', 'none'];
/** Each class's whole range, as a screen reader reads its legend row (the default thresholds). */
const CLASS_RANGES = [
  'above -80 dBm',
  '-80 to -95 dBm',
  '-95 to -105 dBm',
  '-105 to -115 dBm',
  'below -115 dBm',
];

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `task-12-${name}.png`) });
}

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/**
 * Step 1 (ruling R7): the project menu's Coverage... opens the RF tab. The action shows once the
 * RF store has read the inventory, so the menu is opened again until it is there.
 */
async function openRfFromProjectMenu(win: Page): Promise<Locator> {
  const item = win.getByTestId('ctx-menu').getByTestId('ctx-item-rf.coverage');
  await expect(async () => {
    if (!(await win.getByTestId('ctx-menu').isVisible()))
      await win.locator('.sb-tree .tree-h .caps').click({ button: 'right' });
    if (!(await item.isVisible())) {
      await win.keyboard.press('Escape');
      throw new Error('Coverage... is not in the project menu yet');
    }
  }).toPass({ timeout: 30_000 });
  await expect(item).toHaveText(/Coverage\.\.\./);
  await item.click();
  const bench = win.locator('.rf-bench');
  await expect(bench).toBeVisible();
  return bench;
}

const workbench = (win: Page, tab: string) =>
  win.evaluate((id) => {
    (window as unknown as Hooks).__stratlas.workbench.getState().open(id);
  }, tab);

/** Pick a catalogue entry in the picker the button opens. */
async function pick(win: Page, opener: Locator, entryId: string): Promise<void> {
  await opener.click();
  const dialog = win.getByTestId('rf-catalogue');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`rf-cat-${entryId}`).click();
  await dialog.getByTestId('rf-cat-use').click();
  await expect(dialog).toBeHidden();
}

/** Advanced, unfolded (it folds by default and remembers a hand toggle). */
async function openAdvanced(bench: Locator): Promise<Locator> {
  const head = bench.getByTestId('rf-advanced');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  return bench.getByTestId('rf-study');
}

/** The class table as text, one "name|range|area|share" line per class. */
const classTable = (bench: Locator) =>
  bench
    .getByTestId('rf-classes')
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent.trim()).join('|')),
    );

/** The finished runs on disk (`rf/runs/<id>/run.json`, status done), oldest first. */
async function doneRuns(projectDir: string): Promise<string[]> {
  const dir = join(projectDir, 'rf', 'runs');
  const ids = await readdir(dir).catch(() => [] as string[]);
  const done: { id: string; at: string }[] = [];
  for (const id of ids) {
    const run = (await readFile(join(dir, id, 'run.json'), 'utf8')
      .then((s) => JSON.parse(s) as { status?: string; createdAt?: string })
      .catch(() => null)) ?? { status: undefined };
    if (run.status === 'failed') throw new Error(`rf.coverage run ${id} failed`);
    if (run.status === 'done') done.push({ id, at: run.createdAt ?? '' });
  }
  return done.sort((a, b) => a.at.localeCompare(b.at)).map((d) => d.id);
}

const mapHasCoverage = (win: Page) =>
  win.evaluate(() =>
    [...document.querySelectorAll('*')].some((el) => {
      const map = (el as Element & { __aioMap?: { getLayer(id: string): unknown } }).__aioMap;
      const layer = map?.getLayer('aio-rf-coverage');
      return layer !== undefined && layer !== null;
    }),
  );

const sceneCoverageVisible = (win: Page) =>
  win.evaluate(
    () =>
      (window as unknown as Hooks).__stratlas.stage()?.scene.getObjectByName('rf-coverage')
        ?.visible ?? false,
  );

/** Look down on the whole study from above the tower (local frame: east is x, north is -z). */
async function viewSiteFromAbove(win: Page): Promise<void> {
  const [x, z] = [RF_SITE.east - TINY_ORIGIN[0], -(RF_SITE.north - TINY_ORIGIN[1])];
  await win.evaluate(
    ([px, pz]) => {
      (window as unknown as Hooks).__stratlas
        .stage()
        ?.restoreView({ position: [px, 1900, pz + 900], target: [px, 0, pz] }, false);
    },
    [x, z] as const,
  );
}

/**
 * What the coverage legend covers on the stage: the coordinates readout, the volumes hint, the
 * island, the map's "No map pack installed" note, the antennas' Labels control and card, and any
 * other corner overlay, by name (none when it keeps clear of them all).
 */
const legendCovers = (win: Page, card = 'rf-legend') =>
  win.evaluate((id) => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 ? r : null;
    };
    const legend = box(document.querySelector(`[data-testid="${id}"]`));
    if (!legend) return ['no legend'];
    const others: [string, Element | null][] = [
      ['readout', document.querySelector('.pane-3d:not(.is-hidden) .cursor-ro')],
      ['volumes hint', document.querySelector('[data-testid="vol-hint"]')],
      ['island', document.querySelector('[role="toolbar"][aria-label="Stage tools"]')],
      ['map note', document.querySelector('[data-testid="map-no-packs"]')],
      ['antenna labels', document.querySelector('[data-testid="antenna-labels-control"]')],
      ['antenna card', document.querySelector('[data-testid="antenna-card"]')],
      ...[...document.querySelectorAll('.stage-slot')]
        .filter((s) => !s.querySelector(`[data-testid="${id}"]`))
        .map((s): [string, Element] => [`slot ${(s as HTMLElement).dataset.slot ?? ''}`, s]),
    ];
    return others
      .filter(([, el]) => {
        const b = box(el);
        return (
          b !== null &&
          legend.left < b.right &&
          b.left < legend.right &&
          legend.top < b.bottom &&
          b.top < legend.bottom
        );
      })
      .map(([name]) => name);
  }, card);

async function stubSaveDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

test('coverage from the project menu: run, preview, new run, GeoTIFF, reopen', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(420_000);
  await writeRfProject(dataRoot.projectDir);
  await openTiny(win);

  // 0. the Coverage chip (spec F1 revised): with antennas and no run it heads a card of its own
  // in the legend's corner, clear of the readout, the island, the map note and the other corners
  const card = win.getByTestId('rf-card');
  await expect(card.getByTestId('rf-chip')).toHaveAttribute('data-state', 'not-planned', {
    timeout: 30_000,
  });
  await expect.poll(() => legendCovers(win, 'rf-card')).toEqual([]);

  // 1. the Coverage tab, from the project menu's Coverage...: the AI card, three steps, Advanced
  let bench = await openRfFromProjectMenu(win);
  await expect(win.locator('#wb-tab-rf')).toContainText('Coverage');
  await expect(bench.getByTestId('rf-ai-card')).toBeVisible();
  await expect(bench.getByTestId('rf-step-antennas')).toContainText('3 accepted · 1 draft');
  await expect(bench.locator('.rf-step-title')).toHaveText([
    'Antennas',
    'Sectors & equipment',
    'Coverage',
  ]);
  await expect(bench.getByTestId('rf-advanced')).toHaveAttribute('aria-expanded', 'false');
  await expect(bench.getByTestId('rf-sectors')).toContainText('No sectors');
  await evidence(win, 'coverage-panel');

  // 2. three sectors by bearing (the draft panel stays out), each the generic n78 AAU on n78
  await bench
    .getByTestId('rf-sectors')
    .getByRole('button', { name: 'Group by bearing', exact: true })
    .click();
  const rows = bench.locator('[data-testid^="rf-step-sector-sec-"]');
  await expect(rows).toHaveCount(3);
  // nothing picked yet: every sector needs setup
  for (let i = 0; i < 3; i++) await expect(rows.nth(i)).toHaveAttribute('data-tag', 'needs-setup');
  /** Open a step 2 row (one is open at a time); a row already open stays open. */
  const openRow = async (i: number) => {
    const head = rows.nth(i).locator('.rf-step-row-head');
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
  };
  for (let i = 0; i < 3; i++) {
    await openRow(i);
    const unit = bench.locator('[data-testid^="rf-unit-"]');
    await expect(unit).toHaveAttribute('data-testid', `rf-unit-${RF_PANELS[i] ?? ''}`);
    // no carrier yet, so the picker has no band filter and lists the AAU before n78 is chosen
    await pick(win, unit.getByTestId('rf-pick-aau'), AAU);
    await expect(unit.getByTestId('rf-pick-aau')).toHaveText(AAU_NAME);
    // an AAU has its antenna and radio built in
    for (const id of ['rf-pick-antenna', 'rf-pick-radio']) {
      await expect(unit.getByTestId(id)).toContainText('Built into the AAU');
      await expect(unit.getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
    }
    await unit.getByTestId('rf-band').selectOption('n78');
    await expect(unit.getByRole('button', { name: 'NR', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await unit.getByRole('combobox', { name: 'Carrier bandwidth' }).selectOption('100');
    await expect(unit.getByRole('combobox', { name: 'Carrier bandwidth' })).toHaveValue('100');
    await expect(unit.getByTestId('rf-excluded')).toHaveCount(0);
    // set by hand, so the row says edited, with its equipment and band
    await expect(rows.nth(i)).toHaveAttribute('data-tag', 'edited');
    await expect(rows.nth(i)).toContainText('n78 · 100 MHz');
  }
  // fold the last row so the shot shows the three rows and their tags
  await rows.nth(2).locator('.rf-step-row-head').click();
  await expect(bench.locator('[data-testid^="rf-unit-"]')).toHaveCount(0);
  await bench.getByTestId('rf-step-sectors').scrollIntoViewIfNeeded();
  await evidence(win, 'coverage-panel-set-up');
  // a smaller study keeps the job short: 1 km at 20 m
  const study = await openAdvanced(bench);
  await study.getByRole('spinbutton', { name: 'Radius', exact: true }).fill('1000');
  await study.getByRole('spinbutton', { name: 'Radius', exact: true }).press('Enter');
  await study.getByRole('spinbutton', { name: 'Grid', exact: true }).fill('20');
  await study.getByRole('spinbutton', { name: 'Grid', exact: true }).press('Enter');
  await expect(bench.getByTestId('rf-participants')).toHaveText('3 antennas take part in a run.');

  // 3. run coverage (saved first, then the real rf.coverage job) and wait for it
  const run = bench.getByTestId('rf-run');
  await expect(run).toBeEnabled({ timeout: 60_000 });
  await run.click();
  await expect.poll(() => doneRuns(dataRoot.projectDir), { timeout: 240_000 }).toHaveLength(1);
  const saved = await readRfSectors(dataRoot.projectDir);
  expect(saved?.sectors.flatMap((s) => s.antennaIds).sort()).toEqual([...RF_PANELS]);
  expect(saved?.sectors.flatMap((s) => s.antennaIds)).not.toContain(RF_DRAFT);
  expect(saved?.study).toMatchObject({ radiusM: 1000, gridResolutionM: 20 });
  expect(saved?.antennas).toHaveLength(3);
  for (const a of saved?.antennas ?? []) {
    expect(a).toMatchObject({
      equipment: { kind: 'aau', aau: AAU },
      carriers: [{ tech: 'nr', band: 'n78', bandwidthMhz: 100 }],
    });
    // an AAU's carrier names no radio port
    expect(a.carriers[0]?.port).toBeUndefined();
  }
  await expect(run).toHaveText('Run coverage', { timeout: 30_000 });

  // 4. the classes of the run: every class has an area and the shares add up to the whole study
  await expect
    .poll(async () => (await classTable(bench)).every((r) => r.includes('km²')), {
      timeout: 60_000,
    })
    .toBe(true);
  const afterRun = await classTable(bench);
  expect(afterRun.map((r) => r.split('|')[0])).toEqual(CLASS_NAMES);
  const shares = afterRun.map((r) => Number(/(\d+)%$/.exec(r)?.[1] ?? NaN));
  expect(shares.every(Number.isFinite)).toBe(true);
  expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(3);
  // the AAU's 53 dBm in all (200 W) on n78 serves most of the 1 km study
  const areas = afterRun.map((r) => Number(/\|([\d.]+) km²\|/.exec(r)?.[1] ?? NaN));
  const served = areas.slice(0, 4).reduce((a, b) => a + b, 0);
  expect(served, 'some of the study has service').toBeGreaterThan(0);
  await evidence(win, 'rf-tab-after-run');

  // the run is drawn in the 3D view and on the map
  await expect.poll(() => sceneCoverageVisible(win), { timeout: 30_000 }).toBe(true);
  await viewSiteFromAbove(win);
  // the compact legend in its stage corner: every class on one line with its whole range for a
  // screen reader, clear of the readout, the hint, the island and the Map menu chip
  const legend = win.getByTestId('rf-legend');
  await expect(legend).toBeVisible();
  await expect(legend.locator('.rf-legend-row')).toHaveCount(CLASS_KEYS.length);
  for (const [i, c] of CLASS_KEYS.entries()) {
    const row = legend.getByTestId(`rf-legend-${c}`);
    await expect(row).toBeVisible();
    await expect(row.locator('.sr-only')).toContainText(CLASS_RANGES[i] ?? '');
    // a range never wraps: the row is one line
    expect((await row.boundingBox())?.height ?? 99).toBeLessThan(22);
  }
  expect((await legend.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(150);
  await expect(legend.getByTestId('rf-legend-details')).not.toHaveAttribute('open', '');
  await expect.poll(() => legendCovers(win)).toEqual([]);
  // at the foot of the start: the readout at the foot of the end stays shown
  await expect(win.locator('.pane-3d:not(.is-hidden) .cursor-ro')).toBeVisible();
  await evidence(win, 'coverage-in-3d');
  await stageMode(win, 'Map');
  await expect.poll(() => mapHasCoverage(win), { timeout: 60_000 }).toBe(true);
  await expect(legend).toBeVisible();
  await expect.poll(() => legendCovers(win)).toEqual([]);
  await evidence(win, 'coverage-on-map');
  // Details opens the controls and the assumptions, still clear of the other overlays
  await legend.getByTestId('rf-legend-details').locator('summary').click();
  await expect(legend.getByTestId('rf-legend-opacity')).toBeVisible();
  await expect(legend.getByTestId('rf-legend-indicative')).toContainText('Indicative');
  await expect.poll(() => legendCovers(win)).toEqual([]);
  await evidence(win, 'legend-details');
  await legend.getByTestId('rf-legend-details').locator('summary').click();
  await expect(legend.getByTestId('rf-legend-opacity')).toBeHidden();
  await stageMode(win, '3D');

  // the Display bench's Coverage group says what is drawn
  await workbench(win, 'display');
  await expect(win.getByTestId('display-coverage')).toBeVisible();
  await expect(win.getByTestId('display-coverage-what')).toHaveText('Chosen run, RSRP');
  await expect(win.getByTestId('display-coverage-eye')).toHaveAttribute('aria-pressed', 'true');
  await evidence(win, 'display-coverage-group');

  // 5. a sector's e-tilt moves and the live preview answers with other class areas
  await workbench(win, 'rf');
  bench = win.locator('.rf-bench');
  await expect(bench).toBeVisible();
  await openRow(0);
  const tilt = bench.getByTestId('rf-etilt-number');
  await expect(tilt).toHaveValue('0');
  await tilt.fill('10');
  await tilt.press('Enter');
  await expect(bench.getByTestId('rf-etilt')).toHaveValue('10');
  await expect(bench.getByRole('status').filter({ hasText: 'not saved yet' })).toBeVisible();
  // one poll on both: the table changed from the run's, and every class has an area again
  await expect
    .poll(
      async () => {
        const rows = await classTable(bench);
        return rows.join('\n') !== afterRun.join('\n') && rows.every((r) => r.includes('km²'));
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const preview = await classTable(bench);
  await bench.getByTestId('rf-classes').scrollIntoViewIfNeeded();
  await evidence(win, 'rf-tab-preview');
  await workbench(win, 'display');
  await expect(win.getByTestId('display-coverage-what')).toHaveText('Live preview, RSRP');
  await workbench(win, 'rf');
  bench = win.locator('.rf-bench');

  // 6. save as a new run: the edit is saved, a second run is made and chosen
  const saveAsRun = bench.getByRole('button', { name: 'Save as new run', exact: true });
  await expect(saveAsRun).toBeEnabled({ timeout: 60_000 });
  await saveAsRun.click();
  await expect.poll(() => doneRuns(dataRoot.projectDir), { timeout: 240_000 }).toHaveLength(2);
  const [firstRun, secondRun] = await doneRuns(dataRoot.projectDir);
  expect((await readRfSectors(dataRoot.projectDir))?.antennas[0]?.etiltDeg).toBe(10);
  const runPick = bench.getByRole('combobox', { name: 'Run', exact: true });
  await expect(runPick).toHaveValue(secondRun ?? '', { timeout: 30_000 });
  await expect(bench.getByRole('status').filter({ hasText: 'not saved yet' })).toHaveCount(0);
  await expect
    .poll(async () => (await classTable(bench)).join('\n'), { timeout: 60_000 })
    .toBe(preview.join('\n'));

  // 7. export the chosen run's RSRP grid as a GeoTIFF
  const target = join(dataRoot.base, 'coverage-export.tif');
  await stubSaveDialog(app, target);
  await bench.getByRole('button', { name: 'Export', exact: true }).click();
  await win.getByRole('menuitem', { name: 'GeoTIFF of the grid' }).click();
  await expect(bench.getByRole('status').filter({ hasText: 'Exported to' })).toContainText(target);
  expect((await stat(target)).size).toBeGreaterThan(1000);
  const magic = (await readFile(target)).subarray(0, 4).toString('latin1');
  expect(['II*\0', 'MM\0*', 'II+\0', 'MM\0+']).toContain(magic);

  // 8. reopen the project: the settings and both runs are still there
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
  bench = await openRfFromProjectMenu(win);
  await expect(rows).toHaveCount(3);
  const reopened = await openAdvanced(bench);
  await expect(reopened.getByRole('spinbutton', { name: 'Radius', exact: true })).toHaveValue(
    '1000',
  );
  await expect(reopened.getByRole('spinbutton', { name: 'Grid', exact: true })).toHaveValue('20');
  await openRow(0);
  const unit = bench.getByTestId(`rf-unit-${RF_PANELS[0]}`);
  await expect(unit.getByTestId('rf-pick-aau')).toHaveText(AAU_NAME);
  await expect(unit.getByTestId('rf-pick-antenna')).toContainText('Built into the AAU');
  await expect(unit.getByTestId('rf-band')).toHaveValue('n78');
  await expect(unit.getByRole('combobox', { name: 'Carrier bandwidth' })).toHaveValue('100');
  await expect(unit.getByTestId('rf-etilt-number')).toHaveValue('10');
  await openRow(1);
  await expect(
    bench.getByTestId(`rf-unit-${RF_PANELS[1]}`).getByTestId('rf-etilt-number'),
  ).toHaveValue('0');
  await expect(runPick.locator('option')).toHaveCount(3);
  await expect(runPick.locator(`option[value="${firstRun ?? ''}"]`)).toHaveCount(1);
  await expect(bench.getByRole('status').filter({ hasText: 'not saved yet' })).toHaveCount(0);
});

/**
 * Whether the coverage card (the prompt or the legend), when shown, overlaps the antennas' Labels
 * control or the selected unit's floating card, by name (none when it keeps clear or is hidden).
 */
const antennaClash = (win: Page) =>
  win.evaluate(() => {
    const shown = (el: Element | null) => {
      if (!el || getComputedStyle(el).visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const card = shown(
      document.querySelector('[data-testid="rf-legend"], [data-testid="rf-card"]'),
    );
    if (!card) return [];
    return (
      [
        ['antenna labels', '[data-testid="antenna-labels-control"]'],
        ['antenna card', '[data-testid="antenna-card"]'],
      ] as const
    )
      .filter(([, sel]) => {
        const b = shown(document.querySelector(sel));
        return (
          b !== null &&
          card.left < b.right &&
          b.left < card.right &&
          card.top < b.bottom &&
          b.top < card.bottom
        );
      })
      .map(([name]) => name);
  });

/** Wait until the box stops moving (the camera's fly to a selected unit has settled). */
async function settled(box: Locator): Promise<void> {
  let last = '';
  await expect
    .poll(
      async () => {
        const b = JSON.stringify(await box.boundingBox());
        const same = b === last;
        last = b;
        return same;
      },
      { intervals: [300] },
    )
    .toBe(true);
}

const selectUnit = (win: Page, id: string | null) =>
  win.evaluate((unit) => {
    (window as unknown as Hooks).__stratlas.antennas.setState({ selected: unit });
  }, id);

/**
 * The coverage card shares the stage's foot with the antenna inventory drawn in 3D (its Labels
 * control at the bottom left) and a selected unit's card: before a run the card is only a prompt
 * and gives its corner up while the antenna card is over it; after one the legend keeps its
 * corner, above the Labels control, and steps aside in place while the antenna card is over it.
 */
for (const size of ['1100x720', '1440x900']) {
  test.describe(`at ${size}`, () => {
    test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: size } });

    test('the coverage card and the antenna card share the stage', async ({ win, dataRoot }) => {
      test.setTimeout(300_000);
      const shot = (name: string) => evidence(win, `antennas-${name}-${size}`);
      await writeRfProject(dataRoot.projectDir, { cloud: true });
      await openTiny(win);
      const labels = win.getByTestId('antenna-labels-control');
      await expect(labels).toBeVisible({ timeout: 30_000 });
      const bench = await openRfFromProjectMenu(win);
      await viewSiteFromAbove(win);

      // before a run: the prompt keeps clear of the Labels control and the other overlays
      const card = win.getByTestId('rf-card');
      await expect(card.getByTestId('rf-chip')).toHaveAttribute('data-state', 'not-planned', {
        timeout: 30_000,
      });
      await expect.poll(() => legendCovers(win, 'rf-card')).toEqual([]);
      await shot('before-run');
      // a selected unit's card: the prompt gives its corner up wherever the card is over it
      const unitCard = win.getByTestId('antenna-card');
      for (const id of [...RF_PANELS, RF_DRAFT]) {
        await selectUnit(win, id);
        await expect(unitCard).toBeVisible();
        await settled(unitCard);
        await expect.poll(() => antennaClash(win)).toEqual([]);
        if (id === RF_PANELS[0] || id === RF_DRAFT) await shot(`before-run-card-${id}`);
      }
      await selectUnit(win, null);
      await expect(unitCard).toHaveCount(0);
      await expect(card).toBeVisible();

      // a quick run: a small study, the rules' plan, Apply & run
      const head = bench.getByTestId('rf-advanced');
      if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
      const study = bench.getByTestId('rf-study');
      for (const [name, value] of [
        ['Radius', '1000'],
        ['Grid', '20'],
      ] as const) {
        await study.getByRole('spinbutton', { name, exact: true }).fill(value);
        await study.getByRole('spinbutton', { name, exact: true }).press('Enter');
      }
      await card.getByTestId('rf-chip-autoplan').click();
      const dlg = win.getByTestId('rf-autoplan');
      await expect(dlg).toHaveAttribute('data-phase', 'review');
      await dlg.getByTestId('rf-autoplan-apply-run').click();
      await expect(dlg).toBeHidden();
      await expect.poll(() => doneRuns(dataRoot.projectDir), { timeout: 240_000 }).toHaveLength(1);

      // after it: the legend keeps its corner, clear of the Labels control and the overlays
      const legend = win.getByTestId('rf-legend');
      await expect(legend).toBeVisible({ timeout: 60_000 });
      await viewSiteFromAbove(win);
      await expect.poll(() => legendCovers(win)).toEqual([]);
      await shot('after-run');
      // and of a selected unit's card, wherever the card stands
      for (const id of [...RF_PANELS, RF_DRAFT]) {
        await selectUnit(win, id);
        await expect(unitCard).toBeVisible();
        await settled(unitCard);
        await expect.poll(() => antennaClash(win)).toEqual([]);
        if (id === RF_PANELS[0] || id === RF_DRAFT) await shot(`after-run-card-${id}`);
      }
      await selectUnit(win, null);
      await expect(legend).toBeVisible();
    });
  });
}
