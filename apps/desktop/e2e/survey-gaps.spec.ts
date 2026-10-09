/**
 * M11 gaps closed after the streams: geoid packs in Settings (import G13's synthetic geoid grid,
 * then choose it in Site settings), **Compute from point pairs** (G13's `site_calibration` pairs
 * reproduce the seeded residuals), the Cleanup panel's DTM filter (disabled with the reason on a
 * project without a point cloud), hydrology regions from polygon measurements, and a package of a
 * survey project in player mode: measurements listed and drawn, no edit, run or save controls,
 * the prepared height tiles read through aio://, and no job started.
 *
 * Synthetic only (python/tests/survey_synth.py); skipped without the development pipeline Python.
 * Off-screen, with no network.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  openProject,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
  type DataRoot,
} from './fixtures';
import { prepareSurveys } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

const REPO = join(import.meta.dirname, '..', '..', '..');

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);

/** Run a snippet of python/tests (survey_synth.py) and parse what it prints as JSON. */
function synth(code: string): unknown {
  const out = execFileSync(VENV_PYTHON, ['-c', code], {
    cwd: join(REPO, 'python', 'tests'),
    encoding: 'utf8',
  });
  return JSON.parse(out) as unknown;
}

async function nextOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, file) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: [file] });
    };
  }, path);
}

async function openTiny(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

async function openDemo(win: Page, p: SurveyDemoProject) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/** The Survey measurements popover (on the toolbar, or under More tools when it is narrow). */
async function openSurveyTools(win: Page) {
  const survey = win.getByRole('button', { name: 'Survey measurements', exact: true });
  if (!(await survey.isVisible())) await win.getByRole('button', { name: 'More tools' }).click();
  await survey.click();
  await expect(win.getByTestId('survey-tools')).toBeVisible();
}

test('a geoid grid imported in Settings is offered in Site settings and removed again', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(120_000);
  const grid = join(dataRoot.base, 'synthetic geoid.tif');
  const truth = synth(
    `import json; from pathlib import Path; from survey_synth import write_geoid_grid, FIXTURE_CRS; print(json.dumps(write_geoid_grid(Path(${JSON.stringify(grid)}), FIXTURE_CRS["utm39n"].lonlat)))`,
  ) as { licence: string; attribution: string };

  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
  const block = win.getByTestId('geoid-packs');
  await expect(block).toBeVisible();
  await nextOpenDialog(app, grid);
  await block.getByTestId('geoid-import-open').click();
  const form = block.getByTestId('geoid-import');
  await expect(form.getByTestId('geoid-import-name')).toHaveValue('synthetic geoid');
  // the licence and the attribution are the person's to state
  await expect(form.getByTestId('geoid-import-save')).toBeDisabled();
  await form.getByTestId('geoid-import-name').fill('Synthetic geoid');
  await form.getByTestId('geoid-import-licence').fill(truth.licence);
  await form.getByTestId('geoid-import-attribution').fill(truth.attribution);
  await form.getByTestId('geoid-import-verticalEpsg').fill('5773');
  await form.getByTestId('geoid-import-save').click();
  const row = block.getByTestId('geoid-pack-Synthetic-geoid');
  await expect(row).toBeVisible();
  await expect(row).toContainText(truth.licence);
  await expect(row).toContainText(truth.attribution);
  await expect(row).toContainText('EPSG 5773');
  await expect(row).toContainText('°E to');
  const meta = JSON.parse(
    await readFile(join(dataRoot.root, 'packs', 'geoid', 'Synthetic-geoid.json'), 'utf8'),
  ) as { imported: boolean; licence: string; verticalEpsg: number };
  expect(meta).toMatchObject({ imported: true, licence: truth.licence, verticalEpsg: 5773 });

  // Site settings, Heights lists it; choosing it is saved with the site
  await openTiny(win);
  await win.getByTestId('site-settings-open').click();
  const dlg = win.getByTestId('site-settings');
  await expect(dlg.locator('[data-testid="site-vertical"] option')).toContainText([
    'Synthetic geoid geoid',
  ]);
  await dlg.getByTestId('site-vertical').selectOption('geoid:Synthetic-geoid');
  await dlg.getByTestId('site-settings-save').click();
  await expect(dlg).toBeHidden();
  const settings = JSON.parse(
    await readFile(join(dataRoot.projectDir, 'survey', 'settings.json'), 'utf8'),
  ) as { verticalDatum: unknown };
  expect(settings.verticalDatum).toEqual({ kind: 'geoid', geoid: 'Synthetic-geoid' });

  // Remove asks once more, then the pack is gone
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
  await block.getByTestId('geoid-remove-Synthetic-geoid').click();
  await block.getByTestId('geoid-remove-confirm-Synthetic-geoid').click();
  await expect(block.getByTestId('geoid-pack-Synthetic-geoid')).toHaveCount(0);
});

