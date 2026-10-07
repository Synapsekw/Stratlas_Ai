/**
 * A volumetric project built from raw data in the app: two small synthetic survey dates (DSM and
 * ortho GeoTIFFs, a stockyard with two cone piles, one cut down between the dates) picked in the
 * new project wizard, the Volumetric Survey Kit run as a `volumetric.build` job in the Jobs
 * panel, and the project opening in the native volumetric workspace (register, recomputed
 * volumes, pile selection). Needs the development Python with aio_pipelines (`uv sync` in
 * python/) or QUADRION_E2E_PYTHON; skipped without it.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, test } from './fixtures';

const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.QUADRION_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));

/** Two survey dates over an 80 m yard in UTM 39N: pile A 7 m then 4 m high, pile B 6 m both times. */
const MAKE_SURVEYS = `
import sys, numpy as np, rasterio
from rasterio.transform import from_origin
out = sys.argv[1]
X0, Y1, S = 500000.0, 3200080.0, 80.0
def dsm(heights, path, res=0.1):
    n = round(S / res); c = (np.arange(n) + 0.5) * res
    XX, YY = np.meshgrid(c, S - c)
    z = 10.0 + 0.01 * XX + 0.005 * YY
    for (cx, cy, r), h in zip(((25.0, 55.0, 10.0), (55.0, 25.0, 9.0)), heights):
        z = z + np.clip(h * (1 - np.hypot(XX - cx, YY - cy) / r), 0, None)
    with rasterio.open(path, 'w', driver='GTiff', height=n, width=n, count=1, dtype='float32',
                       crs='EPSG:32639', transform=from_origin(X0, Y1, res, res), nodata=-10000) as d:
        d.write(z.astype(np.float32), 1)
def ortho(path, res=0.25):
    n = round(S / res); yy, xx = np.mgrid[0:n, 0:n]
    img = np.stack([xx * 255 // n, yy * 255 // n, np.full((n, n), 120), np.full((n, n), 255)]).astype(np.uint8)
    with rasterio.open(path, 'w', driver='GTiff', height=n, width=n, count=4, dtype='uint8',
                       crs='EPSG:32639', transform=from_origin(X0, Y1, res, res)) as d:
        d.write(img)
dsm((7.0, 6.0), out + '/e1_dsm.tif'); ortho(out + '/e1_ortho.tif')
dsm((4.0, 6.0), out + '/e2_dsm.tif'); ortho(out + '/e2_ortho.tif')
`;

