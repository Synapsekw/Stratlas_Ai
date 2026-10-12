/**
 * 360 video from a 360 camera's own files (the front slice of Walks 360 part W1): a two stream
 * `.insv` is stitched on import and stored in `walks/<id>/` beside the manifest, plays in the
 * 360 video pane of the split view (opened from the walk's row in the Datasets list), and a stitched MP4 comes in through "Add 360 video".
 *
 * The clips are made by ffmpeg inside the test (test patterns, a few frames), so no footage is
 * in the repo. Skipped when ffmpeg, its `v360` filter or libx264 is missing. Nothing here looks
 * at rendered pixels: the software renderer of the CI runners draws them, but slowly.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/** ffmpeg is there and can stitch and encode what the import asks for. */
function ffmpegReady(): boolean {
  const ask = (flag: string) =>
    spawnSync(FFMPEG, ['-hide_banner', flag], { encoding: 'utf8', windowsHide: true });
  try {
    const filters = ask('-filters');
    const encoders = ask('-encoders');
    return (
      filters.status === 0 &&
      /^\s*\S+\s+v360\s/m.test(filters.stdout) &&
      /\slibx264\s/.test(encoders.stdout)
    );
  } catch {
    return false;
  }
}

function ffmpeg(args: string[]): void {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

const pattern = (name: string, size: string, seconds = 3) => [
  '-f',
  'lavfi',
  '-i',
  `${name}=s=${size}:r=30:d=${String(seconds)}`,
];
const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15'];

/** A camera clip as an X4 writes it, in small: two square lens streams and sound in one file. */
function makeClip(out: string, size = '128x128', seconds = 3): void {
  ffmpeg([
    ...pattern('testsrc2', size, seconds),
    ...pattern('testsrc', size, seconds),
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${String(seconds)}`,
    '-map',
    '0:v',
    '-map',
    '1:v',
    '-map',
    '2:a',
    ...h264,
    '-c:a',
    'aac',
    '-f',
    'mp4',
    out,
  ]);
}

/** One 2:1 video: the camera's low resolution proxy, or a stitched export. */
function makeFlat(out: string, size: string): void {
  ffmpeg([...pattern('testsrc2', size), ...h264, '-an', '-f', 'mp4', out]);
}

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

async function palette(win: Page, command: string) {
  await win.keyboard.press('Control+K');
  await win.keyboard.type(command);
  await win.keyboard.press('Enter');
}

/** Every walk row of the Datasets list. */
const walkRows = (win: Page) => win.locator('[data-testid^="tree-row-walk-"]');

/** A walk's row in the Datasets list (layer `walk-<id>`), its date folder opened when it is shut. */
async function walkRow(win: Page, walkId: string): Promise<Locator> {
  const row = win.getByTestId(`tree-row-walk-${walkId}`);
  if (!(await row.isVisible())) {
    for (const folder of await win.locator('[data-testid^="date-folder-"]').all()) {
      if ((await folder.getAttribute('aria-expanded')) === 'false')
        await folder.getByRole('button').first().click();
    }
  }
  await expect(row).toBeVisible();
  return row;
}

const num = async (win: Page, testId: string, attr: string) =>
  Number(await win.getByTestId(testId).getAttribute(attr));

const CLIP = 'VID_20260101_120000_00_001.insv';
const PROXY = 'LRV_20260101_120000_01_001.lrv';
const WALK = 'vid-20260101-120000-00-001';

/** The manifest gained exactly the walk layers `walk-<id>` of these walks, each with its record. */
async function expectWalkLayer(
  manifestFile: string,
  before: string,
  walks: readonly string[],
): Promise<void> {
  const read = (text: string) =>
    (JSON.parse(text) as { layers: { id: string; kind: string; record?: { path: string } }[] })
      .layers;
  const was = read(before);
  const now = read(await readFile(manifestFile, 'utf8'));
  const added = now.filter((l) => !was.some((w) => w.id === l.id));
  expect(added.map((l) => [l.id, l.kind, l.record?.path]).sort()).toEqual(
    walks.map((id) => [`walk-${id}`, 'walk', `walks/${id}/walk.json`]).sort(),
  );
  expect(now.filter((l) => was.some((w) => w.id === l.id))).toHaveLength(was.length);
}

test.describe('360 video', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with the v360 filter and libx264 on the PATH');

  test('a camera clip is stitched on import, plays in the 360 video pane, and a stitched MP4 is added', async ({
    app,
    win,
    dataRoot,
  }) => {
    // the first import also finds out which H.264 encoder this machine has
    test.setTimeout(240_000);
    const clip = join(dataRoot.base, CLIP);
    const proxy = join(dataRoot.base, PROXY);
    const tour = join(dataRoot.base, 'Site tour.mp4');
    makeClip(clip);
    makeFlat(proxy, '128x64');
    makeFlat(tour, '256x128');
    const manifestFile = join(dataRoot.projectDir, 'manifest.json');
    const manifestBefore = await readFile(manifestFile, 'utf8');

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    // no walk yet: no 360 walks in the Datasets list, and the split does not offer the pane
    await expect(walkRows(win)).toHaveCount(0);

    // 1. import the clip with its proxy: one walk, the proxy is skipped
    await nextOpenDialog(app, [proxy, clip]);
    await palette(win, 'Import raw data');
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('Imported 1 of 2 files', { timeout: 180_000 });
    await expect(panel).toContainText('Stitched to 256 x 128');
    await expect(panel).toContainText(`low resolution copy of ${CLIP}`);
    // a raw camera file plays unstabilised, and the panel says how to get a steady picture
    await expect(panel.getByTestId('import-raw-360-hint')).toHaveCount(1);
    await expect(panel.getByTestId('import-raw-360-hint')).toContainText('FlowState');
    const folder = join(dataRoot.projectDir, 'walks', WALK);
    expect((await readdir(folder)).sort()).toEqual(
      expect.arrayContaining(['playback.mp4', 'walk.json']),
    );
    expect(await readdir(join(dataRoot.projectDir, 'walks'))).toEqual([WALK]);
    const walk = JSON.parse(await readFile(join(folder, 'walk.json'), 'utf8')) as {
      schema: string;
      source: { layout: string; streams: unknown[] };
      video: { width: number; height: number; audio: boolean };
      stitch?: { filter: string };
    };
    expect(walk).toMatchObject({
      schema: 'aio.walk/1',
      source: { layout: 'insv-dual-stream' },
      video: { width: 256, height: 128, audio: true },
    });
    expect(walk.source.streams).toHaveLength(2);
    expect(walk.stitch?.filter).toContain('v360=input=dfisheye:output=e');
    // the walk is listed as a layer of the manifest, which gained nothing else
    await expectWalkLayer(manifestFile, manifestBefore, [WALK]);
    await panel.getByRole('button', { name: 'Close' }).click();

    // 2. the walk's row in the Datasets list opens the split with the pane on the right
    await (await walkRow(win, WALK)).click();
    const pane = win.getByTestId('pane-walk360');
    await expect(pane).toBeVisible();
    await expect(win.getByTestId('pane-chooser-right').locator('select').first()).toHaveValue(
      'walk360',
    );
    const view = win.getByTestId('walk-view');
    await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await expect(view.locator('canvas')).toBeVisible();
    await expect(win.getByTestId('walk-unstabilised')).toHaveText('Not stabilised');
    await expect(win.getByTestId('walk-unstabilised')).toHaveAttribute('title', /Insta360 Studio/);
    // three seconds of test pattern; the container may round the length just under
    await expect(win.getByTestId('walk-time')).toContainText(/\/ 0:0[23]/);
    // every control of the bar lies inside the pane, also when the pane is narrow
    const edges = await win.evaluate(() => {
      const box = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      const pane = box('pane-walk360');
      const inside = (id: string) => {
        const b = box(id);
        return Boolean(
          pane && b && b.width > 0 && b.left >= pane.left - 1 && b.right <= pane.right + 1,
        );
      };
      return ['walk-play', 'walk-scrub', 'walk-sound', 'walk-reset'].filter((id) => !inside(id));
    });
    expect(edges, 'controls outside the pane').toEqual([]);

    // 3. the view is free: a click in its middle reaches the canvas, not a control over it
    const box = await view.boundingBox();
    if (!box) throw new Error('the 360 view has no box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const reached = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x ?? 0, y ?? 0);
        return Boolean(el?.closest('[data-testid="walk-view"]'));
      },
      [cx, cy],
    );
    expect(reached).toBe(true);

    // 4. drag to look, wheel to zoom
    const yaw0 = await num(win, 'walk-view', 'data-yaw');
    const fov0 = await num(win, 'walk-view', 'data-fov');
    await win.mouse.move(cx, cy);
    await win.mouse.down();
    await win.mouse.move(cx + 60, cy + 10, { steps: 4 });
    await win.mouse.up();
    await expect.poll(() => num(win, 'walk-view', 'data-yaw')).not.toBe(yaw0);
    await win.mouse.wheel(0, -240);
    await expect.poll(() => num(win, 'walk-view', 'data-fov')).toBeLessThan(fov0);
    await win.getByTestId('walk-reset').click();
    await expect.poll(() => num(win, 'walk-view', 'data-fov')).toBe(fov0);
    await expect.poll(() => num(win, 'walk-view', 'data-yaw')).toBe(yaw0);

    // 5. play, pause, scrub and the keys of the video window
    const play = win.getByTestId('walk-play');
    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Pause');
    await expect
      .poll(() => num(win, 'walk-bar', 'data-time'), { timeout: 30_000 })
      .toBeGreaterThan(0.2);
    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Play');
    await win.getByTestId('walk-scrub').fill('1');
    await expect.poll(() => num(win, 'walk-bar', 'data-time')).toBeCloseTo(1, 1);
    // a key the focused player takes does not reach listeners on the window
    await win.evaluate(() => {
      const w = window as unknown as { walkKeysSeen: string[] };
      w.walkKeysSeen = [];
      window.addEventListener('keydown', (e) => w.walkKeysSeen.push(e.key));
    });
    await view.focus();
    await win.keyboard.press('.');
    await expect.poll(() => num(win, 'walk-bar', 'data-time')).toBeGreaterThan(1.01);
    await win.keyboard.press('Space');
    await expect(play).toHaveAttribute('aria-label', 'Pause');
    await win.keyboard.press('k');
    await expect(play).toHaveAttribute('aria-label', 'Play');
    expect(
      await win.evaluate(() => (window as unknown as { walkKeysSeen: string[] }).walkKeysSeen),
    ).toEqual([]);

    // 6. a stitched MP4 through "Add 360 video": stored as it is, a second walk to choose from
    await nextOpenDialog(app, [tour]);
    await palette(win, 'Add 360 video');
    await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 120_000 });
    await expect(panel).toContainText('Stored as it is (256 x 128)');
    // the stitched MP4 brings no hint
    await expect(panel.getByTestId('import-raw-360-hint')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close' }).click();
    await walkRow(win, 'site-tour');
    await expect(walkRows(win)).toHaveCount(2);
    expect((await readdir(join(dataRoot.projectDir, 'walks'))).sort()).toEqual(['site-tour', WALK]);
    const which = win.getByTestId('walk-which');
    await expect(which.locator('option')).toHaveCount(2);
    await which.selectOption('walk-site-tour');
    await expect(win.getByTestId('walk-360')).toHaveAttribute('data-walk', 'site-tour');
    await expect(win.getByTestId('walk-view')).toHaveAttribute('data-status', 'ready', {
      timeout: 60_000,
    });
    // the stitched video has no sound, and the pane says so instead of offering it
    await expect(win.getByTestId('walk-sound')).toBeDisabled();
    // the label follows the walk on screen: gone for the MP4 walk, back for the camera walk
    await expect(win.getByTestId('walk-unstabilised')).toHaveCount(0);
    await which.selectOption(`walk-${WALK}`);
    await expect(win.getByTestId('walk-360')).toHaveAttribute('data-walk', WALK);
    await expect(win.getByTestId('walk-unstabilised')).toHaveText('Not stabilised');
    await expectWalkLayer(manifestFile, manifestBefore, [WALK, 'site-tour']);
  });

  test('Cancel stops a running stitch, adds nothing of it, and the next import works', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(300_000);
    // long and large enough to still be stitching when Cancel is clicked: 40 s of 640 x 640 per
    // lens is many seconds of work for ffmpeg, and the click comes with the first progress
    const clip = join(dataRoot.base, 'VID_20260102_090000_00_001.insv');
    const tour = join(dataRoot.base, 'Site tour.mp4');
    makeClip(clip, '640x640', 40);
    makeFlat(tour, '256x128');
    const walks = join(dataRoot.projectDir, 'walks');
    const manifestFile = join(dataRoot.projectDir, 'manifest.json');
    const manifestBefore = await readFile(manifestFile, 'utf8');

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    await nextOpenDialog(app, [clip]);
    await palette(win, 'Import raw data');
    const panel = win.getByTestId('import-panel');
    const cancel = panel.getByTestId('import-cancel');
    await expect(cancel).toBeVisible({ timeout: 60_000 });
    await expect(panel).toContainText(/playback copy \d+ %/, { timeout: 180_000 });
    await cancel.click();

    // the import ends with the clip's row saying why, and nothing of the walk is left
    await expect(panel).toContainText('Imported 0 of 1 files', { timeout: 60_000 });
    await expect(panel).toContainText('cancelled while this 360 video was made');
    // nothing of the raw file landed: no hint
    await expect(panel.getByTestId('import-raw-360-hint')).toHaveCount(0);
    await expect(panel.getByTestId('import-cancel')).toHaveCount(0);
    await expect.poll(() => readdir(walks), { timeout: 30_000 }).toEqual([]);
    await expect(walkRows(win)).toHaveCount(0);
    expect(await readFile(manifestFile, 'utf8')).toBe(manifestBefore);
    await panel.getByRole('button', { name: 'Close' }).click();

    // the import is free again: the next one runs and lands
    await nextOpenDialog(app, [tour]);
    await palette(win, 'Add 360 video');
    await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 120_000 });
    expect(await readdir(walks)).toEqual(['site-tour']);
    await walkRow(win, 'site-tour');
    await expect(walkRows(win)).toHaveCount(1);
  });

  test('an ordinary MP4 added as 360 video is refused with the reason, and nothing is stored', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    const flat = join(dataRoot.base, 'drone.mp4');
    makeFlat(flat, '160x90');
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    await nextOpenDialog(app, [flat]);
    await palette(win, 'Add 360 video');
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('Imported 0 of 1 files', { timeout: 60_000 });
    await expect(panel).toContainText('160 x 90, not a 2:1 equirectangular picture');
    await expect(walkRows(win)).toHaveCount(0);
    expect(await readdir(dataRoot.projectDir)).not.toContain('walks');
  });
});
