/**
 * Local ONNX detection (BLD-10) end to end, on synthetic data only: a project of generated photos
 * with magenta and cyan marker patches at known places, and the operator-built marker detector
 * (no trained weights) written at test time with its model card (MIT, "Stratlas test fixture").
 *
 * Covers: Settings, Detection models (runtime, import with the licence confirmed, card and licence
 * shown, a corrupt model refused with the exact error while the app stays up); Detections, Detect,
 * Local model (free, nothing sent), drafts landing on the patches within 4 px, accepting one with
 * the keyboard; Stop keeping the photos done and "Run the remaining" finishing the run. The
 * zero-network guard stays on throughout.
 *
 * When C8's shared two-date demo lands, switch to its operator-built detector and `truth.json`
 * (tools/demo/onnx-test-model.py) for the photos and expected boxes.
 */
import { ProjectManifest } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  encodePng,
  markerCard,
  markerDetectorOnnx,
  markerPhotoRgba,
  type MarkerPatch,
} from '../src/main/inference/fixtures/markerDetector';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyManifest,
  type DataRoot,
} from './fixtures';

const W = 640;
const H = 480;
/** The photos and where their patches are (the truth the boxes are checked against). */
const TRUTH: Record<string, MarkerPatch[]> = {
  p001: [{ cls: 'marker', box: [100, 120, 148, 168] }],
  p002: [
    { cls: 'marker', box: [400, 300, 440, 340] },
    { cls: 'cyan-marker', box: [60, 60, 100, 110] },
  ],
  p003: [],
};

async function project(data: DataRoot, photoIds: string[]) {
  await mkdir(join(data.projectDir, 'photos'), { recursive: true });
  for (const id of photoIds) {
    const patches = TRUTH[id] ?? [];
    await writeFile(
      join(data.projectDir, 'photos', `${id}.png`),
      encodePng(W, H, markerPhotoRgba(W, H, patches)),
    );
  }
  const base = tinyManifest();
  const manifest = ProjectManifest.parse({
    ...base,
    name: 'Marker site',
    layers: [
      ...base.layers,
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: photoIds.map((id) => ({ id, src: { path: `photos/${id}.png` } })),
      },
    ],
    severityModels: [
      {
        id: 'condition',
        name: 'Condition',
        levels: [
          { value: 1, label: 'Minor', color: '#2e7d32', criteria: 'Small mark' },
          { value: 2, label: 'Major', color: '#c62828', criteria: 'Large mark' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'markers',
        name: 'Markers',
        assetType: 'test',
        classes: [{ id: 'marker', label: 'Marker', color: '#ff00ff', severityModel: 'condition' }],
      },
    ],
  });
  await writeFile(join(data.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/** The test detector and a corrupt one, each a folder with model.onnx and model.json. */
async function models(base: string) {
  const good = join(base, 'models-src', 'markers');
  const corrupt = join(base, 'models-src', 'corrupt');
  await mkdir(good, { recursive: true });
  await mkdir(corrupt, { recursive: true });
  const onnx = markerDetectorOnnx();
  await writeFile(join(good, 'model.onnx'), onnx);
  await writeFile(join(good, 'model.json'), JSON.stringify(markerCard(onnx), null, 2));
  const junk = new TextEncoder().encode('not an onnx file, just text');
  await writeFile(join(corrupt, 'model.onnx'), junk);
  await writeFile(
    join(corrupt, 'model.json'),
    JSON.stringify(markerCard(junk, { name: 'Broken detector' }), null, 2),
  );
  return { good, corrupt };
}

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

async function start(data: DataRoot) {
  const app = await launchApp(data);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
  });
  // CPU for determinism (the plan: DirectML is compared in unit tests where available)
  await win.evaluate(() => window.aio.invoke('settings:set', { inference: { provider: 'cpu' } }));
  return { app, win, network };
}

async function importModel(app: ElectronApplication, win: Page, dir: string) {
  await nextOpenDialog(app, join(dir, 'model.json'));
  await win.getByTestId('infer-import').click();
}

async function openDetections(win: Page) {
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'Marker site' }).click();
  await expect(win.locator('.crumbs')).toContainText('Marker site');
  await win.locator('.nav-item', { hasText: 'Detections' }).click();
}

const issueCount = () =>
  (
    window as unknown as {
      __stratlas: { workspace: { getState(): { issues: unknown[] } } };
    }
  ).__stratlas.workspace.getState().issues.length;

interface Pass {
  source: string;
  assessed?: string[];
  run?: { model?: string; images?: number; costUsd?: number };
  detections: { photo: string; class: string; label?: string; status: string; bbox: number[] }[];
}

async function passes(projectDir: string): Promise<Pass[]> {
  const dir = join(projectDir, 'detections');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
    /^model-.+\.json$/.test(n),
  );
  return Promise.all(
    names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as Pass),
  );
}

