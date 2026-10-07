/**
 * Local ONNX detection (BLD-10) on the change demo (C8, synthetic, no client data): the demo's
 * marker detector (`sources/marker-detector/`, operator-built, no trained weights, MIT card) on
 * the demo photos of both dates, checked against `truth.json` (`detector`, `markers.photos`).
 *
 * Covers: Settings, Detection models (runtime, import with the licence confirmed, card and licence
 * shown, a corrupt model refused with the exact error while the app stays up); Detections, all
 * photos of both dates selected, Detect with AI, Local model (free, nothing sent); one draft per
 * marker box of every photo (its centre inside the box, the box inside the marker box widened by
 * 3 px), the counts per date, one pass per date; accepting two with the keyboard; Stop keeping
 * the photos done and "Run the remaining" finishing the run. The zero-network guard of the
 * fixture stays on throughout. The demo opens as a working copy, so the bundled demo is never
 * written.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type ChangeDemoTruth } from './fixtures';

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

async function prepare(app: ElectronApplication, win: Page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
  });
  // CPU for determinism (the plan: DirectML is compared in unit tests where available)
  await win.evaluate(() => window.aio.invoke('settings:set', { inference: { provider: 'cpu' } }));
}

/** A model that is not one: text bytes, with the demo detector's card renamed and re-hashed. */
async function corruptModel(dir: string, card: string) {
  await mkdir(dir, { recursive: true });
  const junk = Buffer.from('not an onnx file, just text');
  const json = JSON.parse(await readFile(card, 'utf8')) as Record<string, unknown>;
  await writeFile(join(dir, 'model.onnx'), junk);
  await writeFile(
    join(dir, 'model.json'),
    JSON.stringify(
      {
        ...json,
        name: 'Broken detector',
        sha256: createHash('sha256').update(junk).digest('hex'),
      },
      null,
      2,
    ),
  );
  return join(dir, 'model.json');
}

async function importDetector(app: ElectronApplication, win: Page, root: string, truth: Truth) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.getByTestId('detection-models').scrollIntoViewIfNeeded();
  await win.getByTestId('infer-accept').check();
  await nextOpenDialog(app, join(root, truth.detector.card));
  await win.getByTestId('infer-import').click();
  await expect(win.getByTestId('infer-model')).toHaveCount(1);
}

/** Detections, All photos, every photo of both dates selected; returns the photo count. */
async function selectAllPhotos(win: Page, truth: Truth) {
  await win.locator('.nav-item', { hasText: 'Detections' }).click();
  await win.getByRole('button', { name: 'All photos' }).click();
  const photos = truth.counts.photos.d1 + truth.counts.photos.d2;
  const tiles = win.getByTestId('det-sheet').locator('.det-tile');
  await expect(tiles).toHaveCount(photos);
  // Cmd on macOS, where Ctrl click is the secondary click and fires no click event
  await tiles.first().click({ modifiers: ['ControlOrMeta'] });
  await tiles.last().click({ modifiers: ['Shift'] });
  await expect(win.getByTestId('det-sheet').locator('.det-tile.picked')).toHaveCount(photos);
  await expect(win.getByTestId('det-ai-open')).toContainText(`Detect with AI (${photos} photos)`);
  return photos;
}

const issueCount = () =>
  (
    window as unknown as {
      __stratlas: { workspace: { getState(): { issues: unknown[] } } };
    }
  ).__stratlas.workspace.getState().issues.length;

type Truth = ChangeDemoTruth & { counts: { photos: { d1: number; d2: number } } };

interface Pass {
  name: string;
  source: string;
  layer?: string;
  assessed?: string[];
  run?: { id?: string; model?: string; images?: number; costUsd?: number };
  detections: { photo: string; class: string; label?: string; status: string; bbox: number[] }[];
}

/** The local model passes in the working copy, by photos layer. */
async function passes(root: string): Promise<Record<string, Pass>> {
  const dir = join(root, 'detections');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
    /^model-.+\.json$/.test(n),
  );
  const all = await Promise.all(
    names.map(
      async (n) => ({ name: n, ...JSON.parse(await readFile(join(dir, n), 'utf8')) }) as Pass,
    ),
  );
  return Object.fromEntries(all.map((p) => [p.layer ?? p.name, p]));
}

