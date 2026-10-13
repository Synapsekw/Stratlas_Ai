import { toWgs84 } from '@aio/geo';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, VENV_PYTHON } from './fixtures';
import { hasPanoStitch, makeSynthCard } from './panoSynth';

/** Make the next native open dialog return these paths (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

type Vec3 = [number, number, number];

interface Manifest {
  layers: {
    kind: string;
    id: string;
    items?: {
      id: string;
      name?: string;
      pos?: Vec3;
      stitch?: { status: string };
      cov?: unknown;
    }[];
  }[];
}

interface CameraTarget {
  kind: string;
  p?: Vec3;
}

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        flyTo(t: { kind: 'point'; p: Vec3; distance: number }): void;
        lastCamera: { target: CameraTarget } | null;
      };
    };
  };
}

/** Places the visible icons of a marker layer stand for (a merged icon carries a count). */
async function markers(win: Page, kind: 'pano' | 'photo') {
  return win.evaluate(
    (k) =>
      [...document.querySelectorAll<HTMLElement>(`[data-markers=${k}] .aio-mk`)]
        .filter((e) => e.style.display !== 'none')
        .reduce((n, e) => n + Number(e.dataset.count ?? '1'), 0),
    kind,
  );
}

test.describe('drone panoramas', () => {
  test.skip(
    !hasPanoStitch(VENV_PYTHON),
    `no pipeline Python with pano.stitch at ${VENV_PYTHON} (set QUADRION_E2E_PYTHON)`,
  );
  // stitches run one at a time; a small output keeps each one to seconds
  test.use({ appEnv: { QUADRION_PIPELINE_PYTHON: VENV_PYTHON, QUADRION_PANO_WIDTH: '512' } });

  test('imports a card folder as three spheres, stitches them and opens one', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(420_000);
    const [lon, lat] = toWgs84([500050, 3200050, 0], 32639);
    const card = makeSynthCard(VENV_PYTHON, join(dataRoot.base, 'card'), { lat, lon });
    expect(card.spheres).toEqual([25, 22, 25]);

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    // 1. pick the folder: the preview finds three panoramas and leaves the mapping photos out
    await nextOpenDialog(app, [card.folder]);
    await win.getByTestId('add-panos').click();
    const dlg = win.getByTestId('pano-import');
    await expect(dlg.getByTestId('pano-summary')).toHaveText(
      /^3 panoramas found \(25 \+ 22 \+ 25 frames\) · 4 files are not panorama frames · about .+ copied$/,
      { timeout: 60_000 },
    );
    await expect(dlg.getByTestId('pano-skipped')).toContainText('Moving drone or single shot');
    await expect(dlg.getByTestId('pano-name')).toHaveValue('Panoramas 10 Sep');

    // 2. import: one layer, three queued spheres, frames copied, nothing as photos
    await dlg.getByTestId('pano-import-go').click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    const read = async () =>
      JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as Manifest;
    const m = await read();
    const layer = m.layers.find((l) => l.kind === 'panoramas');
    const layerId = layer?.id ?? '';
    expect(layer?.items?.map((p) => p.name)).toEqual(['Pano 1', 'Pano 2', 'Pano 3']);
    expect(m.layers.some((l) => l.kind === 'photos')).toBe(false);
    expect(
      existsSync(join(dataRoot.projectDir, 'panoramas', layerId, 'p02', 'frames', 'SYN_0985.JPG')),
    ).toBe(true);

    // 3. one marker per sphere, none for its frames (a frame marker would merge into its sphere's
    // icon and raise the count), no photo markers. The tiny project's 1 m quad still bounds the
    // camera (marker bounds count only in a project without a model), so the import's fly-to
    // cannot show all three spheres 150 m apart in one view: visit each.
    const positions = (layer?.items ?? []).map((p) => p.pos ?? ([0, 0, 0] as Vec3));
    expect(positions).toHaveLength(3);
    for (const p of positions) {
      await win.evaluate((at) => {
        (window as unknown as Inspect).__stratlas.workspace
          .getState()
          .flyTo({ kind: 'point', p: at, distance: 15 });
      }, p);
      await expect.poll(() => markers(win, 'pano'), { timeout: 30_000 }).toBe(1);
      await expect.poll(() => markers(win, 'photo'), { timeout: 10_000 }).toBe(0);
    }

    // 4. the import reveals its rows (the new date opens, Panoramas is open), and the stitches
    // finish one at a time, in import order: every row says Stitched
    await expect(win.getByTestId('pano-status-p01')).toBeVisible({ timeout: 30_000 });
    for (const id of ['p01', 'p02', 'p03'])
      await expect(win.getByTestId(`pano-status-${id}`)).toHaveText('Stitched', {
        timeout: 300_000,
      });
    const done = await read();
    const items = done.layers.find((l) => l.kind === 'panoramas')?.items ?? [];
    expect(items.map((p) => p.stitch?.status)).toEqual(['done', 'done', 'done']);
    expect(done.layers.some((l) => l.kind === 'photos')).toBe(false);
    expect(existsSync(join(dataRoot.projectDir, 'panoramas', layerId, 'p01', 'stitch.json'))).toBe(
      true,
    );

    // 5. Open enters the sphere view; Esc returns; Fly to moves the camera to the sphere
    await win.getByTestId('pano-open-p01').click();
    await expect(win.locator('.aio-pano-hud')).toBeVisible({ timeout: 30_000 });
    await win.keyboard.press('Escape');
    await expect(win.locator('.aio-pano-hud')).toBeHidden();
    await win.getByTestId('pano-fly-p02').click();
    await expect
      .poll(() =>
        win.evaluate(
          () =>
            (window as unknown as Inspect).__stratlas.workspace.getState().lastCamera?.target ??
            null,
        ),
      )
      .toMatchObject({ kind: 'point', p: positions[1] });
  });
});
