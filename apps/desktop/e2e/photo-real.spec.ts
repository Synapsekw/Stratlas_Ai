/**
 * Process photos on the real pipelines (M10 G2 alignment and georeferencing): G8's synthetic
 * mini flight (`python/tests/photo_synth.py --mini`, 20 nadir photos and five bad ones at
 * 960 x 720 over a fictional desert site) in a folder outside the project, aligned by COLMAP,
 * marked on its photos read through main, adjusted on the control points and judged on the
 * checkpoints. The stand-in specs (`photo-process.spec.ts`, `gcp-marking.spec.ts`) cover the app's
 * side in seconds; this one proves the pipelines behind it.
 *
 * The flight has no RTK: its logged altitudes sit 21.7 m below the survey's height datum, so the
 * GNSS-only cameras are about that far below the surveyed points. The script marks as a person
 * does, on the target (`truth.json` knows where it is in each photo) and never on the ring: the
 * first two marks of a point go by the photos the marker offers, and from then on the point is
 * triangulated, so every aligned photo that sees it has to be in the list with its ring on the
 * target. What is expected of a point follows from the alignment the run made (the photos it
 * registered), not from a count written here.
 *
 * Needs the development Python with the COLMAP engine of `photo.align`: pycolmap, which
 * `uv sync` installs from PyPI since 8 Oct 2026 (or another Python named by `AIO_COLMAP_PYTHON`),
 * so the engine is here wherever `uv sync` ran. The test is opt-in: it runs only with
 * `QUADRION_E2E_PHOTO_REAL=1`, which also makes a missing tool a failure. Synthetic data only.
 */
import { ProjectManifest } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
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

/** Marks a point needs before Adjust (the app's `MIN_MARKS`). */
const MARKS = 3;
type Observation = PhotoTruth['targets'][number]['observations'][number];

/** Where the marker draws its prediction ring in the photo shown, and how wide: original pixels. */
async function ring(marker: Locator): Promise<{ at: [number, number]; radius: number }> {
  const el = marker.getByTestId('prediction-ring');
  const [x = Number.NaN, y = Number.NaN] = ((await el.getAttribute('data-px')) ?? '')
    .split(',')
    .map(Number);
  return { at: [x, y], radius: Number(await el.getAttribute('r')) };
}

/**
 * Mark the open point in `MARKS` photos as a person does: zoom in, click the centre of the target
 * (`seen`: where the truth has it in the aligned photos), Enter. A photo the target is not in is
 * skipped. With two marks the point is triangulated: the ring of every later photo is on the
 * target, and every photo of `seen` is in the list.
 */
