/**
 * Auto-plan RF coverage in the real app, end to end, from the Coverage panel's AI card (the
 * project menu's Coverage... opens the panel). The project is the RF fixture (`rfFixtures.ts`:
 * three accepted panels, one draft, no `rf/` folder).
 *
 * - Rules only: no AI provider is set up, so the review dialog plans with the rules. Three rows,
 *   the draft listed as left out; Apply & run saves, runs the real `rf.coverage` job in the
 *   development venv and the class table fills; every step 2 row is tagged `rules`.
 * - A local model (the fake server on 127.0.0.1, OpenAI-compatible): it answers two valid picks
 *   and one with an entry the catalogue lacks. The review shows that row at low confidence with
 *   why; Apply only leaves the changes unsaved; step 2 tags the rows `ai` and `ai-low`.
 * - No accepted antenna: Auto-plan stops at "Review antennas first", and Review antennas opens
 *   the Measure bench.
 *
 * The rules flow starts from the coverage card's ✦ Auto-plan in the stage's legend corner (the
 * chip, `CoverageChip.tsx`), the other two from the panel's AI card; the card's state is checked
 * in each. On a narrow stage (the CI window) the card drops its words, so the share after a run is
 * read from the panel's status line there.
 */
import { offlineRoutes } from '@aio/ai/routes';
import type { Locator, Page } from '@playwright/test';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RF_FAKE_PICK, RF_UNKNOWN_ENTRY, startFakeLlm } from './fake-llm';
import {
  createDataRoot,
  expect,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  PIPELINE_ENV,
  test,
} from './fixtures';
import { stageMode } from './island';
import { RF_DRAFT, RF_PANELS, readRfSectors, writeRfProject } from './rfFixtures';

test.use({ appEnv: PIPELINE_ENV });

const PANEL = RF_FAKE_PICK.entryId;
const RADIO = RF_FAKE_PICK.radioId;
const FAKE_MODEL = 'fake-rf';

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them. The window size is in the name.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
  await win.screenshot({
    path: join(EVIDENCE, `task-12-autoplan-${name}-${String(w)}x${String(h)}.png`),
  });
}

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/** The project menu's Coverage... (shown once the RF store has read the inventory). */
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
  await item.click();
  const bench = win.locator('.rf-bench');
  await expect(bench).toBeVisible();
  return bench;
}

/** The finished runs on disk (`rf/runs/<id>/run.json`, status done). */
async function doneRuns(projectDir: string): Promise<string[]> {
  const dir = join(projectDir, 'rf', 'runs');
  const ids = await readdir(dir).catch(() => [] as string[]);
  const done: string[] = [];
  for (const id of ids) {
    const run = await readFile(join(dir, id, 'run.json'), 'utf8')
      .then((s) => JSON.parse(s) as { status?: string })
      .catch(() => null);
    if (run?.status === 'failed') throw new Error(`rf.coverage run ${id} failed`);
    if (run?.status === 'done') done.push(id);
  }
  return done;
}

/** The class table as text, one "name|range|area|share" line per class. */
const classTable = (bench: Locator) =>
  bench
    .getByTestId('rf-classes')
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent.trim()).join('|')),
    );

const mapHasCoverage = (win: Page) =>
  win.evaluate(() =>
    [...document.querySelectorAll('*')].some((el) => {
      const map = (el as Element & { __aioMap?: { getLayer(id: string): unknown } }).__aioMap;
      const layer = map?.getLayer('aio-rf-coverage');
      return layer !== undefined && layer !== null;
    }),
  );

/** The step 2 sector rows. */
const sectorRows = (bench: Locator) => bench.locator('[data-testid^="rf-step-sector-sec-"]');

/** The data-tag of every step 2 sector row, sorted. */
const sectorTags = (bench: Locator) =>
  sectorRows(bench).evaluateAll((rows) =>
    rows.map((r) => (r as HTMLElement).dataset.tag ?? '').sort(),
  );

/** The coverage card's header in the stage corner. */
const stageChip = (win: Page) => win.getByTestId('rf-chip');

