/**
 * The builder sample datasets end to end (outside the CI suite): each sample folder in
 * QUADRION_SAMPLES (`<real data root>/samples`, written by python/scripts/make_samples.py from
 * client projects, so @realdata) is built into a new project in a temporary data root the way its
 * README says, its pipeline runs from the Jobs panel, and the result is checked against the
 * numbers in its `sample.json`. The samples are only read.
 *
 * The pipelines run in the development venv, or in a pipeline pack with QUADRION_E2E_PACK
 * (e.g. `<real data root>/runtime/pipeline-pack-0.2.0`). The inspection sample takes the HCl
 * severity model from the real HCl project's manifest (realData.ts, read only), as the wizard
 * offers it on a machine that has that project in its library.
 *
 *   QUADRION_SAMPLES="<real data root>/samples" npx playwright test samples --workers=1
 */
import type { Issue, Quat, Vec3 } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, test } from './fixtures';
import { realProjectDir } from './realData';

const SAMPLES = process.env.QUADRION_SAMPLES ?? '';
const PACK = process.env.QUADRION_E2E_PACK ?? '';
const HCL = realProjectDir('hcl').replace(/\\/g, '/');
const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.QUADRION_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));

test.skip(!SAMPLES, 'set QUADRION_SAMPLES to the sample datasets folder');
test.skip(
  !PACK && !existsSync(venvPython),
  `no pipeline runtime (${venvPython} or QUADRION_E2E_PACK)`,
);

/** The pipeline runtime: a pack folder or the development Python. */
const runtimeEnv = (): Record<string, string> =>
  PACK
    ? { QUADRION_PIPELINE_PACK: PACK, QUADRION_PIPELINE_PYTHON: '' }
    : { QUADRION_PIPELINE_PYTHON: venvPython, QUADRION_PIPELINE_PACK: '' };

const sample = <T>(name: string): Promise<T> =>
  readFile(join(SAMPLES, name, 'sample.json'), 'utf8').then((s) => JSON.parse(s) as T);

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;

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

/** Wizard steps 1 and 2: name, type, typed origin (latitude, longitude, height). */
async function wizard(win: Page, name: string, type: RegExp, latLonH: string, epsg: number) {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill(name);
  await wiz
    .getByRole('group', { name: 'Project type' })
    .getByRole('button', { name: type })
    .click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill(latLonH);
  await expect(wiz.getByTestId('origin-readout')).toContainText('E ');
  await expect(
    wiz.getByRole('listbox', { name: 'CRS' }).getByRole('option', { selected: true }),
  ).toContainText(`EPSG:${String(epsg)}`);
  await wiz.getByRole('button', { name: 'Next' }).click();
  return wiz;
}

/** Start a job with `start` and wait until that job (not an earlier one) is done; its id. */
async function runJob(win: Page, start: () => Promise<void>, timeout: number): Promise<string> {
  const list = () => win.evaluate(() => window.aio.invoke('jobs:list', {}));
  const before = new Set((await list()).jobs.map((j) => j.id));
  await start();
  let id = '';
  await expect
    .poll(
      async () => {
        const job = (await list()).jobs.find((j) => !before.has(j.id));
        id = job?.id ?? '';
        return job?.status;
      },
      { timeout },
    )
    .toBe('done');
  return id;
}

// ------------------------------------------------------------------------- inspection-hcl-mini

interface HclSample {
  originLatLon: [number, number];
  origin: [number, number, number];
  epsg: number;
  photos: string[];
  poses: Record<string, { pos: Vec3; q: Quat }>;
  glb: string;
  detections: {
    accepted: number;
    draft: number;
    acceptedFindings: string[];
    draftFindings: string[];
  };
  findings: Record<string, { class: string; severity: number; points: Vec3[] }>;
}

