/**
 * Local detection on 360 video frames: the synthetic marker detector
 * (`src/main/inference/fixtures/markerDetector.ts`, plain operators, no trained weights, MIT card)
 * on a synthetic walk whose playback copy is a small equirectangular video with magenta and cyan
 * markers at known places and times, one magenta marker cut in two by the 0/360 degree seam.
 *
 * Covers: Settings, Detection models, import; Detections, Detect with AI, Local model, 360 video
 * frames, one frame every 2 s (3 frames), run; one pass on the walk layer with frame drafts in
 * the playback copy's pixels, the seam marker ONE detection whose box wraps (x1 past the width),
 * shown in two parts on its tile; the review counts; then the walk in the 360 pane at a frame
 * with markers, the look turned to the seam: the overlay draws the seam box, and Show detections
 * hides the overlay. The project is written into the test's own data root (`walkFixture.ts`);
 * the zero-network guard of the fixture stays on. Skipped without ffmpeg and libx264.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  markerCard,
  markerDetectorOnnx,
  type MarkerPatch,
} from '../src/main/inference/fixtures/markerDetector';
import { writeMarkerVideo } from '../src/main/inference/fixtures/walkVideo';
import { expect, test } from './fixtures';
import {
  createWalkProject,
  ffmpegReady,
  openWalkProject,
  WALK_LAYER,
  WALK_NAME,
  walkRow,
} from './walkFixture';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/** The playback copy: equirectangular, 2:1, 6 s at 5 frames a second. */
const W = 640;
const H = 320;
const SECONDS_PER_PICTURE = 2;

/**
 * One picture per 2 s, so the sampled frames (1, 3 and 5 s with one every 2 s) lie inside a
 * picture, never on a cut. 0 to 2 s: a magenta marker cut by the seam and a cyan one; 2 to 4 s: a
 * magenta one in the middle; 4 to 6 s: a cyan one.
 */
const PICTURES: MarkerPatch[][] = [
  [
    { cls: 'marker', box: [608, 120, 640, 160] },
    { cls: 'marker', box: [0, 120, 24, 160] },
    { cls: 'cyan-marker', box: [200, 100, 240, 140] },
  ],
  [{ cls: 'marker', box: [300, 140, 340, 180] }],
  [{ cls: 'cyan-marker', box: [420, 150, 456, 186] }],
];
const DURATION_S = PICTURES.length * SECONDS_PER_PICTURE;

/** The detections the run must find: frame time, class, box (the seam one wraps past W). */
const EXPECTED: { t: number; cls: string; box: [number, number, number, number] }[] = [
  { t: 1, cls: 'cyan-marker', box: [200, 100, 240, 140] },
  { t: 1, cls: 'marker', box: [608, 120, 664, 160] },
  { t: 3, cls: 'marker', box: [300, 140, 340, 180] },
  { t: 5, cls: 'cyan-marker', box: [420, 150, 456, 186] },
];

/** Within 4 px: the frame went through H.264 and a scale-down to the model's input. */
const near = (got: readonly number[], want: readonly number[]) =>
  got.length === want.length && got.every((v, i) => Math.abs(v - (want[i] ?? 0)) <= 4);

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

/** The marker detector and its card in `dir`; answers the card's path. */
async function writeDetector(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const onnx = markerDetectorOnnx();
  await writeFile(join(dir, 'model.onnx'), onnx);
  await writeFile(join(dir, 'model.json'), JSON.stringify(markerCard(onnx), null, 2));
  return join(dir, 'model.json');
}

interface Pass {
  source: string;
  layer?: string;
  assessed?: string[];
  run?: { model?: string; images?: number; costUsd?: number };
  detections: {
    id: string;
    class: string;
    status: string;
    bbox: number[];
    space?: string;
    width?: number;
    height?: number;
    frame?: { layer: string; t: number };
    photo?: string;
  }[];
}

