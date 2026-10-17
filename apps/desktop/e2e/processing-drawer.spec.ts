/**
 * Processing belongs to the project: the sidebar's jobs chip and the drawer it opens show the open
 * project's processing and nothing else; **Create maps from photos** starts from the drawer; the
 * raw pipeline forms and every job on this computer are under Settings, Processing tools,
 * **Advanced**. The first tests start no job and need no pipeline Python.
 */
import { PIPELINES } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import {
  closeProcessing,
  expect,
  hasPipelinePython,
  launchApp,
  openPipelineForm,
  openProcessing,
  PIPELINE_ENV,
  processingChip,
  test,
} from './fixtures';

/** Screenshots for a person to look at: only with QUADRION_E2E_SHOTS set to a folder. */
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const TINY = 'E2E tiny project';

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: TINY }).click();
  await expect(win.locator('.proj-switch')).toContainText(TINY);
}

test('the chip opens the open project processing, and closing gives the focus back', async ({
  win,
}) => {
  // no project, nothing running: no chip, and no Jobs item in the sidebar
  await expect(processingChip(win)).toHaveCount(0);
  await expect(win.locator('.sb-nav .nav-item', { hasText: 'Jobs' })).toHaveCount(0);

  await openTiny(win);
  const chip = processingChip(win);
  await expect(chip).toHaveText('0 jobs');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  const drawer = await openProcessing(win);
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('heading', { level: 2, name: 'Processing' })).toBeFocused();
  await expect(drawer.getByTestId('proc-project')).toHaveText(TINY);
  await expect(drawer.getByTestId('create-maps')).toHaveText('Create maps from photos');
  await expect(drawer.getByTestId('proc-empty')).toHaveText(
    `Nothing is processing in ${TINY} and nothing has finished yet.`,
  );
  await expect(drawer.getByTestId('photo-runs')).toBeVisible();
  // plain words: no pipeline names, no dashes
  expect(await drawer.innerText()).not.toMatch(/pipeline|photogrammetry|COPC|–|—/i);
  await expectAccessible(win, 'Processing drawer', {
    include: '[data-testid="processing-drawer"]',
  });
  await shot(win, 'processing-drawer');

  // Esc inside the drawer closes it; the chip has the focus again
  await win.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  // the drawer stays with the project across screens
  await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await expect(chip).toHaveText('0 jobs');
});

