/**
 * Create engineering model through the real UI (acceptance A, C, D, H), on synthetic data only: a
 * partial, noisy chimney cloud written by the Python synth (`engineering-fixture.py`) and one
 * synthetic photo. The `model.evidence` job runs for real in the pipeline Python
 * (QUADRION_E2E_PYTHON); the AI step answers from the scripted provider
 * (QUADRION_AI_TEST_PROVIDER), so nothing leaves the machine and the zero-network guard of the
 * fixture stays on.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  approveAgent,
  ask,
  confirmSends,
  engFixture,
  ENV,
  type EngProject,
  nextOpenDialog,
  openProject,
  openReview,
  readModel,
  readRun,
  runToReview,
  setupStep,
  stageStatus,
  startSetup,
  writeProject,
} from './engineeringFlow';
import {
  expect,
  hasPdal,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  PDAL,
  test,
  VENV_PYTHON,
} from './fixtures';

test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
/**
 * The cloud is a COPC layer: the job reads its region through PDAL (the pack ships it). A
 * workstation without PDAL skips these cases; CI installs it (ci.yml), so there they fail instead.
 */
function needPdal(): void {
  if (hasPdal()) return;
  const why = `no PDAL at ${PDAL} (set AIO_PDAL)`;
  if (process.env.CI) throw new Error(`${why}: CI must run the engineering flow on the cloud`);
  test.skip(true, why);
}

const engTest = test.extend<{ eng: EngProject }>({ eng: engFixture });

engTest.use({ appEnv: ENV });

/** Right-click the cloud row, Create engineering model...: the setup with the cloud chosen. */
async function setupFromCloud(win: Page) {
  const row = win.getByTestId('tree-row-scan');
  // the Point clouds group of the Datasets list starts folded
  const group = win
    .getByRole('tree', { name: 'Datasets' })
    .getByRole('button', { name: /^Point clouds 1/ });
  await expect(group).toBeVisible({ timeout: 30_000 });
  if (!(await row.isVisible())) await group.click();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await win.getByTestId('menu-create-engineering').click();
  const setup = win.getByTestId('eng-setup');
  await expect(setup).toBeVisible();
  await expect(setup.getByTestId('eng-source-scan')).toBeChecked();
  return setup;
}

/** Change Settings the way the Settings screen does (the renderer's copy follows at once). */
const setSettings = (win: Page, patch: Record<string, unknown>) =>
  win.evaluate(
    (p) =>
      (
        window as unknown as {
          __stratlas: {
            shell: { getState(): { updateSettings(p: unknown): Promise<string | null> } };
          };
        }
      ).__stratlas.shell
        .getState()
        .updateSettings(p),
    patch,
  );

