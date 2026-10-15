import { ProjectManifest } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, hasPdal, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';

/**
 * Bentley import through Add data against the development pipeline runtime: a synthetic
 * BlocksExchange block with three photos and a two-tile .zpc (python/tests/bentley_synth.py; no
 * client data) come into the tiny project. Add data asks for the cloud's survey day, prefilled
 * from the tiles' LAS header (the export day); the cloud becomes one COPC layer filed under the
 * day picked, the photos one layer of three posed cameras under the same date, and a photo opens
 * from Media.
 */
const SYNTH = join(import.meta.dirname, '..', '..', '..', 'python', 'tests', 'bentley_synth.py');

/** Answer the next open dialogs in order (Add data's files, then main's photos folder). */
async function answerDialogs(app: ElectronApplication, answers: string[][]): Promise<void> {
  await app.evaluate(({ dialog }, queue) => {
    const left = [...queue];
    dialog.showOpenDialog = () => {
      const next = left.shift();
      return Promise.resolve(
        next ? { canceled: false, filePaths: next } : { canceled: true, filePaths: [] },
      );
    };
  }, answers);
}

const manifestOf = async (dir: string) =>
  ProjectManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

async function frustums(win: Page, layerId: string): Promise<number | undefined> {
  return win.evaluate((id) => {
    const w = window as unknown as {
      __stratlas: {
        stage(): {
          scene: { getObjectByName(n: string): { children: { count?: number }[] } | undefined };
        } | null;
      };
    };
    return w.__stratlas.stage()?.scene.getObjectByName(`photos:${id}`)?.children[2]?.count;
  }, layerId);
}

test.describe('Bentley import', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!hasPdal(), 'the .zpc cloud needs PDAL (AIO_PDAL)');
  test.use({ appEnv: PIPELINE_ENV });

  test('a .zpc becomes one cloud and an AT export a layer of posed photos that open', async ({
    dataRoot,
    network,
    app,
    win,
  }) => {
    test.setTimeout(240_000);
    const fx = JSON.parse(
      execFileSync(VENV_PYTHON, [SYNTH, join(dataRoot.base, 'bentley')], {
        encoding: 'utf8',
      }).trim(),
    ) as { xml: string; photos: string; zpc: string; points: number; headerDay: string };
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    await answerDialogs(app, [[fx.zpc, fx.xml], [fx.photos]]);
    await win.keyboard.press('Control+K');
    await win.keyboard.type('Import raw data');
    await win.keyboard.press('Enter');

    // the cloud's survey day is asked first, prefilled from the LAS header (the export day)
    const card = win.getByTestId('cloud-dates-prompt');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const day = card.getByTestId('cloud-date-0-new');
    await expect(day).toHaveValue(fx.headerDay);
    await day.fill('2026-03-04');
    await card.getByTestId('cloud-dates-confirm').click();
    await expect(card).toBeHidden();

    // both jobs finish and the open project reloads its manifest with both layers
    await expect
      .poll(
        async () =>
          (await manifestOf(dataRoot.projectDir)).layers
            .map((l) => l.kind)
            .sort()
            .join(','),
        { timeout: 180_000 },
      )
      .toContain('photos');
    await expect
      .poll(
        async () =>
          (await manifestOf(dataRoot.projectDir)).layers.some(
            (l) => l.kind === 'pointcloud' && l.name === 'synthetic.zpc',
          ),
        { timeout: 180_000 },
      )
      .toBe(true);
    const m = await manifestOf(dataRoot.projectDir);
    const cloud = m.layers.find((l) => l.kind === 'pointcloud' && l.name === 'synthetic.zpc');
    expect(cloud).toMatchObject({ format: 'copc', pointCount: fx.points });
    const photos = m.layers.find((l) => l.kind === 'photos');
    if (photos?.kind !== 'photos') throw new Error('no photos layer');
    expect(photos.items).toHaveLength(3);
    for (const item of photos.items) {
      expect(item.pos).toHaveLength(3);
      expect(item.lens).toMatchObject({ model: 'pinhole', cx: 322.5 });
    }
    // the cloud and the photos share one date: the day picked, not the export day
    const sameDay = m.captures.filter((c) => c.date === '2026-03-04');
    expect(sameDay).toHaveLength(1);
    expect(m.captures.some((c) => c.date === fx.headerDay)).toBe(false);
    expect(photos.capture).toBe(sameDay[0]?.id);
    expect(cloud?.capture).toBe(photos.capture);

    // three cameras drawn in 3D
    await expect.poll(() => frustums(win, photos.id), { timeout: 60_000 }).toBe(3);

    // a photo opens from Media
    await win.locator('.nav-item', { hasText: 'Media' }).first().click();
    const first = photos.items[0]?.id ?? '';
    const tile = win.locator(`.media [data-photo="${first}"]`);
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    const viewer = win.getByTestId('photo-viewer').first();
    await expect(viewer).toBeVisible();
    await expect
      .poll(
        () =>
          viewer
            .locator('img')
            .first()
            .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(await network.outbound()).toEqual([]);
  });
});