test('Create maps from photos starts from the drawer, which makes way for it', async ({ win }) => {
  await openTiny(win);
  const drawer = await openProcessing(win);
  await drawer.getByTestId('create-maps').click();
  await expect(win.getByRole('dialog', { name: 'Create maps from photos' })).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test('finished jobs leave the list one by one or all at once, for good, and keep their outputs', async ({
  dataRoot,
  network,
}) => {
  // three finished jobs of the tiny project (done, cancelled, failed), with an output and a log
  const dir = dataRoot.projectDir;
  const record = (id: string, status: string, minute: number) => ({
    id,
    pipeline: 'system.selftest',
    project: dir,
    params: {},
    status,
    progress: status === 'done' ? 1 : 0.5,
    steps: [],
    artifacts: [],
    createdAt: `2026-10-12T09:0${String(minute)}:00.000Z`,
    updatedAt: `2026-10-12T09:0${String(minute)}:30.000Z`,
  });
  await mkdir(join(dir, 'out'), { recursive: true });
  await writeFile(join(dir, 'out', 'map.txt'), 'a map');
  await mkdir(join(dir, 'jobs', 'e2e-done'), { recursive: true });
  await writeFile(join(dir, 'jobs', 'e2e-done', 'job.log'), 'a log\n');
  await writeFile(
    join(dataRoot.userData, 'jobs.json'),
    JSON.stringify([
      record('e2e-interrupted', 'interrupted', 4),
      record('e2e-failed', 'failed', 3),
      record('e2e-cancelled', 'cancelled', 2),
      record('e2e-done', 'done', 1),
    ]),
  );
  const index = async () =>
    (JSON.parse(await readFile(join(dataRoot.userData, 'jobs.json'), 'utf8')) as { id: string }[])
      .map((j) => j.id)
      .sort();

  let app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    let win = await app.firstWindow();
    await openTiny(win);
    let drawer = await openProcessing(win);
    const finished = drawer.getByTestId('proc-finished');
    await expect(finished.locator('.job-row')).toHaveCount(4);

    // one row's remove takes only that job off the list
    const cancelled = finished.locator('.job-row-wrap', {
      has: win.locator('[data-job="e2e-cancelled"]'),
    });
    await cancelled.hover();
    const remove = cancelled.getByRole('button', { name: 'Remove from list' });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(finished.locator('.job-row')).toHaveCount(3);
    await expect(finished.locator('[data-job="e2e-cancelled"]')).toHaveCount(0);
    await expect.poll(index).toEqual(['e2e-done', 'e2e-failed', 'e2e-interrupted']);
    await expectAccessible(win, 'Processing drawer, finished jobs', {
      include: '[data-testid="processing-drawer"]',
    });
    await shot(win, 'processing-finished-remove');

    // Clear finished takes the rest but the interrupted job, which waits for Resume
    await drawer.getByTestId('proc-clear').click();
    await expect(finished.locator('.job-row')).toHaveCount(1);
    await expect(finished.locator('[data-job="e2e-interrupted"]')).toHaveCount(1);
    await expect(drawer.getByTestId('proc-clear')).toHaveCount(0);
    await expect.poll(index).toEqual(['e2e-interrupted']);
    await app.close();

    // after a restart the cleared jobs stay gone; the interrupted one goes on its own remove
    app = await launchApp(dataRoot);
    await network.attach(app);
    win = await app.firstWindow();
    await openTiny(win);
    drawer = await openProcessing(win);
    const left = drawer.getByTestId('proc-finished').locator('.job-row-wrap');
    await expect(left).toHaveCount(1);
    await expect(left.locator('[data-job="e2e-interrupted"]')).toHaveCount(1);
    await left.hover();
    await left.getByRole('button', { name: 'Remove from list' }).click();
    await expect(drawer.getByTestId('proc-empty')).toBeVisible();
    await expect(drawer.getByTestId('proc-finished')).toHaveCount(0);
    await expect.poll(index).toEqual([]);
    // every output is still on disk
    expect(await readFile(join(dir, 'out', 'map.txt'), 'utf8')).toBe('a map');
    expect(await readFile(join(dir, 'jobs', 'e2e-done', 'job.log'), 'utf8')).toBe('a log\n');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a project that is not an inspection has no Turn detections into issues', async ({ win }) => {
  await openTiny(win);
  await win.locator('.sb-nav .nav-item', { hasText: 'Detections' }).click();
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Detections');
  await expect(win.getByTestId('det-to-issues')).toHaveCount(0);
});

test('Settings, Advanced holds every pipeline by area and every job on this computer', async ({
  win,
}) => {
  await openTiny(win);
  await openPipelineForm(win);
  const advanced = win.getByTestId('job-advanced');
  const pick = win.locator('#job-pipeline');
  const labels = await pick
    .locator('optgroup')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
  expect(labels).toEqual([
    'Photos to maps',
    'Inspection',
    'Stockpiles and volumes',
    'Change between dates',
    'Survey tools',
    'Water and haul roads',
    'Import and convert',
    'Map packs',
    'Road survey',
    'System',
  ]);
  const values = await pick
    .locator('option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect([...values].sort()).toEqual(PIPELINES.map((p) => p.name).sort());

  await pick.selectOption('pointcloud.to_copc');
  const info = PIPELINES.find((p) => p.name === 'pointcloud.to_copc');
  await expect(advanced).toContainText(info?.description ?? '');
  // the open project is the folder the form starts from
  await expect(win.getByLabel(/^Project folder/)).not.toHaveValue('');
  await expect(win.getByTestId('job-start')).toBeVisible();
  await expect(advanced.getByTestId('jobs-none')).toHaveText(
    'No job has run on this computer yet.',
  );
  await expectAccessible(win, 'Settings, Advanced pipelines', {
    include: '[data-testid="job-advanced"]',
  });
  await advanced.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
  });
  await shot(win, 'processing-advanced');
});

test.describe('with the runtime', () => {
  test.skip(!hasPipelinePython(), 'no Python with aio_pipelines (uv sync in python/)');

  test('a job shows on its project chip and drawer, and as running elsewhere after', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(180_000);
    const app = await launchApp(dataRoot, PIPELINE_ENV);
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await openTiny(win);

      // a self-test that waits a minute, for the open project
      await openPipelineForm(win);
      await win.getByLabel('Pipeline', { exact: true }).selectOption('system.selftest');
      await win.getByLabel('Wait (s)').fill('60');
      await win.getByTestId('job-start').click();
      const chip = processingChip(win);
      await expect(chip).toHaveText('1 job', { timeout: 60_000 });
      await expect(chip).toHaveAttribute('aria-label', /^Processing \d+%$/);
      await expect(chip).toHaveAttribute('data-state', 'one');

      // the project's drawer lists it, with its kind, and opens its details
      await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
      let drawer = await openProcessing(win);
      const row = drawer.getByTestId('proc-running').locator('.job-row');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Check the pipeline pack');
      await expect(row).toHaveAttribute('data-kind', 'system');
      await expect(drawer.getByTestId('proc-empty')).toHaveCount(0);
      await row.click();
      // opening a row keeps the focus in the drawer: Esc still closes it, and the chip has it
      await expect(drawer.getByRole('heading', { level: 2, name: 'Processing' })).toBeFocused();
      await win.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(chip).toBeFocused();
      drawer = await openProcessing(win);
      await drawer.getByTestId('proc-running').locator('.job-row').click();
      const detail = drawer.locator('.job-detail');
      await expect(detail).toHaveAttribute('data-form', 'folded');
      await shot(win, 'processing-job-details');
      const wait = detail.locator('.jd-steps li', { hasText: 'Wait' });
      await expect(wait).toHaveAttribute('data-state', 'running', { timeout: 60_000 });
      await expectAccessible(win, 'Processing drawer, a job', {
        include: '[data-testid="processing-drawer"]',
      });

      // cancel and resume from the drawer
      await detail.getByRole('button', { name: 'Cancel' }).click();
      await expect(detail.locator('.jd-h .job-state')).toHaveText('Cancelled', {
        timeout: 15_000,
      });
      await expect(chip).toHaveText('0 jobs');
      await detail.getByRole('button', { name: 'Resume' }).click();
      await expect(wait).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
      await detail.getByTestId('job-log-fold').locator('summary').click();
      await expect(detail.locator('.job-log')).toContainText('Cancelled');

      // Back to the list, then close the project: the job is now running elsewhere
      await drawer.getByTestId('proc-back').click();
      await expect(drawer.getByTestId('proc-running').locator('.job-row')).toHaveCount(1);
      await expect(drawer.getByRole('heading', { level: 2, name: 'Processing' })).toBeFocused();
      await closeProcessing(win);
      await win.locator('.proj-switch').focus();
      await win.keyboard.press('Enter');
      await win.locator('.proj-menu').getByRole('menuitem', { name: 'Close project' }).click();
      await expect(chip).toHaveText('1 job');

      drawer = await openProcessing(win);
      await expect(drawer.getByTestId('create-maps')).toHaveCount(0);
      await expect(drawer.getByTestId('proc-running')).toHaveCount(0);
      const other = drawer.getByTestId('proc-elsewhere').locator('.job-row');
      await expect(other).toHaveCount(1);
      await expect(other).toContainText(TINY);

      // it can be opened and cancelled from here; once it has stopped, nothing is left to show
      await other.click();
      // the header names the project the job belongs to, not a project that is not there
      await expect(drawer.getByTestId('proc-project')).toHaveText(TINY);
      await drawer.locator('.job-detail').getByRole('button', { name: 'Cancel' }).click();
      await expect(drawer.getByTestId('proc-none')).toHaveText('No project is open.', {
        timeout: 15_000,
      });
      await closeProcessing(win);
      await expect(chip).toHaveCount(0);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