engTest('A: from a partial chimney cloud to an accepted model layer', async ({ eng, win }) => {
  test.setTimeout(300_000);
  needPdal();
  await openProject(win);
  const setup = await setupFromCloud(win);
  await expect(setup.getByTestId('eng-detail-standard')).toBeChecked();
  await startSetup(setup);
  const panel = win.getByTestId('eng-run');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await confirmSends(win, async () => (await stageStatus(win, 'review')) === 'done');
  await expect.poll(() => stageStatus(win, 'review'), { timeout: 240_000 }).toBe('done');
  // the AI step ran (the scripted provider), after the preview was confirmed
  await expect(win.getByTestId('eng-run-notice')).toHaveCount(0);
  expect((await readRun(eng.dir)).stages.identify?.status).toBe('done');
  // the draft: the measured taper, the flues the evidence supports, lights at the intermediate
  // levels as well as the crown
  const model = await readModel(eng.dir);
  const flues = model.assemblies.filter((a) => a.kind === 'flue');
  expect(flues.length).toBeGreaterThanOrEqual(2);
  const lightLevels = new Set(
    model.assemblies
      .filter((a) => a.kind === 'warningLight')
      .map((a) => Math.round(((a.params.centre as number[] | undefined)?.[1] ?? 0) / 10) * 10),
  );
  expect([...lightLevels]).toEqual(expect.arrayContaining([40, 80]));
  const shaft = model.assemblies.find((a) => a.kind === 'shaft');
  const profile = (shaft?.params.profile ?? []) as { y: number; r: number }[];
  const rAt = (y: number) => {
    const i = profile.findIndex((p) => p.y >= y);
    const a = profile[Math.max(0, i - 1)];
    const b = profile[Math.max(0, i)];
    if (!a || !b || b.y === a.y) return a?.r ?? 0;
    return a.r + ((b.r - a.r) * (y - a.y)) / (b.y - a.y);
  };
  expect(rAt(1)).toBeGreaterThan(8.3);
  expect(rAt(100)).toBeLessThan(7.1);

  // review the components, accept them, then accept the model: one new layer
  await openReview(win);
  await expect(win.getByTestId('eng-add-reviewed')).toBeDisabled();
  const section = win.getByTestId('components-section');
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: 'Accept all drafts' }).click();
  await expect
    .poll(async () => (await readModel(eng.dir)).assemblies.every((x) => x.status === 'accepted'))
    .toBe(true);
  const review = win.getByTestId('eng-model-review');
  await expect(review.getByTestId('eng-add-reviewed')).toBeEnabled({
    timeout: 30000,
  });
  await win.screenshot({ path: test.info().outputPath('review-wide.png') });
  await win.setViewportSize({ width: 1100, height: 720 });
  await section.locator('.mb-cmp-row').last().click();
  await expect
    .poll(() =>
      review.getByTestId('component-card').evaluate((card) => {
        const box = card.getBoundingClientRect();
        const scroller = card.closest('.wb-scroll');
        const viewport = scroller?.getBoundingClientRect();
        const body = scroller?.closest('[role="tabpanel"]')?.getBoundingClientRect();
        return (
          !!viewport &&
          !!body &&
          viewport.bottom <= body.bottom + 1 &&
          box.top >= viewport.top - 2 &&
          box.top + 80 < viewport.bottom
        );
      }),
    )
    .toBe(true);
  await win.screenshot({ path: test.info().outputPath('review-1100.png') });
  await expect(win.locator('#wb-tab-review')).toHaveAttribute('aria-selected', 'true');
  await review.getByTestId('eng-view-overlay').click();
  await expect(review.getByTestId('eng-view-overlay')).toHaveAttribute('aria-pressed', 'true');
  await review.getByTestId('eng-view-model').click();
  await review.getByTestId('eng-add-reviewed').click();
  await expect(review).toContainText('Accepted: the model is a layer of the project now.', {
    timeout: 60000,
  });
  const manifest = JSON.parse(await readFile(join(eng.dir, 'manifest.json'), 'utf8')) as {
    layers: { id: string; kind: string }[];
  };
  const accepted = manifest.layers.filter((l) => l.kind === 'mesh' && l.id === `model-${model.id}`);
  expect(accepted).toHaveLength(1);
});

/** A click (no drag) in the middle of the 3D view. */
async function clickScene(win: Page) {
  const box = await win.locator('.pane-3d:not(.pane-compare) canvas').first().boundingBox();
  if (!box) throw new Error('no 3D view');
  await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

engTest(
  'B: a region and an anchor picked in the 3D view keep the setup and start anchored',
  async ({ eng, win }) => {
    test.setTimeout(240_000);
    await openProject(win);
    const setup = await setupFromCloud(win);
    await setupStep(setup, 1);
    await setup.getByTestId('eng-detail-fast').check();
    await setupStep(setup, 0);
    const bar = win.getByTestId('eng-pick-bar');

    // the region: the setup steps aside while the bar says what to do; Escape lets it go
    await setup.getByTestId('eng-region-pick').click();
    await expect(bar).toContainText('Click the asset in the 3D view. Escape cancels.');
    await expect(setup).toBeHidden();
    await win.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect(setup).toBeVisible();
    await expect(setup.getByTestId('eng-region')).toHaveCount(0);
    await expect(setup.getByTestId('eng-detail-fast')).toBeChecked();
    // picked for real: the region shows, every other choice is as it was
    await setup.getByTestId('eng-region-pick').click();
    await expect(setup).toBeHidden();
    await clickScene(win);
    await expect(setup).toBeVisible();
    await expect(setup.getByTestId('eng-region')).toContainText('Around E');
    await expect(setup.getByTestId('eng-detail-fast')).toBeChecked();
    await expect(setup.getByTestId('eng-source-scan')).toBeChecked();

    // the anchor: Start waits for it, then takes it
    await setupStep(setup, 1);
    await setup.getByTestId('eng-placement-anchor').check();
    await expect(setup.getByTestId('eng-start')).toBeDisabled();
    await setup.getByTestId('eng-anchor-pick').click();
    await expect(bar).toBeVisible();
    await clickScene(win);
    await expect(setup.getByTestId('eng-anchor')).toContainText('At E');
    await expect(setup.getByTestId('eng-region')).toContainText('Around E');
    await expect(setup.getByTestId('eng-start')).toBeEnabled();
    await startSetup(setup);
    await expect(win.getByTestId('eng-run')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await readRun(eng.dir).catch(() => null))?.setup ?? null, {
        timeout: 30_000,
      })
      .toMatchObject({ placement: 'anchor', detail: 'fast', region: { radiusM: 30 } });
    const run = await readRun(eng.dir);
    expect(run.setup.anchor).toHaveLength(3);
    if (await win.getByTestId('eng-cancel').isVisible())
      await win.getByTestId('eng-cancel').click();
  },
);

