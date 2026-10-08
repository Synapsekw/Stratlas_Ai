/**
 * M11 G1: Site settings, the cursor readout in the site's CRS and units, and a site calibration
 * imported from a controller job, checked on its residual table and applied (journaled).
 *
 * Synthetic only: the tiny project (WGS 84 / UTM 39N) and a vendor-shaped JobXML written by
 * `python/tests/geodesy_synth.py`. GEOID18 and other regional grids are not available offline in
 * this environment, so the state plane test shows heights as stored (project heights); the geoid
 * path is covered by the Python and Vitest parity suites on a synthetic geoid grid. The "a saved
 * measurement turns Stale" step waits for G3's measurements.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';

const REPO = join(import.meta.dirname, '..', '..', '..');

interface Probe {
  __stratlas: {
    stage: () => {
      raycast: (x: number, y: number) => { point: { x: number; y: number; z: number } } | null;
    } | null;
  };
}

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
}

/** A screen point whose ray hits the scene (the unit quad at the project origin). */
async function hitPoint(win: Page): Promise<{ x: number; y: number }> {
  const find = () =>
    win.evaluate(() => {
      const st = (window as unknown as Probe).__stratlas.stage();
      const canvas = document.querySelector('[data-scene-view] canvas');
      if (!st || !canvas) return null;
      const r = canvas.getBoundingClientRect();
      for (let i = 8; i < 56; i += 2)
        for (let j = 8; j < 56; j += 2) {
          const nx = (i / 64) * 2 - 1;
          const ny = -((j / 64) * 2 - 1);
          if (st.raycast(nx, ny))
            return { x: r.left + ((nx + 1) / 2) * r.width, y: r.top + ((1 - ny) / 2) * r.height };
        }
      return null;
    });
  await expect.poll(async () => (await find()) !== null, { timeout: 20_000 }).toBe(true);
  const p = await find();
  if (p === null) throw new Error('nothing to point at');
  return p;
}

async function cursorText(win: Page): Promise<string> {
  const p = await hitPoint(win);
  await win.mouse.move(p.x - 3, p.y - 3);
  await win.mouse.move(p.x, p.y, { steps: 3 });
  const ro = win.getByTestId('cursor-readout');
  await expect(ro).not.toContainText('Point at the scene');
  return (await ro.innerText()).replace(/\s+/g, ' ');
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

test.describe('site settings', () => {
  test('a state plane zone in US survey feet: the cursor shows N, E, Z in US ft to 3 decimals', async ({
    win,
    dataRoot,
  }) => {
    await openTiny(win);
    const before = await cursorText(win);
    // no site settings yet: the 0.10 readout
    expect(before).toMatch(/E [\d ]+\.\d N [\d ]+\.\d · EL/);

    await win.getByTestId('site-settings-open').click();
    const dlg = win.getByTestId('site-settings');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('site-crs-search').fill('Georgia West ftUS');
    await dlg.getByTestId('site-crs-2240').click();
    await expect(dlg.getByTestId('site-crs-current')).toContainText('EPSG 2240');
    // decision 12: the units follow the CRS's unit
    await expect(dlg.getByTestId('site-unit-distance')).toHaveValue('us-ft');
    await expect(dlg.getByTestId('site-precision-coordinate')).toHaveValue('3');
    await dlg.getByTestId('site-settings-save').click();
    await expect(dlg).toBeHidden();

    const saved = JSON.parse(
      await readFile(join(dataRoot.projectDir, 'survey', 'settings.json'), 'utf8'),
    ) as { crs: { epsg: number }; units: { distance: string } };
    expect(saved.crs).toEqual({ epsg: 2240 });
    expect(saved.units.distance).toBe('us-ft');

    const ro = win.getByTestId('cursor-readout');
    await expect(ro).toContainText('EPSG 2240');
    const text = await cursorText(win);
    expect(text).toMatch(/N -?[\d,]+\.\d{3} E -?[\d,]+\.\d{3} Z -?[\d,]+\.\d{3} US ft/);

    // switch back to metres in the project CRS
    await win.getByTestId('site-settings-open').click();
    await dlg.getByTestId('site-crs-search').fill('32639');
    await dlg.getByTestId('site-crs-32639').click();
    await expect(dlg.getByTestId('site-unit-distance')).toHaveValue('m');
    await dlg.getByTestId('site-settings-save').click();
    await expect
      .poll(async () => cursorText(win))
      .toMatch(/N 3 2\d\d \d{3}\.\d{3} E (499|500) \d{3}\.\d{3} Z -?[\d ]+\.\d{3} m/);
  });

  test.describe('calibration', () => {
    test.use({ appEnv: PIPELINE_ENV });

    test('import a controller job, read the residuals, apply it', async ({
      app,
      win,
      dataRoot,
    }) => {
      test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
      test.setTimeout(180_000);
      const jxl = join(dataRoot.base, 'site job.jxl');
      const xml = execFileSync(
        VENV_PYTHON,
        [
          '-c',
          'import sys; from geodesy_synth import synthetic_jobxml; sys.stdout.buffer.write(synthetic_jobxml()[0])',
        ],
        { cwd: join(REPO, 'python', 'tests') },
      );
      await writeFile(jxl, xml);

      await openTiny(win);
      await win.getByTestId('site-settings-open').click();
      const dlg = win.getByTestId('site-settings');
      await nextOpenDialog(app, jxl);
      await dlg.getByTestId('site-calibration-import').click();
      await expect(dlg.getByTestId('site-calibration-state')).toContainText('draft, not applied', {
        timeout: 120_000,
      });
      const table = dlg.getByTestId('site-residuals');
      await expect(table.locator('tbody tr')).toHaveCount(6);
      await expect(table).toContainText('CP1');

      await dlg.getByTestId('site-calibration-apply').click();
      await expect(dlg.getByTestId('site-calibration-state')).toHaveText(/: applied$/);
      const cal = JSON.parse(
        await readFile(join(dataRoot.projectDir, 'survey', 'calibration.json'), 'utf8'),
      ) as { appliedAt?: string; id: string };
      expect(cal.appliedAt).toBeTruthy();
      const settings = JSON.parse(
        await readFile(join(dataRoot.projectDir, 'survey', 'settings.json'), 'utf8'),
      ) as { calibration?: string };
      expect(settings.calibration).toBe(cal.id);
      // journaled: the device chain holds a survey.calibration op
      const chains = await readdir(join(dataRoot.projectDir, 'journal', 'ops'));
      let ops = '';
      for (const c of chains) {
        for (const f of await readdir(join(dataRoot.projectDir, 'journal', 'ops', c)))
          ops += await readFile(join(dataRoot.projectDir, 'journal', 'ops', c, f), 'utf8');
      }
      expect(ops).toContain('survey.calibration');
    });
  });
});
