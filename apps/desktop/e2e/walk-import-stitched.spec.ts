/**
 * Stitched 360 video on the normal import route: a small equirectangular MP4 (2:1, no SRT) added
 * through Add data becomes a walk row under 360 walks, and a 16:9 MP4 without an SRT is skipped
 * with a reason that names Add 360 video. The import panel says where each file went.
 * Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { ffmpegReady } from './walkFixture';

/** A `seconds` long test pattern of `size` (`WxH`), H.264, no audio. */
function makeMp4(out: string, size: string, seconds: number): void {
  const r = spawnSync(
    process.env.FFMPEG ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${size}:r=10:d=${String(seconds)}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-f',
      'mp4',
      out,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** The next open dialog answers `paths`, once. */
async function answerOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

/** A walk's row in the Datasets list, its date folder opened when it is shut. */
async function walkRow(win: Page, layerId: string): Promise<Locator> {
  const row = win.getByTestId(`tree-row-${layerId}`);
  await expect
    .poll(
      async () => {
        if (await row.isVisible()) return true;
        for (const folder of await win.locator('[data-testid^="date-folder-"]').all()) {
          if ((await folder.getAttribute('aria-expanded')) === 'false')
            await folder.getByRole('button').first().click();
        }
        return row.isVisible();
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return row;
}

test.describe('stitched 360 video through Add data', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a 2:1 MP4 without an SRT becomes a walk; a 16:9 one is skipped with the reason', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    // the fixture's tiny project: a raw import needs a project CRS with an EPSG code, which the
    // walk fixture's local grid project does not have
    const stitched = join(dataRoot.base, 'Site tour 360.mp4');
    const flat = join(dataRoot.base, 'flat-clip.mp4');
    makeMp4(stitched, '256x128', 4);
    makeMp4(flat, '320x180', 2);
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    await answerOpenDialog(app, [stitched, flat]);
    await win.getByTestId('add-data').click();
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('Imported 1 of 2 files', { timeout: 120_000 });
    const rows = panel.getByTestId('import-row');
    await expect(
      rows.filter({ hasText: 'Site tour 360.mp4' }).getByTestId('import-where'),
    ).toHaveText('Added as a walk under 360 walks');
    await expect(
      rows.filter({ hasText: 'flat-clip.mp4' }).getByTestId('import-where'),
    ).toContainText('Add 360 video');
    await walkRow(win, 'walk-site-tour-360');
  });
});