/** Marker boxes per layer and photo, in the order of the photos layers (`photos-d1`, ...). */
const markerBoxes = (truth: Truth) => truth.markers.photos;

/** Markers the truth puts on these photos of a layer. */
const markersOn = (truth: Truth, layer: string, photos: readonly string[]) =>
  photos.reduce((n, p) => n + (markerBoxes(truth)[layer]?.[p]?.length ?? 0), 0);

/**
 * `truth.detector.expected`: one detection per marker box of each photo, its centre inside the
 * box and its box inside the marker box widened by 3 px; no other detections.
 */
function checkAgainstTruth(pass: Pass | undefined, layer: string, truth: Truth) {
  const expected = markerBoxes(truth)[layer] ?? {};
  expect(pass, `a pass for ${layer}`).toBeTruthy();
  for (const [photo, markers] of Object.entries(expected)) {
    const found = (pass?.detections ?? []).filter((d) => d.photo === photo);
    expect(found, `${layer} ${photo}: one detection per marker`).toHaveLength(markers.length);
    for (const m of markers) {
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = m.bbox;
      const hit = found.filter((d) => {
        const [a = NaN, b = NaN, c = NaN, e = NaN] = d.bbox;
        const cx = (a + c) / 2;
        const cy = (b + e) / 2;
        const centre = cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
        const inside = a >= x0 - 3 && b >= y0 - 3 && c <= x1 + 3 && e <= y1 + 3;
        return centre && inside;
      });
      expect(hit, `${layer} ${photo} ${m.marker} ${m.bbox.join(',')}`).toHaveLength(1);
      expect(hit[0]).toMatchObject({ class: 'marker', status: 'draft' });
    }
  }
}

test('local detection: import the demo detector, find the markers of both dates, accept two', async ({
  dataRoot,
  demoProject,
}) => {
  test.setTimeout(180_000);
  const { app, win, root } = demoProject;
  const truth = demoProject.truth as Truth;
  await prepare(app, win);

  // Settings, AI providers, Detection models: the runtime is found, on CPU.
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  const section = win.getByTestId('detection-models');
  await section.scrollIntoViewIfNeeded();
  await expect(win.getByTestId('infer-runtime')).toContainText(/onnxruntime \d+\.\d+.* on CPU/);
  await expect(section).toContainText('No detection model is installed yet.');

  // Import needs the licence confirmed first.
  await expect(win.getByTestId('infer-import')).toBeDisabled();
  await win.getByTestId('infer-accept').check();

  // A corrupt model: the exact error, and the app stays up.
  const broken = await corruptModel(
    join(dataRoot.base, 'broken-model'),
    join(root, truth.detector.card),
  );
  await nextOpenDialog(app, broken);
  await win.getByTestId('infer-import').click();
  await expect(win.getByTestId('infer-import-error')).toContainText(
    'The model could not be loaded:',
  );
  await expect(section).toContainText('No detection model is installed yet.');

  // The demo detector: its card, classes and licence show.
  await nextOpenDialog(app, join(root, truth.detector.card));
  await win.getByTestId('infer-import').click();
  await expect(win.getByTestId('infer-import-done')).toContainText(
    'Imported Marker test detector.',
  );
  const card = win.getByTestId('infer-model');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Marker test detector');
  await expect(card).toContainText(`Classes: ${truth.detector.classes.join(', ')}`);
  await expect(win.getByTestId('infer-licence')).toContainText('Licence: MIT');
  await expect(win.getByTestId('infer-licence')).toContainText('Quadrion AI test fixture');

  // Detections: every photo of both dates, Detect with AI, Local model.
  const photos = await selectAllPhotos(win, truth);
  await win.getByTestId('det-ai-open').click();
  await win.getByTestId('det-mode-local').check();
  await expect(win.getByTestId('det-local-free')).toContainText(
    'Runs on this computer with CPU. Nothing leaves this computer. Free.',
  );
  await expect(win.getByTestId('det-local-model')).toHaveValue('marker-test-detector-1.0.0');
  await expect(win.getByTestId('det-local-run')).toContainText(`Run on ${photos} photos`);
  await win.getByTestId('det-local-run').click();
  const markers = Object.entries(markerBoxes(truth)).reduce(
    (n, [layer, byPhoto]) => n + markersOn(truth, layer, Object.keys(byPhoto)),
    0,
  );
  const progress = win.getByTestId('det-local-progress');
  await expect(progress).toContainText('Done');
  await expect(progress).toContainText(
    `${photos} of ${photos} photos checked, ${markers} proposals`,
  );
  await expect(progress).toContainText('Cost: free');
  await win.getByTestId('det-local-close').click();

  // One pass per date, each naming its photos layer, every marker found as a draft.
  const byLayer = await passes(root);
  const layers = Object.keys(markerBoxes(truth));
  expect(Object.keys(byLayer).sort()).toEqual([...layers].sort());
  for (const layer of layers) {
    const ids = Object.keys(markerBoxes(truth)[layer] ?? {});
    expect(byLayer[layer]).toMatchObject({
      source: 'model',
      layer,
      assessed: ids,
      run: { model: 'marker-test-detector-1.0.0', images: ids.length, costUsd: 0 },
    });
    // the count per date
    expect(byLayer[layer]?.detections, layer).toHaveLength(markersOn(truth, layer, ids));
    checkAgainstTruth(byLayer[layer], layer, truth);
  }

  // The drafts wait in the review; accept two with the keyboard (severity, then A).
  const counts = win.getByTestId('det-counts');
  await expect(counts).toContainText(`${markers} waiting`);
  const accepted = Number(/(\d+) accepted/.exec((await counts.textContent()) ?? '')?.[1] ?? NaN);
  const issuesBefore = await win.evaluate(issueCount);
  const inspector = win.getByTestId('det-inspector');
  await win.getByTestId('det-sheet').locator('.det-tile').first().click();
  await expect(inspector).toBeVisible();
  for (let i = 1; i <= 2; i++) {
    await expect(win.getByTestId('det-class')).toHaveValue('marker');
    await win.keyboard.press('2');
    await win.keyboard.press('a');
    await expect(counts).toContainText(`${markers - i} waiting · ${accepted + i} accepted`);
  }
  await expect.poll(() => win.evaluate(issueCount)).toBe(issuesBefore + 2);
});

