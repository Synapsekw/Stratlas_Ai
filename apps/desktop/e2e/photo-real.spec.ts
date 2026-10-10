/**
 * Process photos on the real pipelines (M10 G2 alignment and georeferencing): G8's synthetic
 * mini flight (`python/tests/photo_synth.py --mini`, 20 nadir photos and five bad ones at
 * 960 x 720 over a fictional desert site) in a folder outside the project, aligned by COLMAP,
 * marked on its photos read through main, adjusted on the control points and judged on the
 * checkpoints. The stand-in specs (`photo-process.spec.ts`, `gcp-marking.spec.ts`) cover the app's
 * side in seconds; this one proves the pipelines behind it.
 *
 * Needs the development Python with the COLMAP engine of `photo.align`: pycolmap, which
 * `uv sync` installs from PyPI since 8 Oct 2026 (or another Python named by `AIO_COLMAP_PYTHON`),
 * so the engine is here wherever `uv sync` ran. The test is opt-in: it runs only with
 * `QUADRION_E2E_PHOTO_REAL=1`, which also makes a missing tool a failure. Not in CI yet: with the
 * real alignment the marker predicts GCP1 of the mini flight in two photos, not the three the
 * script confirms, and the point cannot be switched off (8 Oct 2026, a follow-up). Synthetic data
 * only.
 */
import { ProjectManifest } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, PIPELINE_ENV, test as base, VENV_PYTHON, type DataRoot } from './fixtures';
import type { PhotoTruth } from './m10Fixtures';
import {
  chooseFolder,
  colmapPython,
  missingRealPhotoTools,
  openOptions,
  openWizard,
  PHOTO_REAL,
  runId,
} from './photoPack';

const REPO = join(import.meta.dirname, '..', '..', '..');
const MISSING = missingRealPhotoTools();
const PROJECT = { id: 'e2e-real-photos', name: 'E2E real photo site' } as const;

interface RealSite {
  flight: string;
  csv: string;
  truth: PhotoTruth;
}

/** The mini flight in `<data root>/flights/mini flight/` and a project at its site. */
async function writeRealSite(dataRoot: DataRoot): Promise<RealSite> {
  const set = join(dataRoot.root, 'flights', 'mini flight');
  execFileSync(
    VENV_PYTHON,
    [join(REPO, 'python', 'tests', 'photo_synth.py'), '--mini', '--out', set],
    { stdio: 'ignore', timeout: 600_000 },
  );
  const truth = JSON.parse(await readFile(join(set, 'truth.json'), 'utf8')) as PhotoTruth;
  const dir = join(dataRoot.root, 'projects', PROJECT.id);
  await mkdir(dir, { recursive: true });
  const manifest = ProjectManifest.parse({
    schema: 'aio.project/1',
    id: PROJECT.id,
    name: PROJECT.name,
    customer: 'E2E',
    site: 'Fictional desert site (synthetic photogrammetry data)',
    crs: truth.site.crs,
    origin: truth.site.origin,
    captures: [{ id: 'c1', label: 'Photo survey', date: '2026-03-14' }],
    layers: [],
    severityModels: [],
    classCatalogues: [],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
  return { flight: join(set, 'photos'), csv: join(set, 'gcp.csv'), truth };
}

const test = base.extend<{ realSite: RealSite; appEnv: Record<string, string> }>({
  realSite: async ({ dataRoot }, use) => {
    await use(await writeRealSite(dataRoot));
  },
  appEnv: async ({ realSite }, use) => {
    expect(realSite.flight).toBeTruthy();
    const colmap = colmapPython();
    await use({ ...PIPELINE_ENV, ...(colmap ? { AIO_COLMAP_PYTHON: colmap } : {}) });
  },
});

test.describe('real photo pipelines', () => {
  if (PHOTO_REAL && MISSING)
    test('the real photo pipelines are here (QUADRION_E2E_PHOTO_REAL=1)', () => {
      throw new Error(`QUADRION_E2E_PHOTO_REAL=1 but this machine lacks ${MISSING}`);
    });
  test.skip(!PHOTO_REAL, 'Opt-in: set QUADRION_E2E_PHOTO_REAL=1 to run the real photo pipelines');
  test.skip(MISSING !== null, `The real photo pipelines need ${MISSING ?? ''}`);

  test('a flight in a folder aligns, is marked, adjusts and meets the checkpoint targets', async ({
    app,
    win,
    dataRoot,
    realSite,
  }) => {
    test.setTimeout(30 * 60_000);
    await win.getByTestId('project-card').filter({ hasText: PROJECT.name }).first().click();
    // the project has no photos layer: the dialog opens straight on the folders
    const wizard = await openWizard(win);
    await chooseFolder(app, wizard, realSite.flight);
    await expect(wizard.getByTestId('photo-summary')).toContainText('1 camera', {
      timeout: 60_000,
    });
    const options = await openOptions(wizard);
    await expect(options.getByTestId('photo-groups')).toContainText('Stratlas Synthetic');
    await options.getByText('I have ground control points').click();
    await options.getByRole('button', { name: /^Quick/ }).click();
    await expect(wizard.getByTestId('photo-estimate')).toContainText(/About|Under/, {
      timeout: 60_000,
    });
    await wizard.getByTestId('photo-start').click();
    const panel = win.getByTestId('photo-run');
    const run = await runId(win);
    await expect(panel.getByRole('region', { name: 'Next steps' })).toContainText(
      'The photos are matched',
      { timeout: 20 * 60_000 },
    );

    // the GCPs of the set, marked where the refined cameras predict them
    await panel.getByRole('tab', { name: 'Ground control' }).click();
    const importer = panel.getByTestId('gcp-import');
    await importer.getByTestId('gcp-file').setInputFiles(realSite.csv);
    await importer.getByTestId('gcp-save').click();
    const table = panel.getByTestId('gcp-table');
    const marker = panel.getByTestId('gcp-marker');
    for (const t of realSite.truth.targets.filter((x) => x.role !== 'blunder')) {
      // a point in fewer than three photos of the flight (GCP4, CHK1) is switched off
      if (t.observations.length < 3) {
        await table.getByRole('checkbox', { name: `Use ${t.id}` }).uncheck();
        continue;
      }
      await table.getByRole('button', { name: `Mark ${t.id}` }).click();
      await expect(marker.getByRole('img', { name: /^Photo / })).toHaveAttribute('src', /^blob:/, {
        timeout: 20_000,
      });
      for (let n = 1; n <= 3; n++) {
        await win.keyboard.press('Enter');
        await expect(marker.getByTestId('marker-count')).toContainText(`${String(n)} of 3`);
      }
      await win.keyboard.press('Escape');
    }
    await table.getByTestId('gcp-adjust').click();
    await expect(panel.getByTestId('photo-job').locator('[data-status="done"]')).toBeVisible({
      timeout: 10 * 60_000,
    });
    await panel.getByRole('tab', { name: 'Accuracy' }).click();
    const report = panel.getByTestId('accuracy-report');
    await expect(report.getByTestId('accuracy-headline')).toContainText('Checkpoint RMSE');
    await expect(report.getByTestId('accuracy-rmse').locator('[data-role="check"]')).toBeVisible();
    const saved = JSON.parse(
      await readFile(
        join(
          dataRoot.root,
          'projects',
          PROJECT.id,
          'photogrammetry',
          run,
          'report',
          'accuracy.json',
        ),
        'utf8',
      ),
    ) as { checkpointsInAdjustment: boolean; points: { role: string }[] };
    expect(saved.checkpointsInAdjustment).toBe(false);
    expect(saved.points.some((p) => p.role === 'check')).toBe(true);
  });
});