/** Make the next native open dialog return this file (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, file) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: [file] });
    };
  }, path);
}

interface Fcn {
  fill: number;
  cut: number;
  net: number;
}
interface VolumesJson {
  captures: { epoch: string; date: string }[];
  piles: {
    id: string;
    change: Fcn;
    epochs: Record<string, { volumes: Record<string, Fcn> }>;
  }[];
}

async function recompute(win: Page, pile: string): Promise<Record<string, Record<string, Fcn>>> {
  return win.evaluate(async (id) => {
    const v = (
      window as unknown as {
        __stratlas: {
          volumetric: {
            getState(): {
              service: {
                recompute(p: string): Promise<Record<string, Record<string, Fcn>>>;
              } | null;
            };
          };
        };
      }
    ).__stratlas.volumetric.getState().service;
    if (!v) throw new Error('no volume worker');
    return v.recompute(id);
  }, pile);
}

test.skip(!existsSync(venvPython), `no Python with aio_pipelines at ${venvPython}`);

test('a volumetric project from two raw survey dates: wizard, Jobs panel, volumetric workspace', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(240_000);
  const raw = join(dataRoot.base, 'raw').replace(/\\/g, '/');
  execFileSync(venvPython, ['-c', `import os; os.makedirs(r'${raw}', exist_ok=True)`]);
  execFileSync(venvPython, ['-c', MAKE_SURVEYS, raw]);

  const app = await launchApp(dataRoot, { QUADRION_PIPELINE_PYTHON: venvPython });
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    // 1. wizard: a volumetric project with its two surveys
    await win.getByTestId('new-project').first().click();
    const wiz = win.getByTestId('new-project-wizard');
    await wiz.getByLabel('Project name').fill('Yard surveys');
    await wiz.getByRole('button', { name: /Volumetric/ }).click();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
    await wiz.getByLabel('Origin coordinate').fill('500040 3200040 10');
    await expect(wiz.getByTestId('origin-readout')).toContainText('E 500040.00');
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Next' }).click();

    const surveys = wiz.getByTestId('volumetric-surveys');
    await expect(surveys).toBeVisible();
    const rows = surveys.getByTestId('survey-row');
    const pick = async (row: number, button: string, file: string) => {
      await nextOpenDialog(app, `${raw}/${file}`);
      await rows.nth(row).getByRole('button', { name: button }).click();
    };
    await rows.nth(0).getByLabel('Survey date 1').fill('2026-01-01');
    await pick(0, 'DSM GeoTIFF', 'e1_dsm.tif');
    await expect(rows.nth(0).getByTestId('survey-surface')).toHaveText('e1_dsm.tif');
    await pick(0, 'Pick orthomosaic', 'e1_ortho.tif');
    await surveys.getByRole('button', { name: 'Add a second survey date' }).click();
    // a second survey without a surface blocks the build
    await rows.nth(1).getByLabel('Survey date 2').fill('2026-01-15');
    await expect(surveys).toContainText('Every survey needs a DSM or a point cloud.');
    await expect(wiz.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await pick(1, 'DSM GeoTIFF', 'e2_dsm.tif');
    await pick(1, 'Pick orthomosaic', 'e2_ortho.tif');
    await expect(wiz.locator('.b-summary')).toContainText('2 survey dates, built in Jobs');
    await wiz.getByRole('button', { name: 'Create project' }).click();

    // 2. the kit runs in the Jobs panel
    const detail = win.locator('.job-detail');
    await expect(detail.locator('.jd-t')).toContainText('volumetric-build', { timeout: 30_000 });
    await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 180_000 });
    for (const step of ['DSM of survey 2', 'Detect piles', 'Terrain meshes'])
      await expect(detail.locator('.jd-steps li', { hasText: step })).toHaveAttribute(
        'data-state',
        'done',
      );
    const root = join(dataRoot.root, 'projects', 'yard-surveys');
    const vols = JSON.parse(await readFile(join(root, 'volumes.json'), 'utf8')) as VolumesJson;
    expect(vols.captures.map((c) => c.date)).toEqual(['2026-01-01', '2026-01-15']);
    expect(vols.piles).toHaveLength(2);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      layers: { id: string }[];
    };
    expect(manifest.layers.map((l) => l.id)).toEqual([
      'terrain-2026-01-15',
      'terrain-2026-01-01',
      'ortho-2026-01-15',
      'ortho-2026-01-01',
    ]);

    // 3. the project opens in the volumetric workspace like Masafi
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    const register = win.getByTestId('vol-register');
    await expect(register).toBeVisible({ timeout: 30_000 });
    await expect(register.locator('tbody tr')).toHaveCount(2);
    const cut = vols.piles.find((p) => p.change.net < -50);
    expect(cut, 'the pile cut down between the dates').toBeTruthy();
    const pid = cut?.id ?? '';
    const latest = cut?.epochs.e2?.volumes.tin?.net ?? NaN;
    await expect(register.locator(`tbody tr[data-pile="${pid}"] td.net`)).toHaveText(
      Math.round(latest).toLocaleString('en-US'),
    );
    // the volume worker recomputes the published volumes from the kit grids
    const r = await recompute(win, pid);
    for (const [epoch, ep] of Object.entries(cut?.epochs ?? {}))
      for (const [b, v] of Object.entries(ep.volumes))
        expect(Math.abs((r[epoch]?.[b]?.net ?? NaN) - v.net)).toBeLessThan(
          Math.max(0.005 * Math.abs(v.net), 0.5),
        );
    await register.locator(`tbody tr[data-pile="${pid}"]`).click();
    await expect(win.getByTestId('vol-pile')).toHaveAttribute('data-pile', pid);
    expect(errors).toEqual([]);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