test('local detection: stop keeps the photos done, then the rest runs', async ({ demoProject }) => {
  test.setTimeout(180_000);
  const { app, win, root } = demoProject;
  const truth = demoProject.truth as Truth;
  await prepare(app, win);
  await importDetector(app, win, root, truth);

  const photos = await selectAllPhotos(win, truth);
  await win.getByTestId('det-ai-open').click();
  await win.getByTestId('det-mode-local').check();
  // A person presses Stop once the first photo is done: the click comes from the page as the
  // first progress event lands, so the run cannot finish all photos first.
  await win.evaluate(() => {
    const off = window.aio.on('inference:progress', (e: { done: number }) => {
      if (e.done < 1) return;
      off();
      document.querySelector<HTMLButtonElement>('[data-testid="det-local-stop"]')?.click();
    });
  });
  await win.getByTestId('det-local-run').click();
  const progress = win.getByTestId('det-local-progress');
  await expect(progress).toContainText('Stopped');
  const rest = win.getByTestId('det-local-rest');
  await expect(rest).toBeVisible();

  // the photos done are kept, with exactly their markers
  const stopped = await passes(root);
  const done = Object.values(stopped).reduce((n, p) => n + (p.assessed?.length ?? 0), 0);
  expect(done).toBeGreaterThan(0);
  expect(done).toBeLessThan(photos);
  await expect(rest).toContainText(`Run the remaining ${photos - done}`);
  for (const [layer, pass] of Object.entries(stopped))
    expect(pass.detections, layer).toHaveLength(markersOn(truth, layer, pass.assessed ?? []));

  await rest.click();
  await expect(progress).toContainText('Done');
  await expect(progress).toContainText(`${photos} of ${photos} photos checked`);
  const all = await passes(root);
  const layers = Object.keys(markerBoxes(truth));
  expect(Object.keys(all).sort()).toEqual([...layers].sort());
  for (const layer of layers) {
    const ids = Object.keys(markerBoxes(truth)[layer] ?? {});
    // the same run, resumed: every photo once, in order
    expect(all[layer]?.assessed).toEqual(ids);
    expect(all[layer]?.run?.id).toBe(Object.values(stopped)[0]?.run?.id);
    checkAgainstTruth(all[layer], layer, truth);
  }
});