test('local detection: import the test detector, find the marker patches, accept one', async () => {
  test.setTimeout(180_000);
  const data = await createDataRoot();
  let opened: ElectronApplication | null = null;
  try {
    await project(data, Object.keys(TRUTH));
    const src = await models(data.base);
    const { app, win, network } = await start(data);
    opened = app;

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
    await importModel(app, win, src.corrupt);
    await expect(win.getByTestId('infer-import-error')).toContainText(
      'The model could not be loaded:',
    );
    await expect(section).toContainText('No detection model is installed yet.');

    // The test detector: its card, classes and licence show.
    await importModel(app, win, src.good);
    await expect(win.getByTestId('infer-import-done')).toContainText(
      'Imported Marker test detector.',
    );
    const card = win.getByTestId('infer-model');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Marker test detector');
    await expect(card).toContainText('Classes: marker, cyan-marker');
    await expect(win.getByTestId('infer-licence')).toContainText('Licence: MIT');
    await expect(win.getByTestId('infer-licence')).toContainText('Stratlas test fixture');

    // Detections, Detect, Local model on every photo.
    await openDetections(win);
    await expect(win.getByTestId('det-sheet').locator('.det-tile')).toHaveCount(3);
    await win.getByTestId('det-ai-open').click();
    await win.getByTestId('det-mode-local').check();
    const dialog = win.getByTestId('det-ai-dialog');
    await expect(win.getByTestId('det-local-free')).toContainText(
      'Runs on this computer with CPU. Nothing leaves this computer. Free.',
    );
    await expect(dialog).toContainText('All 3 photos without detections');
    await expect(win.getByTestId('det-local-model')).toHaveValue('marker-test-detector-1.0.0');
    await win.getByTestId('det-local-run').click();
    const progress = win.getByTestId('det-local-progress');
    await expect(progress).toContainText('Done');
    await expect(progress).toContainText('3 of 3 photos checked, 3 proposals');
    await expect(progress).toContainText('Cost: free');
    await win.getByTestId('det-local-close').click();

    // Exactly the seeded patches, as drafts, within 4 px.
    const [pass] = await passes(data.projectDir);
    expect(pass).toMatchObject({
      source: 'model',
      assessed: ['p001', 'p002', 'p003'],
      run: { model: 'marker-test-detector-1.0.0', images: 3, costUsd: 0 },
    });
    const found = (pass?.detections ?? []).map((d) => ({ ...d, bbox: d.bbox.map(Math.round) }));
    expect(found).toHaveLength(3);
    for (const [photo, patches] of Object.entries(TRUTH)) {
      for (const p of patches) {
        const hit = found.find(
          (d) =>
            d.photo === photo &&
            (d.label ?? d.class) === (p.cls === 'marker' ? 'marker' : 'cyan-marker') &&
            d.bbox.every((v, i) => Math.abs(v - (p.box[i] ?? 0)) <= 4),
        );
        expect(hit, `${photo} ${p.cls} ${p.box.join(',')}`).toBeTruthy();
        expect(hit?.status).toBe('draft');
      }
    }
    // marker maps to the project's class; cyan-marker keeps the model's name
    expect(found.filter((d) => d.class === 'marker')).toHaveLength(2);
    expect(found.find((d) => d.label === 'cyan-marker')?.class).toBe('cyan-marker');

    // The drafts wait in the review; accept one with the keyboard.
    await expect(win.getByTestId('det-counts')).toContainText('3 waiting');
    const inspector = win.getByTestId('det-inspector');
    await win.getByTestId('det-sheet').locator('.det-tile').first().click();
    await expect(inspector).toBeVisible();
    // pick a marker detection (the project class) and accept it at severity 2
    for (let i = 0; i < 3; i++) {
      if ((await win.getByTestId('det-class').inputValue()) === 'marker') break;
      await win.keyboard.press('ArrowRight');
    }
    await expect(win.getByTestId('det-class')).toHaveValue('marker');
    await win.keyboard.press('2');
    await win.keyboard.press('a');
    await expect(win.getByTestId('det-counts')).toContainText('2 waiting · 1 accepted');
    await expect.poll(() => win.evaluate(issueCount)).toBe(1);

    const outbound = await network.outbound();
    await app.close();
    opened = null;
    expect(outbound, 'the app made network requests').toEqual([]);
  } finally {
    await opened?.close();
    await rm(data.base, { recursive: true, force: true });
  }
});

test('local detection: stop keeps the photos done, then the rest runs', async () => {
  test.setTimeout(180_000);
  const data = await createDataRoot();
  let opened: ElectronApplication | null = null;
  const ids = Array.from({ length: 60 }, (_, i) => `p${String(i + 1).padStart(3, '0')}`);
  for (const id of ids) TRUTH[id] ??= [{ cls: 'marker', box: [200, 200, 240, 240] }];
  try {
    await project(data, ids);
    const src = await models(data.base);
    const { app, win, network } = await start(data);
    opened = app;
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.getByTestId('detection-models').scrollIntoViewIfNeeded();
    await win.getByTestId('infer-accept').check();
    await importModel(app, win, src.good);
    await expect(win.getByTestId('infer-model')).toHaveCount(1);

    await openDetections(win);
    await win.getByTestId('det-ai-open').click();
    await win.getByTestId('det-mode-local').check();
    await win.getByTestId('det-local-run').click();
    const progress = win.getByTestId('det-local-progress');
    await expect(progress).toContainText(/[1-9]\d* of 60 photos checked/);
    await win.getByTestId('det-local-stop').click();
    await expect(progress).toContainText('Stopped');
    const rest = win.getByTestId('det-local-rest');
    await expect(rest).toBeVisible();
    const [stopped] = await passes(data.projectDir);
    const done = stopped?.assessed?.length ?? 0;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(60);
    expect(stopped?.detections).toHaveLength(done);

    await rest.click();
    await expect(progress).toContainText('Done');
    await expect(progress).toContainText('60 of 60 photos checked');
    const all = await passes(data.projectDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.assessed).toHaveLength(60);
    expect(all[0]?.detections).toHaveLength(60);

    const outbound = await network.outbound();
    await app.close();
    opened = null;
    expect(outbound, 'the app made network requests').toEqual([]);
  } finally {
    await opened?.close();
    await rm(data.base, { recursive: true, force: true });
  }
});