test('Auto-plan with the rules from the coverage card: review, Apply & run, coverage', async ({
  win,
  dataRoot,
}) => {
  test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');
  test.setTimeout(360_000);
  await writeRfProject(dataRoot.projectDir);
  await openTiny(win);
  const bench = await openRfFromProjectMenu(win);
  await expect(bench.getByTestId('rf-step-sectors')).toContainText('No sectors');
  await evidence(win, 'panel-before');

  // a smaller study keeps the job short (study settings are not part of the plan)
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
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  // the coverage card in the stage corner: three accepted antennas, not planned yet
  const chip = stageChip(win);
  await expect(chip).toHaveAttribute('data-state', 'not-planned');
  await expect(chip.getByTestId('rf-chip-open')).toHaveAccessibleName(
    'Coverage · 3 antennas · not planned',
  );
  if ((await chip.getAttribute('data-narrow')) === null)
    await expect(chip).toContainText('3 antennas · not planned');
  await expect(win.getByTestId('rf-chip-panel')).toContainText('3 antennas · not planned');
  await expect(bench.getByTestId('rf-ai-card').getByTestId('rf-ai-autoplan')).toHaveText(
    /Auto-plan & run/,
  );
  await evidence(win, 'chip-not-planned');

  // the card's ✦ Auto-plan opens the review; no provider is set up, so Rules only
  await chip.getByTestId('rf-chip-autoplan').click();
  const dlg = win.getByTestId('rf-autoplan');
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute('data-phase', 'review');
  const source = dlg.getByTestId('rf-autoplan-source');
  await expect(source.getByTestId('rf-autoplan-source-rules')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(source.getByTestId('rf-autoplan-source-rules')).toHaveText('Rules only');
  await expect(source.getByTestId('rf-autoplan-source-ai')).toBeDisabled();

  // one row per accepted panel, in its own sector; the draft is left out
  const rows = dlg.locator('[data-testid^="rf-autoplan-row-"]');
  await expect(rows).toHaveCount(3);
  for (const [i, id] of RF_PANELS.entries()) {
    const row = dlg.getByTestId(`rf-autoplan-row-${id}`);
    await expect(row).toContainText(`S${String(i + 1)}`);
    await expect(row).toContainText(`P${String(i + 1)}`);
    await expect(row).toContainText('B3');
    await expect(row).toContainText('panel and radio on B3');
    await expect(row).not.toHaveAttribute('data-confidence', 'low');
  }
  await expect(dlg.getByTestId(`rf-autoplan-left-${RF_DRAFT}`)).toBeVisible();
  await expect(dlg.getByTestId(`rf-autoplan-left-${RF_DRAFT}`)).toContainText('P4');
  await evidence(win, 'review-rules');

  // Apply & run: saved, then the real rf.coverage job
  await dlg.getByTestId('rf-autoplan-apply-run').click();
  await expect(dlg).toBeHidden();
  await expect.poll(() => doneRuns(dataRoot.projectDir), { timeout: 240_000 }).toHaveLength(1);
  const saved = await readRfSectors(dataRoot.projectDir);
  expect(saved?.sectors).toHaveLength(3);
  expect(saved?.sectors.flatMap((s) => s.antennaIds).sort()).toEqual([...RF_PANELS]);
  expect(saved?.study).toMatchObject({ radiusM: 1000, gridResolutionM: 20 });
  expect(saved?.antennas).toHaveLength(3);
  for (const a of saved?.antennas ?? []) {
    expect(a).toMatchObject({
      equipment: { kind: 'separate', antenna: PANEL, radio: RADIO },
      origins: { equipment: { by: 'rules' } },
      carriers: [{ tech: 'lte', band: 'B3', bandwidthMhz: 20, origin: { by: 'rules' } }],
    });
  }

  // the classes of the run fill the table, and every step 2 row says the rules set it
  await expect
    .poll(async () => (await classTable(bench)).every((r) => r.includes('km²')), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect(sectorRows(bench)).toHaveCount(3);
  await expect.poll(() => sectorTags(bench)).toEqual(['rules', 'rules', 'rules']);
  await expect(bench.getByRole('status').filter({ hasText: 'not saved yet' })).toHaveCount(0);
  await bench.getByTestId('rf-step-sectors').scrollIntoViewIfNeeded();
  await evidence(win, 'panel-after-rules');
  await bench.getByTestId('rf-classes').scrollIntoViewIfNeeded();
  await evidence(win, 'panel-classes-rules');

  // the card says the result: the view and the share fair or better (in its accessible name
  // always, in its words on a wide stage; the panel's status line always shows them)
  const share = /RSRP · \d+% fair or better/;
  await expect(chip).toHaveAttribute('data-state', 'result', { timeout: 30_000 });
  await expect(chip.getByTestId('rf-chip-open')).toHaveAccessibleName(share);
  if ((await chip.getAttribute('data-narrow')) === null) await expect(chip).toContainText(share);
  else await expect(chip.locator('.rf-chip-desc')).toHaveCount(0);
  await expect(win.getByTestId('rf-chip-panel')).toHaveAttribute('data-state', 'result');
  await expect(win.getByTestId('rf-chip-panel')).toContainText(share);
  await expect(chip.getByTestId('rf-chip-replan')).toBeVisible();
  await evidence(win, 'chip-result');

  // the run is drawn on the map, the card above the legend
  await stageMode(win, 'Map');
  await expect.poll(() => mapHasCoverage(win), { timeout: 60_000 }).toBe(true);
  await expect(win.getByTestId('rf-legend')).toBeVisible();
  await expect(chip).toHaveAttribute('data-state', 'result');
  await evidence(win, 'coverage-on-map');
  await stageMode(win, '3D');
});

test('Auto-plan with a local model: AI picks, a low-confidence row, Apply only', async () => {
  test.setTimeout(180_000);
  const fake = await startFakeLlm({
    kind: 'openai-compatible',
    models: [{ id: FAKE_MODEL, tools: true, vision: false, contextTokens: 8192 }],
  });
  const data = await createDataRoot();
  await writeRfProject(data.projectDir);
  const app = await launchApp(data, { AIO_NETWORK_GUARD_ALLOW: fake.origin });
  const network = new NetworkGuard([fake.origin]);
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    // every task on the local model, as the Offline agent preset sets it
    await win.evaluate(
      ({ baseUrl, routes }) =>
        window.aio.invoke('settings:set', {
          localModel: { enabled: true, baseUrl, model: 'fake-rf' },
          routes,
        }),
      { baseUrl: `${fake.origin}/v1`, routes: offlineRoutes(FAKE_MODEL) },
    );
    await openTiny(win);
    const bench = await openRfFromProjectMenu(win);
    await bench.getByTestId('rf-ai-card').getByTestId('rf-ai-autoplan').click();

    // a local model: no send preview, straight to the review, the AI side of the switch on
    const dlg = win.getByTestId('rf-autoplan');
    await expect(dlg).toHaveAttribute('data-phase', 'review', { timeout: 60_000 });
    await expect(dlg.getByTestId('rf-autoplan-source-ai')).toHaveAttribute('aria-pressed', 'true');
    await expect(dlg.getByTestId('rf-autoplan-source-ai')).toBeEnabled();
    const asked = fake.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((r) => r.model === FAKE_MODEL)).toBe(true);

    // two usable AI picks and one the app could not use: that one is the rules pick at low
    // confidence, and says why
    const rows = dlg.locator('[data-testid^="rf-autoplan-row-"]');
    await expect(rows).toHaveCount(3);
    const low = dlg.locator('[data-testid^="rf-autoplan-row-"][data-confidence="low"]');
    await expect(low).toHaveCount(1);
    await expect(low.locator('.rf-autoplan-why')).toHaveText(/^AI pick not usable/);
    await expect(low).toContainText(RF_UNKNOWN_ENTRY);
    const sure = dlg.locator('[data-testid^="rf-autoplan-row-"]:not([data-confidence="low"])');
    await expect(sure).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(sure.nth(i)).toHaveAttribute('data-confidence', 'high');
      await expect(sure.nth(i)).toContainText('Thin panel face');
    }
    await expect(dlg.getByTestId(`rf-autoplan-left-${RF_DRAFT}`)).toBeVisible();
    await evidence(win, 'review-ai');

    // Apply only: written into the working copy, not saved
    await dlg.getByTestId('rf-autoplan-apply').click();
    await expect(dlg).toBeHidden();
    await expect(
      bench.getByRole('status').filter({ hasText: 'RF settings changed and not saved yet' }),
    ).toBeVisible();
    expect(await readRfSectors(data.projectDir)).toBeNull();
    // every planned sector is set up, so the coverage card offers Run
    await expect(stageChip(win)).toHaveAttribute('data-state', 'ready');
    await expect(stageChip(win).getByTestId('rf-chip-run')).toBeVisible();
    await expect(sectorRows(bench)).toHaveCount(3);
    await bench.getByTestId('rf-step-sectors').scrollIntoViewIfNeeded();
    await evidence(win, 'panel-after-ai');
    expect(await network.outbound(), 'a request left for another machine').toEqual([]);
    // step 2: the two AI picks say AI, the unusable one AI · low (the amber "check this" tag)
    await expect.poll(() => sectorTags(bench)).toEqual(['ai', 'ai', 'ai-low']);
  } finally {
    await app.close();
    await fake.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('no accepted antennas: Auto-plan asks for a review, Review antennas opens Measure', async ({
  win,
  dataRoot,
}) => {
  await writeRfProject(dataRoot.projectDir, { allDraft: true });
  await openTiny(win);
  const bench = await openRfFromProjectMenu(win);
  await expect(bench.getByTestId('rf-step-antennas')).toContainText('0 accepted · 4 drafts');
  // the coverage card: nothing reviewed, so its action is Review antennas
  const chip = stageChip(win);
  await expect(chip).toHaveAttribute('data-state', 'review-first');
  await expect(chip.getByTestId('rf-chip-open')).toHaveAccessibleName(
    'Coverage · 4 antennas · review first',
  );
  await expect(chip.getByTestId('rf-chip-review')).toHaveText('Review antennas');
  await expect(chip.getByTestId('rf-chip-autoplan')).toHaveCount(0);
  await evidence(win, 'chip-review-first');
  await bench.getByTestId('rf-ai-card').getByTestId('rf-ai-autoplan').click();
  const dlg = win.getByTestId('rf-autoplan');
  await expect(dlg).toHaveAttribute('data-phase', 'blocked-review');
  await expect(dlg.getByRole('heading')).toContainText('Review antennas first');
  await expect(dlg.locator('[data-testid^="rf-autoplan-row-"]')).toHaveCount(0);
  await evidence(win, 'review-first');
  await dlg.getByRole('button', { name: 'Review antennas', exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(win.locator('#wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('[role="tabpanel"][data-front="measure"]')).toBeVisible();
  await evidence(win, 'review-first-measure');
  // nothing was planned or written
  expect(await readRfSectors(dataRoot.projectDir)).toBeNull();
});

test('drafts with the inventory drawn: Review antennas opens Measure on the first draft', async ({
  win,
  dataRoot,
}) => {
  await writeRfProject(dataRoot.projectDir, { allDraft: true, cloud: true });
  await openTiny(win);
  // the inventory is read (its Labels control shows in the 3D view)
  await expect(win.getByTestId('antenna-labels-control')).toBeVisible({ timeout: 30_000 });
  const bench = await openRfFromProjectMenu(win);
  await expect(bench.getByTestId('rf-step-antennas')).toContainText('0 accepted · 4 drafts');
  const chip = stageChip(win);
  await expect(chip).toHaveAttribute('data-state', 'review-first');
  await chip.getByTestId('rf-chip-review').click();
  // the Measure bench comes forward, the Coverage tab kept, the first draft's card shown
  await expect(win.locator('#wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('[role="tabpanel"][data-front="measure"]')).toBeVisible();
  // (kept and pinned; a narrow panel may list it under More tabs)
  const rfTab = await win.evaluate(
    () =>
      (
        window as unknown as {
          __stratlas: {
            workbench: { getState(): { tabs: { id: string; pinned?: boolean }[] } };
          };
        }
      ).__stratlas.workbench
        .getState()
        .tabs.find((x) => x.id === 'rf') ?? null,
  );
  expect(rfTab?.pinned).toBe(true);
  await expect(win.getByTestId('antenna-card')).toBeVisible();
  await expect(win.getByTestId('antenna-card-name')).toHaveText('P1');
  await evidence(win, 'review-ready-measure');
});
