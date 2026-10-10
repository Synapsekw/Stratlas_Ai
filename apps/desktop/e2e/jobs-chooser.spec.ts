/**
 * The Jobs screen, tasks first: **New job** opens a short list of plain tasks, each taking the
 * person to the guided screen that does it; **Create maps from photos** is first and is also the
 * screen's own primary button. The pipelines stay under **Advanced: run a pipeline directly**,
 * grouped by area, with the same form as before. Nothing here starts a job, so it needs no
 * pipeline Python.
 */
import { PIPELINES } from '@aio/schema';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, test } from './fixtures';

/** Screenshots for a person to look at: only with QUADRION_E2E_SHOTS set to a folder. */
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const jobsNav = (win: Page) => win.locator('.sb-nav .nav-item', { hasText: 'Jobs' });
const task = (win: Page, id: string) =>
  win.getByTestId('job-chooser').locator(`[data-task="${id}"]`);

test('New job offers a short list of tasks, with the pipelines under Advanced', async ({ win }) => {
  await win.getByTestId('project-card').first().click();
  await jobsNav(win).click();
  const screen = win.getByRole('region', { name: 'Jobs' });
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Jobs');
  await expect(screen).toContainText('Processing that runs on this computer.');
  await expect(screen).not.toContainText('Pipelines from the pipeline pack');
  // the screen's own first action
  await expect(win.getByTestId('create-maps')).toHaveText('Create maps from photos');
  await expect(win.getByTestId('create-maps')).toBeEnabled();

  await win.getByRole('button', { name: 'New job', exact: true }).click();
  const chooser = win.getByTestId('job-chooser');
  await expect(chooser.getByRole('heading', { level: 2 })).toHaveText('New job');
  // three headings, a handful of tasks, and no list of pipelines in sight
  for (const name of ['Maps and models', 'Measure and compare', 'Import and convert'])
    await expect(chooser.getByRole('group', { name })).toBeVisible();
  const tasks = chooser.locator('[data-task]');
  await expect(tasks).toHaveCount(9);
  await expect(tasks.first()).toHaveAttribute('data-task', 'photo-maps');
  await expect(tasks.first()).toContainText('Create maps from photos');
  await expect(tasks.first()).toHaveClass(/primary/);
  await expect(chooser.locator('.nj-task.primary')).toHaveCount(1);
  await expect(win.locator('#job-pipeline')).toBeHidden();
  await expect(win.getByTestId('job-start')).toBeHidden();
  const words = (await tasks.allInnerTexts()).join(' ');
  expect(words).not.toMatch(/pipeline|photogrammetry|COPC|–|—/i);
  await expectAccessible(win, 'Jobs, New job tasks', { include: '[data-testid="job-chooser"]' });
  await shot(win, 'jobs-chooser');

  // Advanced: every pipeline, grouped by area, with its description and the same form
  await chooser.getByText('Advanced: run a pipeline directly').click();
  const pick = win.locator('#job-pipeline');
  await expect(pick).toBeVisible();
  expect(
    await pick.locator('optgroup').evaluateAll((g) => g.map((x) => x.getAttribute('label'))),
  ).toEqual([
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
    .evaluateAll((o) => o.map((x) => x.getAttribute('value')));
  expect([...values].sort()).toEqual(PIPELINES.map((p) => p.name).sort());
  await pick.selectOption('pointcloud.to_copc');
  const info = PIPELINES.find((p) => p.name === 'pointcloud.to_copc');
  await expect(chooser).toContainText(info?.description ?? '');
  await expect(win.getByLabel(/^Project folder/)).toBeVisible();
  await expect(win.getByTestId('job-start')).toBeVisible();
  await expectAccessible(win, 'Jobs, New job advanced', { include: '[data-testid="job-chooser"]' });
  await win.getByTestId('job-advanced').evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
  });
  await shot(win, 'jobs-advanced');

  // the first task opens the one-screen dialog, and the chooser steps aside
  await task(win, 'photo-maps').click();
  await expect(win.getByRole('dialog', { name: 'Create maps from photos' })).toBeVisible();
  await expect(chooser).toHaveCount(0);
});

test('without a project the tasks say what they need, and the keyboard reaches them', async ({
  win,
}) => {
  await jobsNav(win).click();
  await expect(win.getByTestId('create-maps')).toBeDisabled();
  await expect(win.getByRole('region', { name: 'Jobs' })).toContainText('Open a project first.');
  await win.getByRole('button', { name: 'New job', exact: true }).click();
  const maps = task(win, 'photo-maps');
  await expect(maps).toHaveAttribute('aria-disabled', 'true');
  await expect(maps).toContainText('Open a project first.');
  // it stays focusable, so the reason is read out; pressing it does nothing
  await maps.focus();
  await expect(maps).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(win.getByRole('dialog', { name: 'Create maps from photos' })).toHaveCount(0);
  await expect(win.getByTestId('job-chooser')).toBeVisible();
  // a new stockpile project needs nothing open: it opens the new project wizard
  const stockpiles = task(win, 'stockpiles');
  await expect(stockpiles).toHaveAttribute('aria-disabled', 'false');
  await stockpiles.focus();
  await win.keyboard.press('Enter');
  await expect(win.getByRole('dialog', { name: /New project/ })).toBeVisible();
});

test('each task lands on the screen that guides the work', async ({ demoProject }) => {
  test.setTimeout(120_000);
  const { win } = demoProject;
  const open = async (id: string) => {
    await jobsNav(win).click();
    await win.getByRole('button', { name: 'New job', exact: true }).click();
    await expect(task(win, id)).toHaveAttribute('aria-disabled', 'false');
    await task(win, id).click();
  };

  // two survey dates: the Changes tab of the right panel
  await open('changes');
  await expect(win.getByTestId('tab-changes')).toHaveAttribute('aria-selected', 'true');

  await open('site-cut-fill');
  await expect(win.getByTestId('survey-site')).toBeVisible();
  await win.keyboard.press('Escape');

  await open('survey-check');
  await expect(win.getByTestId('qa-panel')).toBeVisible();
  // the panel floats over the left edge of the window: close it before going on
  await win.getByTestId('qa-panel').getByRole('button', { name: 'Close' }).click();

  await open('overlays');
  await expect(win.getByTestId('overlays-panel')).toBeVisible();
  await win.getByRole('button', { name: 'Close the overlays' }).click();

  await open('export');
  await expect(win.getByTestId('survey-export-dialog')).toBeVisible();
  await win.keyboard.press('Escape');

  await open('model');
  await expect(win.getByTestId('model-builder')).toBeVisible();
});
