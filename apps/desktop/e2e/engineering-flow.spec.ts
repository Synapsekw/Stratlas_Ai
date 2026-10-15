/**
 * Create engineering model through the real UI (acceptance A, C, D, H), on synthetic data only: a
 * partial, noisy chimney cloud written by the Python synth (`engineering-fixture.py`) and one
 * synthetic photo. The `model.evidence` job runs for real in the pipeline Python
 * (QUADRION_E2E_PYTHON); the AI step answers from the scripted provider
 * (QUADRION_AI_TEST_PROVIDER), so nothing leaves the machine and the zero-network guard of the
 * fixture stays on.
 */
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
  type DataRoot,
} from './fixtures';

const FIXTURE = join(import.meta.dirname, 'engineering-fixture.py');
const PROJECT = { id: 'e2e-eng-flow', name: 'E2E engineering chimney' };
const ENV = { ...PIPELINE_ENV, QUADRION_AI_TEST_PROVIDER: '1' };

test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

interface Assembly {
  id: string;
  kind: string;
  status: string;
  params: Record<string, unknown>;
}
interface Model {
  id: string;
  assemblies: Assembly[];
  scale?: { status?: string };
  georef?: { horizontal: { status: string } };
}

/** The synthetic project: the cloud layer, and one photo outside the project (for Add photos). */
async function writeProject(dataRoot: DataRoot): Promise<{ dir: string; photo: string }> {
  const dir = join(dataRoot.root, 'projects', PROJECT.id);
  const photos = join(dataRoot.base, 'photos');
  await mkdir(dir, { recursive: true });
  execFileSync(VENV_PYTHON, [FIXTURE, dir, photos], { encoding: 'utf8' });
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: PROJECT.id,
    name: PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32633 },
    origin: [500000, 3200000, 10],
    captures: [],
    layers: [
      {
        kind: 'pointcloud',
        id: 'scan',
        name: 'Chimney scan',
        src: { path: 'clouds/scan.las' },
        format: 'copc',
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return { dir, photo: join(photos, 'synth_01.jpg') };
}

const engTest = test.extend<{ eng: { dir: string; photo: string } }>({
  eng: async ({ dataRoot }, use) => {
    await use(await writeProject(dataRoot));
  },
});

engTest.use({ appEnv: ENV });

async function openProject(win: Page) {
  // cloud AI on for this workstation (the scripted provider answers; nothing leaves)
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: PROJECT.name }).first().click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
              }
            ).__stratlas.workspace.getState().project?.id ?? null,
        ),
      { timeout: 60_000 },
    )
    .toBe(PROJECT.id);
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
}

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

/** Confirm every send the run asks for (allow the kinds for the project, then send). */
async function confirmSends(win: Page, until: () => Promise<boolean>) {
  const dialog = win.locator('.ag-ev').first();
  for (let i = 0; i < 40 && !(await until()); i++) {
    if (await dialog.isVisible().catch(() => false)) {
      const allow = dialog.getByRole('button', { name: 'Allow for this project' });
      // each kind once; the list redraws after every allow
      for (let k = 0; k < 3 && (await allow.count()) > 0; k++) {
        await allow.first().click();
        await win.waitForTimeout(200);
      }
      await dialog.getByRole('button', { name: 'Send once' }).click();
    }
    await win.waitForTimeout(1000);
  }
}

/** A stage's status in the run panel, or null while the panel does not show it (never waits). */
const stageStatus = (win: Page, stage: string) =>
  win.evaluate(
    (s) =>
      document
        .querySelector(`[data-testid="eng-stage"][data-stage="${s}"]`)
        ?.getAttribute('data-status') ?? null,
    stage,
  );

/** Start, confirm the sends (or not), and wait for the review stage. */
async function runToReview(win: Page, o: { send: boolean } = { send: true }) {
  await expect(win.getByTestId('eng-run')).toBeVisible({ timeout: 30_000 });
  if (o.send) await confirmSends(win, async () => (await stageStatus(win, 'review')) === 'done');
  await expect.poll(() => stageStatus(win, 'review'), { timeout: 240_000 }).toBe('done');
}

