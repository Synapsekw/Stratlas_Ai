import { toWgs84 } from '@aio/geo';
import type { ElectronApplication } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, VENV_PYTHON } from './fixtures';
import { hasPanoStitch, makeSynthCard } from './panoSynth';

async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

test.describe('Add data with drone sphere frames', () => {
  test.skip(
    !hasPanoStitch(VENV_PYTHON),
    `no pipeline Python with pano.stitch at ${VENV_PYTHON} (set QUADRION_E2E_PYTHON)`,
  );
  test.use({ appEnv: { QUADRION_PIPELINE_PYTHON: VENV_PYTHON, QUADRION_PANO_WIDTH: '512' } });

  test('offers the spheres as panoramas and imports only the mapping photos as photos', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(300_000);
    const [lon, lat] = toWgs84([500050, 3200050, 0], 32639);
    const card = makeSynthCard(VENV_PYTHON, join(dataRoot.base, 'card'), { lat, lon });
    const files = (await readdir(card.folder)).map((n) => join(card.folder, n));

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    await nextOpenDialog(app, files);
    await win.getByTestId('add-data').click();
    const offer = win.getByTestId('pano-offer');
    await expect(offer).toContainText(
      '72 of these frames are 3 drone panoramas. Import them as panoramas?',
      { timeout: 60_000 },
    );
    await offer.getByTestId('pano-offer-yes').click();

    // the preview first; the photos wait for it
    const dlg = win.getByTestId('pano-import');
    await expect(dlg.getByTestId('pano-summary')).toContainText('3 panoramas found');
    await dlg.getByTestId('pano-import-go').click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });

    // then the four mapping photos, through the camera-heights card when it asks
    const heights = win.getByTestId('import-heights');
    const panel = win.getByTestId('import-panel');
    await expect(heights.or(panel)).toBeVisible({ timeout: 60_000 });
    if (await heights.isVisible())
      await heights.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(panel).toContainText('Imported 4 of 4 files', { timeout: 60_000 });

    const m = JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as {
      layers: { kind: string; items?: unknown[] }[];
    };
    expect(m.layers.find((l) => l.kind === 'photos')?.items).toHaveLength(4);
    expect(m.layers.find((l) => l.kind === 'panoramas')?.items).toHaveLength(3);
  });

  test('a folder of sphere frames only: panoramas on yes, no photos and no error', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(300_000);
    const [lon, lat] = toWgs84([500050, 3200050, 0], 32639);
    const card = makeSynthCard(
      VENV_PYTHON,
      join(dataRoot.base, 'frames-only'),
      { lat, lon },
      { spheres: 1, strays: 0 },
    );
    const manifest = async () =>
      JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as {
        layers: { kind: string; items?: unknown[] }[];
      };
    const photos = (m: Awaited<ReturnType<typeof manifest>>) =>
      m.layers.filter((l) => l.kind === 'photos').flatMap((l) => l.items ?? []).length;
    const before = photos(await manifest());

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    await nextOpenDialog(app, [card.folder]);
    await win.getByTestId('add-data').click();
    const offer = win.getByTestId('pano-offer');
    await expect(offer).toContainText('1 drone panorama. Import it as a panorama?', {
      timeout: 60_000,
    });
    await offer.getByTestId('pano-offer-yes').click();
    const dlg = win.getByTestId('pano-import');
    await dlg.getByTestId('pano-import-go').click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });

    // nothing is left for the photo import: no camera-heights card, no failed import card. The
    // follow-up import has no visible end, so give it a moment before checking that nothing came
    await win.waitForTimeout(5_000);
    await expect(win.getByTestId('import-heights')).toBeHidden();
    await expect(win.getByTestId('import-panel')).toBeHidden();
    await expect(win.getByTestId('pano-offer-failed')).toBeHidden();
    const m = await manifest();
    expect(m.layers.find((l) => l.kind === 'panoramas')?.items).toHaveLength(1);
    expect(photos(m)).toBe(before);
  });
});
