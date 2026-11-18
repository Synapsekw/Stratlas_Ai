/**
 * Tools shown by project type (founder, 18 Nov 2026) in the real app. A tool set (Earthworks,
 * Road, Telecom, Thermal) is part of a project or it is not: a confined space project with a model
 * has no Telecom measuring family, no Coverage and no Survey checks, in the Tools tab or the
 * command palette; a telecom project has them; Settings, Project settings, Tool sets adds a set
 * to a project and takes it away again, saved in the project; a project that already holds an
 * antenna inventory keeps its telecom tools whatever its type, with the switch locked on; and
 * thermal photos bring the Thermal section by themselves. Terrain analysis and Engineering are in
 * every project. The inventory is the synthetic RF fixture and the thermal photos are synthetic;
 * only the thermal test needs the development Python (to write and read its photos).
 */
import { ProjectManifest } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { measureBench } from './island';
import { openSection, panelSection } from './panel';
import { writeRfProject } from './rfFixtures';
import { createThermalProject, openThermalProject } from './thermalFixture';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

async function openTiny(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

const manifestOf = async (dir: string) =>
  ProjectManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

/** Write the project type (`purpose`) into the project the fixture wrote. */
async function setPurpose(dir: string, purpose: string): Promise<void> {
  const manifest = await manifestOf(dir);
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse({ ...manifest, purpose })),
  );
}

/** The sections of the Tools tab, in the order shown. */
async function toolSections(win: Page): Promise<(string | null)[]> {
  const tools = await openSection(win, 'tools');
  await expect(panelSection(win, 'tools.view')).toBeVisible();
  return tools
    .locator('[data-section]')
    .evaluateAll((all) => all.map((s) => s.getAttribute('data-section')));
}

/**
 * Search the command palette for a word. `there` is a row the word must list (the expectation
 * waits for it, so the list has settled on the word), and only then are the `gone` rows checked
 * to be absent from that same list. Closes the palette.
 */
async function paletteLists(
  win: Page,
  word: string,
  there: readonly RegExp[],
  gone: readonly RegExp[] = [],
): Promise<void> {
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await win.keyboard.press('Control+K');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(word);
  for (const name of there) await expect(palette.getByRole('option', { name })).toHaveCount(1);
  for (const name of gone) await expect(palette.getByRole('option', { name })).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(palette).toBeHidden();
}

type SetName = 'earthworks' | 'road' | 'telecom' | 'thermal';

/** Settings, Project settings: the Tool sets block. */
async function openToolSets(win: Page) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .locator('button', { hasText: 'Project settings' })
    .click();
  const block = win.getByTestId('project-tool-sets');
  await expect(block).toBeVisible();
  return block;
}

const toolSwitch = (win: Page, set: SetName) =>
  win.getByTestId(`tool-set-${set}`).getByRole('switch');