async function markPoint(
  win: Page,
  marker: Locator,
  seen: Observation[],
  size: [number, number],
): Promise<void> {
  const viewer = marker.getByTestId('marker-viewer');
  await expect(viewer).toBeFocused();
  for (let k = 0; k < 4; k++) await win.keyboard.press('+');
  const shown = marker.locator('.ph-mk-list button[aria-current="true"]');
  let confirmed = 0;
  // every photo of the list once is enough: a skip and a mark both move on to an unmarked photo
  for (let tries = 0; confirmed < MARKS && tries < 25; tries++) {
    const name = (await shown.locator('.mono').innerText()).trim();
    const at = seen.find((o) => o.photo === name)?.px;
    if (!at) {
      await win.keyboard.press('s');
      await expect(shown.locator('.mono')).not.toHaveText(name);
      continue;
    }
    const img = marker.getByRole('img', { name: `Photo ${name}` });
    await expect
      .poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth), { timeout: 20_000 })
      .toBe(size[0]);
    if (confirmed >= 2) {
      const r = await ring(marker);
      expect(
        Math.hypot(r.at[0] - at[0], r.at[1] - at[1]),
        `the ring of ${name} is on the target once two marks place the point`,
      ).toBeLessThan(r.radius);
    }
    // pan to the target (zoomed in, the photo is four times the viewer) and click its centre
    await viewer.scrollIntoViewIfNeeded();
    const [x = Number.NaN, y = Number.NaN] = await viewer.evaluate(
      (el, [fx, fy]) => {
        const photo = el.querySelector('.ph-mk-img');
        if (!photo) return [];
        const full = photo.getBoundingClientRect();
        el.scrollLeft = fx * full.width - el.clientWidth / 2;
        el.scrollTop = fy * full.height - el.clientHeight / 2;
        const r = photo.getBoundingClientRect();
        return [r.left + fx * r.width, r.top + fy * r.height];
      },
      [at[0] / size[0], at[1] / size[1]] as const,
    );
    await win.mouse.click(x, y);
    await expect(marker.getByTestId('marker-mark')).toBeVisible();
    await win.keyboard.press('Enter');
    confirmed += 1;
    await expect(marker.getByTestId('marker-count')).toContainText(
      `${String(confirmed)} of ${String(MARKS)}`,
    );
    if (confirmed < MARKS) await expect(shown.locator('.mono')).not.toHaveText(name);
  }
  expect(confirmed, 'photos the marker offers that see the point').toBe(MARKS);
  const offered = await marker.locator('.ph-mk-list button .mono').allInnerTexts();
  expect(offered.map((n) => n.trim())).toEqual(expect.arrayContaining(seen.map((o) => o.photo)));
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
  // for the fixtures too: rendering the mini flight takes most of a minute before the app starts
  test.describe.configure({ timeout: 30 * 60_000 });
  if (PHOTO_REAL && MISSING)
    test('the real photo pipelines are here (QUADRION_E2E_PHOTO_REAL=1)', () => {
      throw new Error(`QUADRION_E2E_PHOTO_REAL=1 but this machine lacks ${MISSING}`);
    });
  test.skip(!PHOTO_REAL, 'Opt-in: set QUADRION_E2E_PHOTO_REAL=1 to run the real photo pipelines');
  test.skip(MISSING !== null, `The real photo pipelines need ${MISSING ?? ''}`);

  test('a flight in a folder aligns, is marked on its targets, adjusts and measures its checkpoints', async ({
    app,
    win,
    dataRoot,
    realSite,
  }) => {
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

    // what the alignment registered decides what can be marked: COLMAP leaves photos out
    const runDir = join(dataRoot.root, 'projects', PROJECT.id, 'photogrammetry', run);
    const aligned = JSON.parse(await readFile(join(runDir, 'report', 'align.json'), 'utf8')) as {
      registered: string[];
    };
    const registered = new Set(aligned.registered);
    expect(registered.size).toBeGreaterThanOrEqual(20);
    const size: [number, number] = [realSite.truth.camera.width, realSite.truth.camera.height];

    // the GCPs of the set, marked on their targets in the photos the marker offers
    await panel.getByRole('tab', { name: 'Ground control' }).click();
    const importer = panel.getByTestId('gcp-import');
    await importer.getByTestId('gcp-file').setInputFiles(realSite.csv);
    await importer.getByTestId('gcp-save').click();
    const table = panel.getByTestId('gcp-table');
    const marker = panel.getByTestId('gcp-marker');
    let markedPoints = 0;
    for (const t of realSite.truth.targets.filter((x) => x.role !== 'blunder')) {
      const seen = t.observations.filter((o) => registered.has(o.photo));
      // a point in fewer than three aligned photos (GCP4, CHK1) is switched off, at the click
      if (seen.length < MARKS) {
        const use = table.getByRole('checkbox', { name: `Use ${t.id}` });
        await use.uncheck();
        await expect(use).not.toBeChecked();
        await expect(table.locator(`tr[data-point="${t.id}"]`)).toHaveClass('off');
        continue;
      }
      await table.getByRole('button', { name: `Mark ${t.id}` }).click();
      await markPoint(win, marker, seen, size);
      await win.keyboard.press('Escape');
      await expect(table.getByTestId(`marks-${t.id}`)).toHaveText(`${String(MARKS)} confirmed`);
      markedPoints += 1;
    }
    // four control points and three checkpoints of the mini flight are in three photos or more
    expect(markedPoints).toBeGreaterThanOrEqual(6);
    await expect(table.getByRole('list', { name: 'Before adjusting' })).toHaveCount(0);
    // the marks are saved where they were clicked: on the targets, to the pixel
    interface SavedGcp {
      points: { id: string; marks: { photo: string; px: [number, number]; state: string }[] }[];
    }
    const confirmedMarks = async () =>
      (JSON.parse(await readFile(join(runDir, 'gcp.json'), 'utf8')) as SavedGcp).points.flatMap(
        (p) => p.marks.filter((m) => m.state === 'confirmed').map((m) => ({ ...m, id: p.id })),
      );
    await expect.poll(async () => (await confirmedMarks()).length).toBe(markedPoints * MARKS);
    for (const m of await confirmedMarks()) {
      const truth = realSite.truth.targets.find((t) => t.id === m.id)?.observations ?? [];
      const at = truth.find((o) => o.photo === m.photo)?.px ?? [Number.NaN, Number.NaN];
      expect(Math.hypot(m.px[0] - at[0], m.px[1] - at[1]), `${m.id} in ${m.photo}`).toBeLessThan(1);
    }
    await table.getByTestId('gcp-adjust').click();
    await expect(panel.getByTestId('photo-job').locator('[data-status="done"]')).toBeVisible({
      timeout: 10 * 60_000,
    });
    await panel.getByRole('tab', { name: 'Accuracy' }).click();
    const report = panel.getByTestId('accuracy-report');
    await expect(report.getByTestId('accuracy-headline')).toContainText('Checkpoint RMSE');
    await expect(report.getByTestId('accuracy-rmse').locator('[data-role="check"]')).toBeVisible();
    const saved = JSON.parse(await readFile(join(runDir, 'report', 'accuracy.json'), 'utf8')) as {
      checkpointsInAdjustment: boolean;
      gsdCm: number;
      points: { role: string }[];
      rmse: { check?: { n: number; horizontalM: number } };
    };
    expect(saved.checkpointsInAdjustment).toBe(false);
    expect(saved.points.some((p) => p.role === 'check')).toBe(true);
    // marked on the targets, the checkpoints fit horizontally (the plan's 1.5 GSD). Their heights
    // are reported as they are: this small block, three marks a point, is over the vertical target
    expect(saved.rmse.check?.n).toBeGreaterThanOrEqual(3);
    expect(saved.rmse.check?.horizontalM).toBeLessThan((1.5 * saved.gsdCm) / 100);
  });
});