interface RunFile {
  setup: {
    placement: string;
    anchor?: number[];
    region?: { centre: number[]; radiusM: number };
    detail: string;
  };
  usage: { costUsd: number; inputTokens: number };
  stages: Record<string, { status: string; message?: string }>;
  reconstruction?: string;
}

async function readRun(dir: string): Promise<RunFile> {
  const runs = (await readdir(join(dir, 'engineering'))).filter((f) => f.startsWith('run-'));
  const last = runs.sort().at(-1);
  if (!last) throw new Error('no run');
  return JSON.parse(await readFile(join(dir, 'engineering', last, 'run.json'), 'utf8')) as RunFile;
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

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

/** The agent's first send in a project stops at its preview; later ones go straight out. */
async function approveAgent(win: Page, tool: string) {
  const preview = win.getByRole('dialog', { name: /^Send to / });
  if (await preview.isVisible().catch(() => false))
    await preview.getByRole('button', { name: 'Send' }).click();
  await expect(agent(win).locator('.step.awaiting')).toContainText(tool, { timeout: 30_000 });
  await agent(win).getByRole('button', { name: 'Approve' }).click();
  await expect(agent(win).locator('.step.done').last()).toBeVisible({ timeout: 30_000 });
}

async function readModel(dir: string): Promise<Model> {
  const files = (await readdir(join(dir, 'models'))).filter((f) => f.endsWith('.procmodel.json'));
  const file = files.find((f) => !f.startsWith('site-')) ?? files[0];
  if (!file) throw new Error('no model file');
  return JSON.parse(await readFile(join(dir, 'models', file), 'utf8')) as Model;
}

engTest('A: from a partial chimney cloud to an accepted model layer', async ({ eng, win }) => {
  test.setTimeout(300_000);
  await openProject(win);
  const setup = await setupFromCloud(win);
  await expect(setup.getByTestId('eng-detail-standard')).toBeChecked();
  await setup.getByTestId('eng-start').click();
  const panel = win.getByTestId('eng-run');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await confirmSends(win, async () => (await stageStatus(win, 'review')) === 'done');
  await expect.poll(() => stageStatus(win, 'review'), { timeout: 240_000 }).toBe('done');
  // the AI step ran (the scripted provider), after the preview was confirmed
  await expect(win.getByTestId('eng-run-notice')).toHaveCount(0);
  expect(await stageStatus(win, 'identify')).toBe('done');
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
  await expect(win.getByTestId('eng-accept')).toBeDisabled();
  await expect(win.getByTestId('eng-accept-needs')).toBeVisible();
  await win.getByTestId('eng-review').click();
  const section = win.getByTestId('components-section');
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: 'Accept all drafts' }).click();
  await expect
    .poll(async () => (await readModel(eng.dir)).assemblies.every((x) => x.status === 'accepted'))
    .toBe(true);
  // the builder closed, the run panel is back with Accept on
  await win.getByTestId('model-builder').getByRole('button', { name: 'Close' }).click();
  await expect(win.getByTestId('eng-accept')).toBeEnabled({ timeout: 15_000 });
  await win.getByTestId('eng-accept').click();
  await expect(panel).toContainText('Accepted: the model is a layer of the project now.', {
    timeout: 60_000,
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
    await setup.getByTestId('eng-detail-fast').check();
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
    await setup.getByTestId('eng-placement-anchor').check();
    await expect(setup.getByTestId('eng-start')).toBeDisabled();
    await setup.getByTestId('eng-anchor-pick').click();
    await expect(bar).toBeVisible();
    await clickScene(win);
    await expect(setup.getByTestId('eng-anchor')).toContainText('At E');
    await expect(setup.getByTestId('eng-region')).toContainText('Around E');
    await expect(setup.getByTestId('eng-start')).toBeEnabled();
    await setup.getByTestId('eng-start').click();
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
    await setup.getByTestId('eng-detail-fast').check();
    await setup.getByTestId('eng-start').click();
    await runToReview(win);
    const model = await readModel(eng.dir);
    expect(model.scale?.status).toBe('provisional');
    expect(model.georef?.horizontal.status).toBe('unplaced');
    expect(model.assemblies.length).toBeGreaterThan(0);
    expect((await readRun(eng.dir)).reconstruction).toBe('unavailable');
    await win.getByTestId('eng-review').click();
    await expect(win.getByTestId('components-section')).toBeVisible();
  },
);

engTest(
  'H: offline, the local stages run, identify says why, nothing is sent',
  async ({ eng, win, network }) => {
    test.setTimeout(240_000);
    await openProject(win);
    await setSettings(win, { offlineOnly: true });
    const setup = await setupFromCloud(win);
    await expect(setup.getByTestId('eng-offline')).toBeVisible();
    await expect(setup.getByTestId('eng-preview')).toBeDisabled();
    await setup.getByTestId('eng-detail-fast').check();
    await setup.getByTestId('eng-start').click();
    await runToReview(win, { send: false });
    await expect(win.locator('.ag-ev')).toHaveCount(0);
    expect(await stageStatus(win, 'identify')).toBe('skipped');
    await expect(win.getByTestId('eng-run')).toContainText(
      'Offline mode is on, so nothing is sent.',
    );
    const run = await readRun(eng.dir);
    expect(run.usage.inputTokens).toBe(0);
    expect(await network.outbound()).toEqual([]);
    // the measured draft is reviewable
    await win.getByTestId('eng-review').click();
    await expect(win.getByTestId('components-section')).toBeVisible();
  },
);

engTest(
  'H: declined at the preview, nothing is sent and the draft is measured only',
  async ({ eng, win }) => {
    test.setTimeout(240_000);
    await openProject(win);
    const setup = await setupFromCloud(win);
    await setup.getByTestId('eng-detail-fast').check();
    await setup.getByTestId('eng-start').click();
    const dialog = win.locator('.ag-ev').first();
    await expect(dialog).toBeVisible({ timeout: 120_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await runToReview(win, { send: false });
    expect(await stageStatus(win, 'identify')).toBe('skipped');
    await expect(win.getByTestId('eng-run')).toContainText('the send was declined');
    expect((await readRun(eng.dir)).usage.inputTokens).toBe(0);
  },
);

engTest('H: the OpenAI route runs the same flow; cancel and retry', async ({ eng, win }) => {
  test.setTimeout(300_000);
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
  await setup.getByTestId('eng-detail-fast').check();
  await setup.getByTestId('eng-start').click();
  // cancel while measuring, then retry the same run
  await expect(win.getByTestId('eng-cancel')).toBeVisible({ timeout: 30_000 });
  await win.getByTestId('eng-cancel').click();
  await expect(win.getByTestId('eng-retry')).toBeVisible({ timeout: 60_000 });
  await win.getByTestId('eng-retry').click();
  const dialog = win.locator('.ag-ev').first();
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog).toContainText('Send evidence to OpenAI?');
  await runToReview(win);
  expect(await stageStatus(win, 'identify')).toBe('done');
  const run = await readRun(eng.dir);
  expect(run.usage.inputTokens).toBeGreaterThan(0);
  await expect(win.getByTestId('eng-setup')).toHaveCount(0);
});

test('D: corrections regenerate only what they touch, keep ids and survive a restart', async ({
  dataRoot,
}) => {
  test.setTimeout(360_000);
  const eng = await writeProject(dataRoot);
  const network = new NetworkGuard();
  let app = await launchApp(dataRoot, ENV);
  await network.attach(app);
  try {
    let win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openProject(win);
    const setup = await setupFromCloud(win);
    await setup.getByTestId('eng-detail-fast').check();
    await setup.getByTestId('eng-start').click();
    await runToReview(win);
    // the person accepts every component first
    await win.getByTestId('eng-review').click();
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
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

/** Make the next native open dialog return these files (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}
