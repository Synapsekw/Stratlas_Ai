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

/** Look at `p` from close by (the tiny project's camera stays within about 18 m of it). */
async function lookAt(win: Page, p: Vec3) {
  await win.evaluate((at) => {
    (window as unknown as Inspect).__stratlas.workspace
      .getState()
      .flyTo({ kind: 'point', p: at, distance: 15 });
  }, p);
}

/**
 * The visible icons of a marker layer: their count badges summed (a merged icon carries the
 * number of places in it) and how far the nearest icon sits from the stage centre, in px.
 */
async function markers(win: Page, kind: 'pano' | 'photo') {
  return win.evaluate((k) => {
    const shown = [...document.querySelectorAll<HTMLElement>(`[data-markers=${k}] .aio-mk`)].filter(
      (e) => e.style.display !== 'none',
    );
    const root = document.querySelector<HTMLElement>(`[data-markers=${k}]`);
    const cx = (root?.clientWidth ?? 0) / 2;
    const cy = (root?.clientHeight ?? 0) / 2;
    let nearest = Infinity;
    for (const e of shown) {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(e.style.transform);
      if (m) nearest = Math.min(nearest, Math.hypot(Number(m[1]) - cx, Number(m[2]) - cy));
    }
    return {
      count: shown.reduce((n, e) => n + Number(e.dataset.count ?? '1'), 0),
      centred: nearest < 40,
    };
  }, kind);
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

    // 3. one marker per sphere, none for its frames, and no photo markers: the spheres sit 150 m
    // apart, further than the tiny project's camera can see, so visit each. Frames within a metre
    // of their sphere would merge into its icon and raise the count above one.
    const positions = (layer?.items ?? []).map((p) => p.pos ?? ([0, 0, 0] as Vec3));
    expect(positions).toHaveLength(3);
    for (const p of positions) {
      await lookAt(win, p);
      await expect
        .poll(() => markers(win, 'pano'), { timeout: 30_000 })
        .toEqual({
          count: 1,
          centred: true,
        });
      expect((await markers(win, 'photo')).count).toBe(0);
    }

    // 4. the stitches finish (one at a time, in import order): every row says Stitched. The
    // import made a new survey date, which the Datasets tree lists collapsed, Panoramas too.
    await win.getByRole('button', { name: 'Expand 10 Sep 2026', exact: true }).click();
    await win.getByRole('button', { name: /^Panoramas 3 Panoramas/ }).click();
    for (const id of ['p01', 'p02', 'p03'])
      await expect(win.getByTestId(`pano-status-${id}`)).toHaveText('Stitched', {
        timeout: 300_000,
      });
    const done = await read();
    const items = done.layers.find((l) => l.kind === 'panoramas')?.items ?? [];
    expect(items.map((p) => p.stitch?.status)).toEqual(['done', 'done', 'done']);
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