async function backToScene(win: Page): Promise<void> {
  await win.getByTestId('rail-scene').click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

test('a confined space project has no telecom, coverage or survey check tools', async ({
  win,
  dataRoot,
}) => {
  await setPurpose(dataRoot.projectDir, 'confined-space');
  await openTiny(win);

  // the project holds a model: before, that alone showed Coverage and Survey checks
  const sections = await toolSections(win);
  expect(sections).toEqual(
    expect.arrayContaining([
      'tools.view',
      'tools.measure',
      'tools.annotate',
      'tools.terrain',
      'tools.engineering',
      'tools.environment',
    ]),
  );
  for (const gone of [
    'tools.coverage',
    'tools.thermal',
    'tools.checks',
    'tools.volumes',
    'tools.road',
  ])
    expect(sections, gone).not.toContain(gone);

  // Measure: the families of every project, and no Telecom family
  await measureBench(win);
  await expect(win.getByTestId('wb-section-polygon')).toHaveCount(1);
  await expect(win.getByTestId('wb-section-telecom')).toHaveCount(0);
  await expect(win.locator('[data-testid^="telecom-tool-"]')).toHaveCount(0);

  // the palette does not find them either: "measure" lists the measuring tools of the project
  // (the telecom test below sees the three telecom tools in this same list)
  await paletteLists(
    win,
    'measure',
    [/^Measure: Distance/, /^Measure: Area/],
    [/^Measure: Antenna azimuth/, /^Measure: Physical tilt/, /^Measure: Clearance/],
  );

  // right-click the model: the engineering model is in every project, and no action of a tool
  // set that is not part of this one is offered
  await win.getByTestId('tree-row-quad').first().click({ button: 'right' });
  const menu = win.getByRole('menu').first();
  await expect(menu.getByTestId('menu-create-engineering')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Coverage|thermal|antenna/i })).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('a telecom project has the Telecom family and Coverage', async ({ win, dataRoot }) => {
  await setPurpose(dataRoot.projectDir, 'telecom');
  await openTiny(win);

  const sections = await toolSections(win);
  expect(sections).toContain('tools.coverage');
  expect(sections).toContain('tools.engineering');
  expect(sections).toContain('tools.terrain');
  // not the sets of other lines of work
  expect(sections).not.toContain('tools.thermal');
  expect(sections).not.toContain('tools.checks');

  await measureBench(win);
  const telecom = win.getByTestId('wb-section-telecom');
  await expect(telecom).toHaveCount(1);
  const head = telecom.locator('.wb-section-head').first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  for (const tool of ['azimuth', 'antenna-tilt', 'clearance'])
    await expect(win.getByTestId(`telecom-tool-${tool}`)).toBeVisible();

  await paletteLists(win, 'measure', [
    /^Measure: Distance/,
    /^Measure: Antenna azimuth/,
    /^Measure: Physical tilt/,
    /^Measure: Clearance/,
  ]);
});

test('Tool sets in Project settings adds a set to a project and takes it away again', async ({
  win,
  dataRoot,
}) => {
  await setPurpose(dataRoot.projectDir, 'survey');
  await openTiny(win);
  expect(await toolSections(win)).not.toContain('tools.coverage');
  await measureBench(win);
  await expect(win.getByTestId('wb-section-telecom')).toHaveCount(0);

  // the switches start as the project type gives them: a survey has Earthworks
  await openToolSets(win);
  await expect(toolSwitch(win, 'earthworks')).toHaveAttribute('aria-checked', 'true');
  for (const set of ['road', 'telecom', 'thermal'] as const)
    await expect(toolSwitch(win, set)).toHaveAttribute('aria-checked', 'false');

  // Telecom on: saved in the project, and the tools are there without a restart
  await toolSwitch(win, 'telecom').click();
  await expect(toolSwitch(win, 'telecom')).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(async () => (await manifestOf(dataRoot.projectDir)).toolSets)
    .toEqual(['earthworks', 'telecom']);
  await backToScene(win);
  expect(await toolSections(win)).toContain('tools.coverage');
  await measureBench(win);
  await expect(win.getByTestId('wb-section-telecom')).toHaveCount(1);

  // and off again: gone, and nothing else changed
  await openToolSets(win);
  await toolSwitch(win, 'telecom').click();
  await expect(toolSwitch(win, 'telecom')).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(async () => (await manifestOf(dataRoot.projectDir)).toolSets)
    .toEqual(['earthworks']);
  await backToScene(win);
  const after = await toolSections(win);
  expect(after).not.toContain('tools.coverage');
  expect(after).toContain('tools.checks');
  await measureBench(win);
  await expect(win.getByTestId('wb-section-telecom')).toHaveCount(0);
});

test('Earthworks shows Volumes before the first pile; Road shows nothing without a road', async ({
  win,
  dataRoot,
}) => {
  await setPurpose(dataRoot.projectDir, 'confined-space');
  await openTiny(win);
  expect(await toolSections(win)).not.toContain('tools.volumes');
  await openSection(win, 'project');
  await expect(panelSection(win, 'project.volumes')).toHaveCount(0);

  // Earthworks on: Volumes is there, with its empty state, though the project holds no pile
  const block = await openToolSets(win);
  await expect(block).toContainText('empty until the first pile is drawn');
  await toolSwitch(win, 'earthworks').click();
  await expect(toolSwitch(win, 'earthworks')).toHaveAttribute('aria-checked', 'true');
  await backToScene(win);
  const sections = await toolSections(win);
  expect(sections).toContain('tools.volumes');
  expect(sections).toContain('tools.checks');
  const volumes = await openSection(win, 'project', 'project.volumes');
  await expect(volumes.getByTestId('volumes-bench')).toBeVisible();
  // its empty state offers the way to the first pile
  await expect(volumes.getByTestId('volumes-draw')).toBeVisible();

  // Road on: the switch says what happens, and nothing shows, because this is not a road project
  await openToolSets(win);
  await expect(block).toContainText('a road is built only in a Road project');
  await toolSwitch(win, 'road').click();
  await expect(toolSwitch(win, 'road')).toHaveAttribute('aria-checked', 'true');
  await backToScene(win);
  expect(await toolSections(win)).not.toContain('tools.road');
  await openSection(win, 'project');
  await expect(panelSection(win, 'project.road')).toHaveCount(0);
});

test('a survey project that holds an antenna inventory keeps its telecom tools, switch locked on', async ({
  win,
  dataRoot,
}) => {
  await writeRfProject(dataRoot.projectDir, { cloud: true });
  await setPurpose(dataRoot.projectDir, 'survey');
  await openTiny(win);

  // its records bring Telecom: Coverage, the measuring family and the antenna list
  await expect.poll(() => toolSections(win)).toContain('tools.coverage');
  await measureBench(win);
  await expect(win.getByTestId('wb-section-telecom')).toHaveCount(1);
  await openSection(win, 'project', 'project.inThisProject');
  await expect(win.getByTestId('wb-section-project-antennas')).toHaveCount(1);

  // the switch is on and cannot be turned off, and says why
  const block = await openToolSets(win);
  await expect(toolSwitch(win, 'telecom')).toHaveAttribute('aria-checked', 'true');
  await expect(toolSwitch(win, 'telecom')).toBeDisabled();
  await expect(block).toContainText('On: this project holds antennas or telecom measurements.');
  await expect(toolSwitch(win, 'earthworks')).toBeEnabled();
  // nothing was written: the project's file still names no tool sets
  expect((await manifestOf(dataRoot.projectDir)).toolSets).toBeUndefined();
});

const thermalTest = test.extend<{ thermal: { dir: string } }>({
  thermal: async ({ dataRoot }, use) => {
    await use(await createThermalProject(dataRoot.root, 'confined-space'));
  },
});
thermalTest.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x720' } });
thermalTest.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

thermalTest(
  'thermal photos bring the Thermal section into a confined space project',
  async ({ thermal, win }) => {
    expect((await manifestOf(thermal.dir)).purpose).toBe('confined-space');
    await openThermalProject(win);
    // the photo sets are read when the project opens; the section follows the answer
    await expect.poll(() => toolSections(win), { timeout: 60_000 }).toContain('tools.thermal');
    expect(await toolSections(win)).not.toContain('tools.coverage');
    const block = await openToolSets(win);
    await expect(toolSwitch(win, 'thermal')).toHaveAttribute('aria-checked', 'true');
    await expect(toolSwitch(win, 'thermal')).toBeDisabled();
    await expect(block).toContainText('On: this project holds thermal photos.');
  },
);