/** The local model passes the run wrote into the project. */
async function passes(dir: string): Promise<Pass[]> {
  const det = join(dir, 'detections');
  const names = (await readdir(det).catch(() => [] as string[])).filter((n) =>
    /^model-.+\.json$/.test(n),
  );
  return Promise.all(
    names.map(async (n) => JSON.parse(await readFile(join(det, n), 'utf8')) as Pass),
  );
}

const num = async (win: Page, testId: string, attr: string) =>
  Number(await win.getByTestId(testId).getAttribute(attr));

/** Signed degrees from `a` to `b`, in (-180, 180]. */
const turn = (a: number, b: number) => {
  const d = (((b - a) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

/**
 * Turn the 360 view's look to `yawDeg` by dragging in it, as a person does: a drag of dx pixels
 * turns the look by dx times the vertical field of view over the view's height (`dragLook`).
 */
async function aimYaw(win: Page, yawDeg: number): Promise<void> {
  const view = win.getByTestId('walk-view');
  for (let i = 0; i < 12; i++) {
    const yaw = await num(win, 'walk-view', 'data-yaw');
    const left = turn(yaw, yawDeg);
    if (Math.abs(left) < 3) return;
    const box = await view.boundingBox();
    if (!box) throw new Error('the 360 view has no box');
    const fov = await num(win, 'walk-view', 'data-fov');
    const reach = box.width / 2 - 20;
    const dx = Math.max(-reach, Math.min(reach, (-left * box.height) / fov));
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await win.mouse.move(cx - dx / 2, cy);
    await win.mouse.down();
    await win.mouse.move(cx + dx / 2, cy, { steps: 6 });
    await win.mouse.up();
  }
  expect(Math.abs(turn(await num(win, 'walk-view', 'data-yaw'), yawDeg))).toBeLessThan(3);
}

test.describe('local detection on 360 video', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('detect every 2 s on a walk: frame drafts, one box across the seam, drawn in the 360 view', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(240_000);
    // the playback copy is made outside the project (ffmpeg's frame pictures stay out of it)
    const made = join(dataRoot.base, 'markers.mp4');
    const seconds = PICTURES.flatMap((p) => Array.from({ length: SECONDS_PER_PICTURE }, () => p));
    await writeMarkerVideo(FFMPEG, made, W, H, seconds);
    const dir = await createWalkProject(dataRoot.root, {
      drawing: false,
      processed: false,
      video: {
        make: (out) => copyFile(made, out),
        width: W,
        height: H,
        durationS: DURATION_S,
        fps: 5,
      },
    });
    const card = await writeDetector(join(dataRoot.base, 'detector'));
    // CPU for determinism
    await win.evaluate(() => window.aio.invoke('settings:set', { inference: { provider: 'cpu' } }));
    await win.reload();
    await openWalkProject(win);

    // Settings, Detection models: import the marker detector
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.getByTestId('detection-models').scrollIntoViewIfNeeded();
    await win.getByTestId('infer-accept').check();
    await nextOpenDialog(app, card);
    await win.getByTestId('infer-import').click();
    await expect(win.getByTestId('infer-import-done')).toContainText(
      'Imported Marker test detector.',
    );

    // Detections: no photos, a walk; Detect with AI, Local model, 360 video frames every 2 s
    await win.locator('.nav-item', { hasText: 'Detections' }).click();
    await win.getByTestId('det-ai-open').click();
    await win.getByTestId('det-mode-local').check();
    await win.getByTestId('det-local-scope-walk').check();
    await expect(win.getByTestId('det-local-walk')).toHaveValue(WALK_LAYER);
    await win.getByTestId('det-local-every-2').click();
    await expect(win.getByTestId('det-local-frames-count')).toHaveText('3 frames');
    const run = win.getByTestId('det-local-run');
    await expect(run).toContainText('Run on 3 frames');
    await run.click();
    const progress = win.getByTestId('det-local-progress');
    await expect(progress).toContainText('Done', { timeout: 120_000 });
    await expect(progress).toContainText(`3 of 3 frames checked, ${String(EXPECTED.length)} found`);
    await win.getByTestId('det-local-close').click();

    // one pass on the walk layer: frame drafts in the playback copy's pixels
    const all = await passes(dir);
    expect(all).toHaveLength(1);
    const pass = all[0];
    expect(pass).toMatchObject({
      source: 'model',
      layer: WALK_LAYER,
      assessed: ['t:1000', 't:3000', 't:5000'],
      run: { model: 'marker-test-detector-1.0.0', images: 3, costUsd: 0 },
    });
    const dets = [...(pass?.detections ?? [])].sort(
      (p, q) => (p.frame?.t ?? 0) - (q.frame?.t ?? 0) || (p.bbox[0] ?? 0) - (q.bbox[0] ?? 0),
    );
    // the two halves at the seam are ONE detection, its box wrapping past the width
    expect(dets.map((d) => [d.frame?.t, d.class])).toEqual(EXPECTED.map((e) => [e.t, e.cls]));
    for (const [i, e] of EXPECTED.entries())
      expect(
        near(dets[i]?.bbox ?? [], e.box),
        `${e.cls} at ${String(e.t)} s: ${String(dets[i]?.bbox)}`,
      ).toBe(true);
    for (const d of dets) {
      expect(d).toMatchObject({
        frame: { layer: WALK_LAYER },
        space: 'source',
        width: W,
        height: H,
        status: 'draft',
      });
      expect(d.photo).toBeUndefined();
    }
    const seam = dets[1];
    if (!seam) throw new Error('no seam detection');
    expect(seam.bbox[2] ?? 0).toBeGreaterThan(W);

    // the review: every draft waits, one tile per frame, the seam box drawn on both edges
    await expect(win.getByTestId('det-counts')).toContainText(`${String(EXPECTED.length)} waiting`);
    const tiles = win.getByTestId('det-sheet').locator('.det-tile');
    await expect(tiles).toHaveCount(3);
    for (const t of ['1.0', '3.0', '5.0'])
      await expect(
        win.getByTestId('det-sheet').locator(`.det-tile[title="${WALK_NAME} ${t} s"]`),
      ).toHaveCount(1);
    const first = win.getByTestId('det-sheet').locator(`.det-tile[title="${WALK_NAME} 1.0 s"]`);
    // two detections on that frame, three outlines: the seam box in two parts
    await expect(first.locator('rect.det-ol')).toHaveCount(3);

    // the 360 pane: at 1 s, the look turned to the seam (yaw 180), the seam box is drawn
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await (await walkRow(win)).click();
    const view = win.getByTestId('walk-view');
    await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await win.getByTestId('walk-scrub').fill('1');
    await expect.poll(() => num(win, 'walk-bar', 'data-time')).toBeCloseTo(1, 1);
    const overlay = win.getByTestId('walk-det-overlay');
    await expect(overlay).toBeVisible();
    const seamBox = overlay.locator(`[data-testid="walk-det-box"][data-id="${seam.id}"]`);
    // looking the other way (yaw 0), the seam marker is behind the camera
    await expect.poll(() => num(win, 'walk-view', 'data-yaw')).toBe(0);
    await expect(seamBox).toHaveCount(0);
    await aimYaw(win, 180);
    await expect(seamBox).toHaveCount(1);
    await expect(overlay.getByTestId('walk-det-box')).not.toHaveCount(0);
    // the box lies in the middle of the view, where the seam now is
    const vb = await view.boundingBox();
    const bb = await seamBox.boundingBox();
    if (!vb || !bb) throw new Error('no view or seam box on screen');
    expect(Math.abs(bb.x + bb.width / 2 - (vb.x + vb.width / 2))).toBeLessThan(vb.width / 6);

    // Show detections hides them, and brings them back
    const toggle = win.getByTestId('walk-det-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(overlay).toHaveCount(0);
    await toggle.click();
    await expect(seamBox).toHaveCount(1);
  });
});