engTest(
  'C: one photo only: a provisional scale and an unplaced model',
  async ({ app, eng, win }) => {
    test.setTimeout(240_000);
    await openProject(win);
    // from the palette: nothing chosen yet, one photo added from files
    await win.keyboard.press('Control+K');
    await win.keyboard.type('Create engineering model');
    await win.getByRole('option', { name: /Create engineering model from point clouds/ }).click();
    const setup = win.getByTestId('eng-setup');
    await expect(setup).toBeVisible();
    await expect(setup.getByTestId('eng-start')).toBeDisabled();
    await nextOpenDialog(app, [eng.photo]);
    await setup.getByTestId('eng-add-photos').click();
    await expect(setup.getByTestId('eng-photo-files')).toContainText('1 photo from files');
    await setupStep(setup, 1);
    await setup.getByTestId('eng-detail-fast').check();
    await startSetup(setup);
    await runToReview(win);
    const model = await readModel(eng.dir);
    expect(model.scale?.status).toBe('provisional');
    expect(model.georef?.horizontal.status).toBe('unplaced');
    expect(model.assemblies.length).toBeGreaterThan(0);
    expect((await readRun(eng.dir)).reconstruction).toBe('unavailable');
    await openReview(win);
    await expect(win.getByTestId('components-section')).toBeVisible();
  },
);

engTest(
  'H: offline, the local stages run, identify says why, nothing is sent',
  async ({ eng, win, network }) => {
    test.setTimeout(240_000);
    needPdal();
    await openProject(win);
    await setSettings(win, { offlineOnly: true });
    const setup = await setupFromCloud(win);
    await setupStep(setup, 1);
    await expect(setup.getByTestId('eng-offline')).toBeVisible();
    await expect(setup.getByTestId('eng-next')).toBeEnabled();
    await setupStep(setup, 1);
    await setup.getByTestId('eng-detail-fast').check();
    await startSetup(setup);
    await runToReview(win, { send: false });
    await expect(win.locator('.ag-ev')).toHaveCount(0);
    expect((await readRun(eng.dir)).stages.identify?.status).toBe('skipped');
    expect((await readRun(eng.dir)).stages.identify?.message).toContain('Offline mode is on');
    const run = await readRun(eng.dir);
    expect(run.usage.inputTokens).toBe(0);
    expect(await network.outbound()).toEqual([]);
    // the measured draft is reviewable
    await openReview(win);
    await expect(win.getByTestId('components-section')).toBeVisible();
  },
);

