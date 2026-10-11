/**
 * Project types in the new project wizard (11 Oct 2026): six cards, each written as the manifest's
 * `purpose` beside the older `type` it maps to, and an empty project that says which data to add
 * first for its type. Projects from before the purpose existed, and one whose purpose a later
 * build wrote, open as before and show what their `type` says.
 */
import type { Page, TestInfo } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataRoot, expect, openProject, test as base } from './fixtures';

const CARDS = [
  'Survey',
  'Construction',
  'Vertical asset inspection',
  'Confined space inspection',
  'Data fusion',
  'Road',
];

/** Projects written by hand, as an older build, a later build and the kit import leave them. */
const OLDER = [
  { id: 'types-older-twin', name: 'Types older twin', extra: { type: 'twin' } },
  {
    id: 'types-later-build',
    name: 'Types later build',
    extra: { type: 'volumetric', purpose: 'tunnel' },
  },
  { id: 'types-no-type', name: 'Types no type', extra: {} },
] as const;

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  dataRoot: async ({}, use) => {
    const data = await createDataRoot();
    for (const p of OLDER) {
      const dir = join(data.root, 'projects', p.id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify(
          {
            schema: 'aio.project/1',
            id: p.id,
            name: p.name,
            crs: { epsg: 32639 },
            origin: [500000, 3200000, 0],
            captures: [],
            layers: [],
            severityModels: [],
            classCatalogues: [],
            ...p.extra,
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(dir, 'issues.json'),
        JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
      );
    }
    await use(data);
    await rm(data.base, { recursive: true, force: true });
  },
});

const hint = (win: Page) => win.getByTestId('empty-project');

/** A screenshot for a person to look at (QUADRION_E2E_SHOTS picks the folder). */
async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  // two frames, so what was just laid out has been drawn
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

async function toProjects(win: Page) {
  await win.keyboard.press('Control+K');
  const box = win.getByRole('dialog', { name: 'Command search' }).getByRole('combobox');
  await box.fill('Go to Projects');
  await win.keyboard.press('Enter');
  await expect(win.getByTestId('project-card').first()).toBeVisible();
}

async function open(win: Page, name: string) {
  await win.getByTestId('project-card').filter({ hasText: name }).click();
  await expect(win.locator('.crumbs')).toContainText(name);
  await expect(hint(win)).toBeVisible({ timeout: 30_000 });
}

test('the wizard offers six types, and the project keeps the one picked', async ({
  win,
  dataRoot,
}, info) => {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Types e2e tank');
  const cards = wiz.getByRole('group', { name: 'Project type' }).getByRole('button');
  await expect(cards).toHaveCount(CARDS.length);
  for (const [i, label] of CARDS.entries()) {
    await expect(cards.nth(i).locator('b')).toHaveText(label);
    // one line that says what the type is for
    await expect(cards.nth(i).locator('small')).toHaveText(/\S.{20,}/);
  }
  // the card it starts on writes `inspection`, the type the wizard always started on
  const pressed = wiz.getByRole('group', { name: 'Project type' }).locator('[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  await expect(pressed.locator('b')).toHaveText('Vertical asset inspection');

  await cards.filter({ hasText: /^Confined space inspection/ }).click();
  await expect(pressed.locator('b')).toHaveText('Confined space inspection');
  await shot(win, info, 'project-types-wizard.png');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('25.1000, 55.2000, 12');
  await expect(wiz.getByTestId('origin-readout')).toContainText('E 3');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  // the review step names the type, and an inspection has no survey data block
  await expect(wiz.locator('.b-summary')).toContainText('Confined space inspection');
  await expect(wiz.getByText('Survey data')).toHaveCount(0);
  await wiz.getByRole('button', { name: 'Create project' }).click();

  await expect(hint(win)).toBeVisible({ timeout: 30_000 });
  const file = join(dataRoot.root, 'projects', 'types-e2e-tank', 'manifest.json');
  const created = JSON.parse(await readFile(file, 'utf8')) as { type: string; purpose: string };
  expect(created.type).toBe('inspection');
  expect(created.purpose).toBe('confined-space');

  // the empty project names its type and says which data to add first
  await expect(hint(win).getByTestId('project-kind')).toHaveText('Confined space inspection');
  const starter = hint(win).getByTestId('project-starter');
  await expect(starter).toContainText('Add first');
  await expect(starter.getByRole('listitem')).toHaveCount(3);
  await expect(starter.getByRole('listitem').first()).toContainText('Photos from inside');
  // and the list did not push the button out of reach: a click on it lands on it
  const importFiles = hint(win).getByRole('button', { name: 'Import files' });
  await expect(importFiles).toBeVisible();
  const reached = await importFiles.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at !== null && el.contains(at);
  });
  expect(reached, 'Import files is covered or outside the window').toBe(true);
  await shot(win, info, 'project-types-empty.png');
});

test('a survey project still starts from its survey data', async ({ win, dataRoot }) => {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Types e2e yard');
  await wiz
    .getByRole('group', { name: 'Project type' })
    .getByRole('button', { name: /^Survey/ })
    .click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('25.1000, 55.2000, 12');
  await expect(wiz.getByTestId('origin-readout')).toContainText('E 3');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await expect(wiz.locator('.b-summary')).toContainText('Survey');
  // the block the Volumetric type had: Survey writes the same `type`
  await expect(wiz.getByRole('button', { name: 'Add a second survey date' })).toBeVisible();
  await wiz.getByRole('button', { name: 'Create project' }).click();

  await expect(hint(win)).toBeVisible({ timeout: 30_000 });
  const file = join(dataRoot.root, 'projects', 'types-e2e-yard', 'manifest.json');
  const created = JSON.parse(await readFile(file, 'utf8')) as { type: string; purpose: string };
  expect(created.type).toBe('volumetric');
  expect(created.purpose).toBe('survey');
  await expect(hint(win).getByTestId('project-kind')).toHaveText('Survey');
  await expect(hint(win).getByTestId('project-starter')).toContainText('GeoTIFF');
});

test('projects without a purpose, or with one of a later build, open as before', async ({
  win,
  dataRoot,
}) => {
  // an older project: its type says what to show
  await open(win, 'Types older twin');
  await expect(hint(win).getByTestId('project-kind')).toHaveText('Digital twin');
  await expect(hint(win).getByTestId('project-starter').getByRole('listitem')).toHaveCount(4);

  // a purpose this build does not know: the project opens and shows what its type says
  await toProjects(win);
  await open(win, 'Types later build');
  await expect(hint(win).getByTestId('project-kind')).toHaveText('Survey');
  // and a save by this build keeps the later build's value in the file
  const { id } = await openProject(win);
  expect(id).toBe('types-later-build');
  const saved = await win.evaluate(
    (projectId) => window.aio.invoke('builder:ensureCapture', { projectId, date: '2026-02-03' }),
    'types-later-build',
  );
  expect(saved.ok, saved.ok ? '' : saved.error).toBe(true);
  const file = join(dataRoot.root, 'projects', 'types-later-build', 'manifest.json');
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as {
    type: string;
    purpose: string;
    captures: unknown[];
  };
  expect(onDisk.captures).toHaveLength(1);
  expect(onDisk.type).toBe('volumetric');
  expect(onDisk.purpose).toBe('tunnel');

  // no type at all (an imported kit project): the hint as it always was
  await toProjects(win);
  await open(win, 'Types no type');
  await expect(hint(win)).toContainText('Add raw data to Types no type');
  await expect(hint(win).getByTestId('project-kind')).toHaveCount(0);
  await expect(hint(win).getByTestId('project-starter')).toHaveCount(0);
});