test('point pairs from a CSV compute the calibration with the seeded residuals', async ({
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const cal = synth(
    [
      'import json',
      'from survey_synth import site_calibration',
      'c = site_calibration()',
      'rows = ["name,grid N,grid E,grid Z,local N,local E,local Z,H,V"]',
      'rows += [",".join([p["name"], *(repr(v) for v in p["grid"]), *(repr(v) for v in p["local"]), "1", "1"]) for p in c["pairs"]]',
      'print(json.dumps({"rmsH": c["rmsH"], "rmsV": c["rmsV"], "csv": "\\n".join(rows), "pairs": [{k: p[k] for k in ("name", "residualH", "residualV")} for p in c["pairs"]]}))',
    ].join('\n'),
  ) as {
    rmsH: number;
    rmsV: number;
    csv: string;
    pairs: { name: string; residualH: number; residualV: number }[];
  };

  await openTiny(win);
  await win.getByTestId('site-settings-open').click();
  const dlg = win.getByTestId('site-settings');
  await dlg.getByTestId('site-calibration-pairs').click();
  const editor = dlg.getByTestId('site-pairs');
  await editor.getByTestId('site-pairs-file').setInputFiles({
    name: 'site pairs.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(cal.csv, 'utf8'),
  });
  await expect(editor.getByTestId('site-pairs-note')).toContainText('5 pairs read');
  await expect(editor.getByTestId('site-pairs-kind')).toHaveValue('grid');
  await expect(editor.getByTestId('site-pairs-table').locator('tbody tr')).toHaveCount(5);
  await editor.getByTestId('site-pairs-compute').click();
  await expect(dlg.getByTestId('site-calibration-state')).toContainText('draft, not applied', {
    timeout: 120_000,
  });
  const table = dlg.getByTestId('site-residuals');
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(table).toContainText('CAL1');
  // computed from pairs: no controller columns
  await expect(table.locator('thead th')).toHaveCount(4);

  const written = JSON.parse(
    await readFile(join(dataRoot.projectDir, 'survey', 'calibration.json'), 'utf8'),
  ) as {
    source: { format: string };
    rmsH: number;
    rmsV: number;
    pairs: { name: string; residualH: number; residualV: number }[];
  };
  expect(written.source.format).toBe('pairs');
  expect(written.rmsH).toBeCloseTo(cal.rmsH, 5);
  expect(written.rmsV).toBeCloseTo(cal.rmsV, 5);
  for (const p of cal.pairs) {
    const got = written.pairs.find((x) => x.name === p.name);
    expect(got?.residualH, p.name).toBeCloseTo(p.residualH, 5);
    expect(got?.residualV, p.name).toBeCloseTo(p.residualV, 5);
  }

  await dlg.getByTestId('site-calibration-apply').click();
  await expect(dlg.getByTestId('site-calibration-state')).toHaveText(/: applied$/);
});

test('a package of a survey project shows its measurements read only, drawn, with no jobs', async ({
  surveyProject,
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(600_000);
  await openDemo(win, surveyProject);
  await prepareSurveys(win, surveyProject.dir);

  // the DTM filter needs a point cloud: this project has none, and the panel says so
  await openSurveyTools(win);
  await win.getByRole('button', { name: 'Survey QA and cleanup' }).click();
  await win.getByTestId('survey-qa-open-cleanup').click();
  const cleanup = win.getByTestId('cleanup-panel');
  await expect(cleanup.getByTestId('dtm-filter-run')).toBeDisabled();
  await expect(cleanup.getByTestId('dtm-filter-why')).toContainText('has none');
  await cleanup.getByRole('button', { name: 'Close' }).click();

  // hydrology regions come from the polygon measurements
  await openSurveyTools(win);
  await win.getByRole('button', { name: 'Hydrology', exact: true }).click();
  const hydro = win.getByTestId('hydro-panel');
  await expect(hydro).toBeVisible();
  const pick = hydro.getByTestId('hydro-region-pick');
  await expect(pick.locator('option')).toHaveText([
    'Whole surface',
    'Cone (synthetic)',
    'Frustum (synthetic)',
    'Paraboloid (synthetic)',
    'Prism (synthetic)',
    'Wedge (synthetic)',
  ]);
  await pick.selectOption({ label: 'Cone (synthetic)' });
  await expect(pick).toHaveValue('m-cone');
  await expect(hydro.getByTestId('hydro-region-need')).toHaveCount(0);
  await win.keyboard.press('Escape');

  // export the package
  const file = join(dataRoot.base, 'survey.aio');
  await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
  await win.getByTestId('export-package').click();
  const exportDlg = win.getByTestId('package-export');
  await expect(exportDlg.getByTestId('pkg-size')).not.toContainText('...');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
  await exportDlg.getByTestId('pkg-export').click();
  await expect(exportDlg.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });

  // a customer machine: empty data folder, the package passed as by a double-click
  const customer: DataRoot = {
    base: dataRoot.base,
    root: join(dataRoot.base, 'customer-data'),
    userData: join(dataRoot.base, 'customer-user'),
    projectId: '',
    projectDir: '',
  };
  await mkdir(customer.root, { recursive: true });
  const network = new NetworkGuard();
  const player = await launchApp(customer, PIPELINE_ENV, [file]);
  try {
    await network.attach(player);
    const pw = await player.firstWindow();
    await pw.waitForLoadState('domcontentloaded');
    await expect(pw.getByTestId('welcome')).toContainText(surveyProject.name);
    await expect(pw.getByTestId('readonly-chip')).toHaveText('Read-only package');
    await pw.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
    await expect(pw.locator('[data-scene-view] canvas').first()).toBeVisible();

    // no drawing tools, templates or units; the list shows the five measurements
    await openSurveyTools(pw);
    const tools = pw.getByTestId('survey-tools');
    await expect(tools.getByTestId('survey-tools-readonly')).toBeVisible();
    await expect(tools.locator('[data-testid^="survey-tool-"]')).toHaveCount(0);
    await expect(tools.getByTestId('survey-units-open')).toHaveCount(0);
    await expect(tools.getByTestId('survey-templates-open')).toHaveCount(0);
    await tools.getByTestId('survey-list-open').click();
    const list = pw.getByTestId('survey-list');
    await expect(list.getByTestId('survey-item')).toHaveCount(5);
    await expect(list).toContainText('Cone (synthetic)');
    await expect(list.getByTestId('survey-list-readonly')).toBeVisible();
    await expect(list.getByTestId('survey-list-save')).toHaveCount(0);

    // drawn in the 3D view
    await expect
      .poll(
        () =>
          pw.evaluate(() => {
            const st = (
              window as unknown as {
                __stratlas: {
                  stage: () => {
                    scene: { getObjectByName(n: string): { children: unknown[] } | undefined };
                  } | null;
                };
              }
            ).__stratlas.stage();
            return st?.scene.getObjectByName('aio-survey-measurements')?.children.length ?? 0;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // the properties are read only: no delete, no vertex editing, the label cannot be typed in
    await list.locator('[data-id="m-cone"] .sv-item-main').click();
    const panel = pw.getByTestId('survey-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('survey-label')).toHaveAttribute('readonly', '');
    await expect(panel.getByRole('button', { name: 'Delete measurement' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Edit vertices in the view' })).toHaveCount(0);

    // the prepared height tiles travel in the package and are read through aio://
    const tile = await pw.evaluate(async () => {
      const w = window as unknown as {
        aio: { invoke(c: string, r: unknown): Promise<unknown> };
        __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
      };
      const projectId = w.__stratlas.workspace.getState().project?.id ?? '';
      const r = (await w.aio.invoke('survey:surfaces', { projectId })) as {
        ok: boolean;
        surfaces?: { id: string; tiles: string[] }[];
      };
      const s = r.surfaces?.[0];
      if (!s?.tiles[0]) return { surfaces: r.surfaces?.length ?? 0, status: 0, bytes: 0 };
      const res = await fetch(
        `aio://project/${encodeURIComponent(projectId)}/survey/surfaces/${s.id}/0/${s.tiles[0]}.bin`,
      );
      return {
        surfaces: r.surfaces?.length ?? 0,
        status: res.status,
        bytes: (await res.arrayBuffer()).byteLength,
      };
    });
    expect(tile.surfaces).toBe(2);
    expect(tile.status).toBe(200);
    expect(tile.bytes).toBeGreaterThan(0);

    // Site settings show, but cannot be saved
    await pw.getByTestId('site-settings-open').click();
    const dlg = pw.getByTestId('site-settings');
    await expect(dlg.getByTestId('site-readonly')).toBeVisible();
    await expect(dlg.getByTestId('site-settings-save')).toHaveCount(0);
    await expect(dlg.getByTestId('site-calibration-import')).toHaveCount(0);
    await expect(dlg.getByTestId('site-vertical')).toBeDisabled();
    await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();

    // player mode never starts a pipeline
    const jobs = (await pw.evaluate(() =>
      (
        window as unknown as { aio: { invoke(c: string, r: unknown): Promise<unknown> } }
      ).aio.invoke('jobs:list', {}),
    )) as { jobs: unknown[] };
    expect(jobs.jobs).toEqual([]);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await player.close();
  }
});