engTest(
  'H: declined at the preview, nothing is sent and the draft is measured only',
  async ({ eng, win }) => {
    test.setTimeout(240_000);
    needPdal();
    await openProject(win);
    const setup = await setupFromCloud(win);
    await setupStep(setup, 1);
    await setup.getByTestId('eng-detail-fast').check();
    await startSetup(setup);
    const dialog = win.locator('.ag-ev').first();
    await expect(dialog).toBeVisible({ timeout: 120_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await runToReview(win, { send: false });
    expect((await readRun(eng.dir)).stages.identify?.status).toBe('skipped');
    expect((await readRun(eng.dir)).stages.identify?.message).toContain('the send was declined');
    expect((await readRun(eng.dir)).usage.inputTokens).toBe(0);
  },
);

engTest('H: the OpenAI route runs the same flow; cancel and retry', async ({ eng, win }) => {
  test.setTimeout(300_000);
  needPdal();
  await openProject(win);
  await setSettings(win, {
    routes: [
      { task: 'chat', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { task: 'vision', provider: 'anthropic', model: 'claude-opus-5-5' },
      { task: 'report', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { task: 'extract', provider: 'openai', model: 'gpt-6-luna' },
      { task: 'build', provider: 'anthropic', model: 'claude-opus-5-5' },
      { task: 'engineer', provider: 'openai', model: 'gpt-6-luna', treatAsVision: true },
    ],
  });
  const setup = await setupFromCloud(win);
  await expect(setup.getByTestId('eng-route')).toContainText('OpenAI');
  await setupStep(setup, 1);
  await setup.getByTestId('eng-detail-fast').check();
  await startSetup(setup);
  // cancel while measuring, then retry the same run
  await expect(win.getByTestId('eng-cancel')).toBeVisible({ timeout: 30_000 });
  await win.getByTestId('eng-cancel').click();
  await expect(win.getByTestId('eng-retry')).toBeVisible({ timeout: 60_000 });
  await win.getByTestId('eng-retry').click();
  const dialog = win.locator('.ag-ev').first();
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog).toContainText('Send evidence to OpenAI?');
  await runToReview(win);
  expect((await readRun(eng.dir)).stages.identify?.status).toBe('done');
  const run = await readRun(eng.dir);
  expect(run.usage.inputTokens).toBeGreaterThan(0);
  await expect(win.getByTestId('eng-setup')).toHaveCount(0);
});

test('D: corrections regenerate only what they touch, keep ids and survive a restart', async ({
  dataRoot,
}) => {
  test.setTimeout(360_000);
  needPdal();
  const eng = await writeProject(dataRoot);
  const network = new NetworkGuard();
  let app = await launchApp(dataRoot, ENV);
  await network.attach(app);
  try {
    let win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openProject(win);
    const setup = await setupFromCloud(win);
    await setupStep(setup, 1);
    await setup.getByTestId('eng-detail-fast').check();
    await startSetup(setup);
    await runToReview(win);
    // the person accepts every component first
    await openReview(win);
    const section = win.getByTestId('components-section');
    await section.getByRole('button', { name: 'Accept all drafts' }).click();
    await expect
      .poll(async () => (await readModel(eng.dir)).assemblies.every((a) => a.status === 'accepted'))
      .toBe(true);
    const before = await readModel(eng.dir);
    const flueIds = before.assemblies.filter((a) => a.kind === 'flue').map((a) => a.id);
    const shaftBefore = before.assemblies.find((a) => a.kind === 'shaft');
    /** How many rows of the review's component list are flues of the model as saved now. */
    const flueRows = async () => {
      const ids = (await readModel(eng.dir)).assemblies
        .filter((a) => a.kind === 'flue')
        .map((a) => a.id);
      return win
        .getByTestId('component-tree')
        .locator('[data-component]')
        .evaluateAll(
          (rows, want) =>
            rows.filter((r) => want.includes(r.getAttribute('data-component') ?? '')).length,
          ids,
        );
    };
    await expect.poll(flueRows, { timeout: 30_000 }).toBe(flueIds.length);

    await ask(win, 'there are four flues, not three');
    await approveAgent(win, 'set_count');
    await expect
      .poll(
        async () => (await readModel(eng.dir)).assemblies.filter((a) => a.kind === 'flue').length,
        {
          timeout: 60_000,
        },
      )
      .toBe(4);
    // the component list shows the four flues without opening anything again
    await expect.poll(flueRows, { timeout: 60_000 }).toBe(4);
    const after = await readModel(eng.dir);
    for (const id of flueIds) expect(after.assemblies.map((a) => a.id)).toContain(id);
    // what the correction did not touch is the same object
    expect(after.assemblies.find((a) => a.kind === 'shaft')).toEqual(shaftBefore);

    await ask(win, 'the intermediate warning lights are at 25, 50 and 75 m');
    await approveAgent(win, 'set_levels');
    await expect
      .poll(
        async () =>
          new Set(
            (await readModel(eng.dir)).assemblies
              .filter((a) => a.kind === 'warningLight')
              .map((a) => Math.round((a.params.centre as number[] | undefined)?.[1] ?? 0)),
          ).has(25),
        { timeout: 60_000 },
      )
      .toBe(true);
    const corrected = await readModel(eng.dir);

    // closed and opened again: the corrections are there, nothing was redone
    await app.close();
    app = await launchApp(dataRoot, ENV);
    await network.attach(app);
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openProject(win);
    expect(await readModel(eng.dir)).toEqual(corrected);
    expect(corrected.assemblies.filter((a) => a.kind === 'flue')).toHaveLength(4);
    const row = win.getByTestId('tree-row-scan');
    if (!(await row.isVisible()))
      await win
        .getByRole('tree', { name: 'Datasets' })
        .getByRole('button', { name: /^Point clouds 1/ })
        .click();
    await row.click({ button: 'right' });
    await win.getByTestId('menu-create-engineering').click();
    await expect(win.getByTestId('eng-saved-runs')).toBeVisible();
    await openReview(win);
    await expect.poll(flueRows, { timeout: 30_000 }).toBe(4);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