test('@realdata inspection-hcl-mini: photos and model imported, the AI pass placed on the tank', async ({
  dataRoot,
  network,
}) => {
  test.skip(
    !existsSync(join(HCL, 'manifest.json')),
    `no HCl project at ${HCL} for its severity model`,
  );
  test.setTimeout(300_000);
  const dir = join(SAMPLES, 'inspection-hcl-mini');
  const s = await sample<HclSample>('inspection-hcl-mini');
  // the HCl project in the library, for its severity model and classes (manifest only)
  const hcl = await readJson<Record<string, unknown>>(join(HCL, 'manifest.json'));
  const stub = join(dataRoot.root, 'projects', 'hcl');
  await mkdir(stub, { recursive: true });
  await writeFile(
    join(stub, 'manifest.json'),
    JSON.stringify({ ...hcl, layers: [], captures: [] }, null, 2),
  );
  await writeFile(join(stub, 'issues.json'), '{"schema":"aio.issues/1","issues":[]}');

  const app = await launchApp(dataRoot, runtimeEnv());
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    const wiz = await wizard(
      win,
      'HCl sample',
      /^Inspection/,
      `${String(s.originLatLon[0])}, ${String(s.originLatLon[1])}, ${String(s.origin[2])}`,
      s.epsg,
    );
    await wiz.getByRole('option', { name: /HCl lining/ }).click();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Create project' }).click();
    await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
    const root = join(dataRoot.root, 'projects', 'hcl-sample');

    // Import files: the 20 photos and the tank model
    const photos = (await readdir(join(dir, 'photos'))).map((f) => join(dir, 'photos', f));
    await nextOpenDialog(app, [...photos, join(dir, s.glb)]);
    await win.getByRole('button', { name: 'Import files' }).click();
    const panel = win.getByTestId('import-panel');
    const n = photos.length + 1;
    await expect(panel).toContainText(`Imported ${String(n)} of ${String(n)} files`, {
      timeout: 60_000,
    });
    await panel.getByRole('button', { name: 'Close' }).click();
    const manifest = await readJson<{
      layers: { kind: string; items?: { id: string; pos?: Vec3; q?: Quat }[] }[];
    }>(join(root, 'manifest.json'));
    const items = manifest.layers.find((l) => l.kind === 'photos')?.items ?? [];
    expect(items).toHaveLength(s.photos.length);
    // each photo posed where the delivered survey had it (GPS and gimbal written from that pose)
    for (const it of items) {
      const want = s.poses[it.id];
      expect(want, it.id).toBeTruthy();
      if (!want || !it.pos || !it.q) throw new Error(`${it.id} is not posed`);
      expect(Math.hypot(...it.pos.map((v, i) => v - (want.pos[i] ?? 0)))).toBeLessThan(0.02);
      const dot = it.q.reduce((a, v, i) => a + v * (want.q[i] ?? 0), 0);
      expect(Math.abs(dot)).toBeGreaterThan(0.99999);
    }

    // the AI pass into <project>\detections\, then Jobs, New job, Start job
    await mkdir(join(root, 'detections'), { recursive: true });
    await copyFile(
      join(dir, 'detections', 'hcl-ai-pass.json'),
      join(root, 'detections', 'hcl-ai-pass.json'),
    );
    const run = async () => {
      await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
      await win.getByRole('button', { name: 'New job' }).click();
      await expect(win.getByLabel('Pipeline', { exact: true })).toHaveValue('inspection.run');
      return runJob(win, () => win.getByTestId('job-start').click(), 180_000);
    };
    const jobId = await run();
    const log = await readFile(join(root, 'jobs', jobId, 'job.log'), 'utf8');
    expect(log).toContain(`${String(s.detections.draft)} draft, not reviewed`);
    const issues = (await readJson<{ issues: Issue[] }>(join(root, 'issues.json'))).issues;
    expect(issues).toHaveLength(s.detections.acceptedFindings.length);
    // each accepted finding is an issue of its class on the tank, where the delivered one is
    for (const code of s.detections.acceptedFindings) {
      const f = s.findings[code];
      if (!f) throw new Error(code);
      const near = issues.filter((i) => {
        if (i.classId !== f.class) return false;
        const m = i.sightings.find((x) => x.on === 'mesh');
        if (m?.on !== 'mesh' || m.geom.type !== 'spoint') return false;
        const p = m.geom.p;
        return f.points.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.3);
      });
      expect(near.length, `an issue at ${code}`).toBe(1);
      expect(near[0]?.severity).toBe(f.severity);
      expect(near[0]?.severityModelId).toBe('hcl-lining');
    }
    // a second run changes nothing
    await run();
    expect((await readJson<{ issues: Issue[] }>(join(root, 'issues.json'))).issues).toEqual(issues);

    // review: the Detections screen counts the pass; X rejects the false alarm (41%), A accepts
    // every other waiting box (each becomes a draft issue)
    await win.locator('.sb-nav .nav-item', { hasText: 'Detections' }).click();
    const counts = win.getByTestId('det-counts');
    const { draft, accepted } = s.detections;
    await expect(counts).toContainText(
      `${String(draft)} waiting · ${String(accepted)} accepted · 0 rejected`,
    );
    const inspector = win.getByTestId('det-inspector');
    await win.getByTestId('det-sheet').locator('.det-tile').first().click();
    for (let left = draft; left > 0; left--) {
      await expect(inspector).toContainText('Confidence');
      await win.keyboard.press(
        (await inspector.textContent())?.includes('Confidence 41%') ? 'x' : 'a',
      );
      await expect(counts).toContainText(`${String(left - 1)} waiting`);
    }
    await expect(counts).toContainText(
      `0 waiting · ${String(accepted + draft - 1)} accepted · 1 rejected`,
    );
    // the review writes back into the pass file
    await expect
      .poll(
        async () =>
          (
            await readJson<{ detections: { status?: string }[] }>(
              join(root, 'detections', 'hcl-ai-pass.json'),
            )
          ).detections
            .map((d) => d.status)
            .filter((x) => x === 'draft').length,
      )
      .toBe(0);
    await expect(win.getByTestId('det-save')).toHaveText('Saved');
    const reviewed = (await readJson<{ issues: Issue[] }>(join(root, 'issues.json'))).issues;
    expect(reviewed).toHaveLength(issues.length + draft - 1);

    // run again: the reviewed boxes are placed on their own issues, nothing duplicated
    const again = await run();
    const log2 = await readFile(join(root, 'jobs', again, 'job.log'), 'utf8');
    expect(log2).toContain('1 rejected');
    const after = (await readJson<{ issues: Issue[] }>(join(root, 'issues.json'))).issues;
    expect(after.map((i) => i.id).sort()).toEqual(reviewed.map((i) => i.id).sort());
    for (const i of after.filter((x) => !issues.some((y) => y.id === x.id)))
      expect(
        i.sightings.some((x) => x.on === 'mesh'),
        i.code,
      ).toBe(true);
    await writeFile(
      test.info().outputPath('result.json'),
      JSON.stringify(
        {
          log,
          log2,
          issues: after.map((i) => [i.code, i.title, i.classId, i.severity, i.status]),
        },
        null,
        1,
      ),
    );
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

// --------------------------------------------------------------------- volumetric-masafi-mini

interface MasafiSample {
  originLatLon: [number, number];
  origin: [number, number, number];
  surveys: { date: string; dsm: string; ortho: string }[];
  piles: {
    id: string;
    centreEN: [number, number];
    epochs: Record<string, { volumes: Record<string, number> }>;
    changeNet: number;
  }[];
}

test('@realdata volumetric-masafi-mini: two survey dates, the delivered pile volumes', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(300_000);
  const dir = join(SAMPLES, 'volumetric-masafi-mini');
  const s = await sample<MasafiSample>('volumetric-masafi-mini');
  const app = await launchApp(dataRoot, runtimeEnv());
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    const wiz = await wizard(
      win,
      'Masafi sample',
      /^Volumetric/,
      `${String(s.originLatLon[0])}, ${String(s.originLatLon[1])}, ${String(s.origin[2])}`,
      32639,
    );
    await wiz.getByRole('button', { name: 'Next' }).click();
    const surveys = wiz.getByTestId('volumetric-surveys');
    const rows = surveys.getByTestId('survey-row');
    const pick = async (row: number, button: string, file: string) => {
      await nextOpenDialog(app, [join(dir, file)]);
      await rows.nth(row).getByRole('button', { name: button }).click();
    };
    for (const [i, sv] of s.surveys.entries()) {
      if (i > 0) await surveys.getByRole('button', { name: 'Add a second survey date' }).click();
      await rows
        .nth(i)
        .getByLabel(`Survey date ${String(i + 1)}`)
        .fill(sv.date);
      await pick(i, 'DSM GeoTIFF', sv.dsm);
      await pick(i, 'Pick orthomosaic', sv.ortho);
    }
    await expect(wiz.locator('.b-summary')).toContainText('2 survey dates, built in Jobs');
    await runJob(win, () => wiz.getByRole('button', { name: 'Create project' }).click(), 240_000);

    const root = join(dataRoot.root, 'projects', 'masafi-sample');
    const vols = await readJson<{
      piles: {
        id: string;
        centreEN: [number, number];
        change: { net: number };
        epochs: Record<string, { volumes: Record<string, { net: number }> }>;
      }[];
    }>(join(root, 'volumes.json'));
    expect(vols.piles).toHaveLength(s.piles.length);
    for (const want of s.piles) {
      const got = vols.piles.find(
        (p) => Math.hypot(p.centreEN[0] - want.centreEN[0], p.centreEN[1] - want.centreEN[1]) < 5,
      );
      expect(got, `a pile at ${want.id}`).toBeTruthy();
      for (const [e, ep] of Object.entries(want.epochs))
        for (const [base, v] of Object.entries(ep.volumes))
          expect(
            Math.abs((got?.epochs[e]?.volumes[base]?.net ?? NaN) - v),
            `${want.id} ${e} ${base}`,
          ).toBeLessThanOrEqual(Math.max(0.005 * Math.abs(v), 0.5));
      expect(Math.abs((got?.change.net ?? NaN) - want.changeNet)).toBeLessThanOrEqual(1);
    }
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    const register = win.getByTestId('vol-register');
    await expect(register).toBeVisible({ timeout: 30_000 });
    await expect(register.locator('tbody tr')).toHaveCount(s.piles.length);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------------- road-ringroad-mini

interface RoadSample {
  originLatLon: [number, number];
  epsg: number;
  ortho: string;
  defects: number;
  deliveredUnits: { cells: [number, number][]; pci: Record<string, number> }[];
}

test('@realdata road-ringroad-mini: ortho, centreline and defects; the delivered PCI of every grid unit', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(420_000);
  const dir = join(SAMPLES, 'road-ringroad-mini');
  const s = await sample<RoadSample>('road-ringroad-mini');
  const app = await launchApp(dataRoot, runtimeEnv());
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    const wiz = await wizard(
      win,
      'Ring Road sample',
      /^Road/,
      `${String(s.originLatLon[0])}, ${String(s.originLatLon[1])}, 0`,
      s.epsg,
    );
    await expect(wiz.getByRole('option', { name: /Road distress \(ASTM D6433\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Create project' }).click();
    const setup = win.getByTestId('road-setup');
    await expect(setup).toBeVisible({ timeout: 30_000 });
    const root = join(dataRoot.root, 'projects', 'ring-road-sample');

    // the ortho as raw data, then the road builder from Jobs with the sample's files
    await nextOpenDialog(app, [join(dir, s.ortho)]);
    await win.getByRole('button', { name: 'Import files' }).click();
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 120_000 });
    await panel.getByRole('button', { name: 'Close' }).click();
    await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
    await win.getByRole('button', { name: 'New job' }).click();
    await win.getByLabel('Pipeline', { exact: true }).selectOption('road.build');
    await win.locator('#job-f-centreline').fill(join(dir, 'centreline.geojson'));
    await win.locator('#job-f-ortho').fill(join(dir, s.ortho));
    await win.locator('#job-f-defects').fill(join(dir, 'defects.geojson'));
    await win.locator('#job-f-units').selectOption('grid');
    await win.locator('#job-f-pavement').fill(join(dir, 'pavement.tif'));
    await runJob(win, () => win.getByTestId('job-start').click(), 300_000);
    await expect(win.locator('.job-detail .job-log')).toContainText('network PCI');

    const road = await readJson<{
      pci: {
        layout: string;
        grid: { cellM: number; origin: Vec3 };
        units: { cells: [number, number][]; pci: Record<string, number> }[];
      };
    }>(join(root, 'road.json'));
    const m = await readJson<{ origin: Vec3 }>(join(root, 'manifest.json'));
    expect(road.pci.layout).toBe('grid');
    const g = road.pci.grid;
    const ge = m.origin[0] + g.origin[0];
    const gn = m.origin[1] - g.origin[2];
    const key = (cells: [number, number][]) =>
      cells
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .sort()
        .join(' ');
    const built = new Map(
      road.pci.units.map((u) => [
        key(u.cells.map(([row, col]) => [ge + col * g.cellM, gn - row * g.cellM])),
        u.pci,
      ]),
    );
    expect(s.deliveredUnits.length).toBeGreaterThan(0);
    for (const d of s.deliveredUnits) expect(built.get(key(d.cells)), key(d.cells)).toEqual(d.pci);
    const issues = (await readJson<{ issues: Issue[] }>(join(root, 'issues.json'))).issues;
    expect(issues).toHaveLength(s.defects);

    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    await expect(win.getByTestId('defect-count')).toHaveText(
      `${String(s.defects)} of ${String(s.defects)} defects`,
      { timeout: 30_000 },
    );
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
