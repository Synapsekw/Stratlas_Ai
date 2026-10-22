/**
 * Local vision-model detectors (`detect.vlm`) on the change demo (synthetic, no client data),
 * against the fake server of fake-llm.ts in place of llama-server (`QUADRION_VLM_SERVER_URL`: the
 * start gate then skips the Analytics pack, the graphics card check and the spawn, and records
 * the fake's address and a random key). The real pipeline Python runs the job.
 *
 * A detector is saved to the library (`detectors:save`), then `jobs:start` runs it on two photos
 * of the first date with threshold 0.8. The fake finds two boxes per photo and scores one 0.95
 * and the other 0.6, so the pass file `detections/vlm-<run>.json` holds four drafts, exactly one
 * per photo at or above the threshold and one flagged `belowThreshold`. The Detections review
 * lists them as waiting drafts. The zero-network guard lets through only the fake's origin, and
 * the fake saw only authorised requests. A tampered `.aiodet` is refused with its reason.
 */
import { create } from 'tar';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAnalyticsPackFiles } from '../src/main/jobs/packArchive.fakes';
import { startFakeLlm, VLM_BOXES, VLM_HIGH, VLM_LOW, type FakeLlm } from './fake-llm';
import {
  changeDemoTruth,
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  openChangeDemo,
  openProject,
  PIPELINE_ENV,
  test,
  type DataRoot,
} from './fixtures';

test.setTimeout(240_000);
test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);
test.skip(!hasPipelinePython(), 'no pipeline Python: run uv sync in python/');

const MODEL = 'qwen2.5-vl-7b-instruct-q4_k_m';
const SHA = 'a'.repeat(64);
const DETECTOR_ID = 'e2e-dark-patch';
const RUN = 'run-e2e-detectors';
const THRESHOLD = 0.8;
const PHOTOS = ['p01', 'p02'];
/** The demo photos are 1024 x 768; the job sends 1344 x 1008, so a box shrinks by this. */
const SCALE = 1024 / 1344;

const detector = (id: string, over: Record<string, unknown> = {}) => ({
  schema: 'aio.vlm-detector/1',
  id,
  name: 'Dark patch',
  version: 1,
  classId: 'patch',
  assetTypes: ['roof'],
  looksLike: 'a dark patch on the surface',
  ignore: 'shadows of the drone',
  question: 'Is this a dark patch on the surface?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: THRESHOLD,
  tunedOn: { model: MODEL, modelSha256: SHA },
  author: 'e2e',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'experimental',
  ...over,
});

interface Run {
  app: ElectronApplication;
  data: DataRoot;
  fake: FakeLlm;
  network: NetworkGuard;
  win: Page;
  stop: () => Promise<void>;
}

/** The app with the bundled demos and the fake's origin the only one the guard lets through. */
async function start(env: Record<string, string> = {}): Promise<Run> {
  const fake = await startFakeLlm({ kind: 'openai-compatible', models: [] });
  const data = await createDataRoot();
  const app = await launchApp(data, {
    ...PIPELINE_ENV,
    AIO_NETWORK_GUARD_ALLOW: fake.origin,
    QUADRION_VLM_SERVER_URL: fake.origin,
    QUADRION_DEMO: DEMO_FOLDER,
    ...env,
  });
  const network = new NetworkGuard([fake.origin]);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return {
    app,
    data,
    fake,
    network,
    win,
    stop: async () => {
      const outbound = await network.outbound();
      await app.close();
      await fake.close();
      await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      expect(outbound, 'the app made requests other than to the fake server').toEqual([]);
    },
  };
}

interface Draft {
  id: string;
  photo: string;
  class: string;
  severity: string;
  status: string;
  confidence?: number;
  bbox: number[];
  space: string;
  width: number;
  height: number;
  belowThreshold?: boolean;
  unscored?: boolean;
  origin: Record<string, unknown>;
}

test('detect.vlm on the demo: drafts in the Detections review, one per photo above 0.8', async () => {
  const testInfo = test.info();
  const run = await start();
  try {
    const { win, fake, network } = run;
    const { root } = await openChangeDemo(win);
    const layer = String(changeDemoTruth().layers.d1?.photos);
    expect(layer).toBe('photos-d1');

    // 1. the detector goes to the library
    const saved = await win.evaluate(
      (d) => window.aio.invoke('detectors:save', { where: 'library', detector: d }),
      detector(DETECTOR_ID) as never,
    );
    expect(saved).toMatchObject({ ok: true, version: 1 });

    // 2. the job, on two photos (the gate fills in the server file, model and stored detector)
    const started = await win.evaluate(
      ({ project, layer, photos, d, run, threshold }) =>
        window.aio.invoke('jobs:start', {
          pipeline: 'detect.vlm',
          project,
          params: {
            run,
            layer,
            photos,
            detectors: [{ where: 'library', detector: d, threshold }],
          },
        } as never),
      {
        project: root,
        layer,
        photos: PHOTOS,
        d: detector(DETECTOR_ID),
        run: RUN,
        threshold: THRESHOLD,
      },
    );
    expect(started.ok ? '' : started.error).toBe('');
    const jobId = started.ok ? started.job.id : '';

    // 3. it ends done
    await expect
      .poll(
        async () => {
          const { jobs } = await win.evaluate(() => window.aio.invoke('jobs:list', {}));
          const job = jobs.find((j) => j.id === jobId);
          if (job?.status === 'failed') throw new Error(`detect.vlm failed: ${job.error ?? ''}`);
          return job?.status;
        },
        { timeout: 180_000, intervals: [1000] },
      )
      .toBe('done');

    // the pass file: four drafts, the large box of each photo at or above the threshold
    const pass = JSON.parse(
      await readFile(join(root, 'detections', `vlm-${RUN}.json`), 'utf8'),
    ) as {
      source: string;
      layer: string;
      assessed: string[];
      detections: Draft[];
    };
    expect(pass).toMatchObject({ source: 'model', layer, assessed: PHOTOS });
    expect(pass.detections).toHaveLength(PHOTOS.length * VLM_BOXES.length);
    for (const photo of PHOTOS) {
      const mine = pass.detections.filter((d) => d.photo === photo);
      expect(mine).toHaveLength(2);
      const [large, small] = [...mine].sort(
        (a, b) => (b.bbox[2] ?? 0) - (b.bbox[0] ?? 0) - ((a.bbox[2] ?? 0) - (a.bbox[0] ?? 0)),
      );
      VLM_BOXES[0].bbox_2d.forEach((v, i) => {
        expect(large?.bbox[i]).toBeCloseTo(v * SCALE, 0);
      });
      expect(large).toMatchObject({
        class: 'patch',
        severity: 'uncertain',
        status: 'draft',
        space: 'source',
        width: 1024,
        height: 768,
        confidence: VLM_HIGH,
      });
      expect(large?.belowThreshold).toBeUndefined();
      expect(small).toMatchObject({ status: 'draft', confidence: VLM_LOW, belowThreshold: true });
      for (const d of mine) {
        expect(d.origin).toMatchObject({
          runId: RUN,
          model: MODEL,
          detectorId: DETECTOR_ID,
          detectorVersion: 1,
          modelSha256: SHA,
          threshold: THRESHOLD,
        });
      }
    }
    expect(pass.detections.filter((d) => !d.belowThreshold)).toHaveLength(PHOTOS.length);

    // 4. the existing review lists the drafts: all four, or only those at or above 0.8
    await win.locator('.nav-item', { hasText: 'Detections' }).click();
    const counts = win.getByTestId('det-counts');
    await expect(counts).toContainText(/\b[24] waiting\b/);
    const shot = testInfo.outputPath('detections-review.png');
    await win.screenshot({ path: shot });
    await testInfo.attach('detections-review', { path: shot, contentType: 'image/png' });

    // 5. the job spoke only to the fake, every request with the key from the state file
    const chats = fake.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(chats.length).toBeGreaterThanOrEqual(PHOTOS.length * (1 + VLM_BOXES.length));
    expect(chats.every((r) => /^Bearer [a-f0-9]{32}$/.test(r.authorization ?? ''))).toBe(true);
    expect(new Set(chats.map((r) => r.authorization)).size).toBe(1);
    for (const url of await network.allowed()) expect(url.startsWith(fake.origin)).toBe(true);
    expect((await openProject(win)).id).not.toBeNull();
  } finally {
    await run.stop();
  }
});

test('detect.vlm: a tampered .aiodet is refused with its reason', async () => {
  const run = await start();
  try {
    const { win, data } = run;
    const dir = join(data.base, 'tamper');

    // a detector folder carrying a file a detector does not hold
    const evil = join(dir, 'evil', DETECTOR_ID);
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, 'detector.json'), JSON.stringify(detector(DETECTOR_ID)));
    await writeFile(join(evil, 'payload.exe'), 'MZ');
    const extra = join(dir, 'extra.aiodet');
    await create({ gzip: true, file: extra, cwd: join(dir, 'evil') }, [DETECTOR_ID]);

    // a detector.json whose id is not its folder's
    const swapped = join(dir, 'swapped', 'some-other-folder');
    await mkdir(swapped, { recursive: true });
    await writeFile(join(swapped, 'detector.json'), JSON.stringify(detector(DETECTOR_ID)));
    const wrongFolder = join(dir, 'wrong-folder.aiodet');
    await create({ gzip: true, file: wrongFolder, cwd: join(dir, 'swapped') }, [
      'some-other-folder',
    ]);

    const imported = (path: string) =>
      win.evaluate(
        (p) => window.aio.invoke('detectors:import', { path: p, where: 'library' }),
        path,
      );
    expect(await imported(extra)).toEqual({
      ok: false,
      error:
        'This is not a detector file I can use: it holds payload.exe, which a detector does not.',
    });
    expect(await imported(wrongFolder)).toEqual({
      ok: false,
      error: `This is not a detector file I can use: its folder "some-other-folder" is not the detector id "${DETECTOR_ID}".`,
    });

    // neither reached the library
    const listed = await win.evaluate(() => window.aio.invoke('detectors:list', {}));
    expect(listed.items.some((i) => i.detector.id === DETECTOR_ID)).toBe(false);
  } finally {
    await run.stop();
  }
});

/** A stub Analytics pack (a few bytes per file) for "installed": the fake server does the work. */
async function stubPack(base: string): Promise<string> {
  const dir = join(base, 'analytics-pack-0.1.0');
  // any app version: an unpackaged e2e app may report Electron's own version
  const files = fakeAnalyticsPackFiles('0.1.0', {
    platform: `${process.platform}-${process.arch}`,
    appRange: '>=0.0.1',
  });
  for (const [name, body] of Object.entries(files)) {
    const parts = name.split('/');
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...parts), body);
  }
  return dir;
}

/**
 * The graphics card check, answered in main by a fixed card: CI has no NVIDIA card, and the Detect
 * dialog keeps Start disabled until the check passes (the gate itself skips it under the seam).
 */
async function fakeCard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('analytics:hardware');
    ipcMain.handle('analytics:hardware', () => ({
      ok: true,
      gpu: 'NVIDIA GeForce RTX 5070 Ti',
      gpuIndex: 0,
      totalMb: 16384,
      freeMb: 13517,
    }));
  });
}

/** Set a native range input (Playwright's fill sets it and fires input, which React takes). */
async function setRange(win: Page, label: string, value: number): Promise<void> {
  await win.getByRole('slider', { name: label }).fill(String(value));
}

interface LedgerLine {
  detectorId: string;
  detectionId?: string;
  verdict: string;
  reason?: string;
}

test('runs a detector from the Detect dialog and reviews its drafts', async () => {
  const testInfo = test.info();
  const packBase = await mkdtemp(join(tmpdir(), 'aio-e2e-analytics-pack-'));
  const run = await start({ QUADRION_ANALYTICS_PACK: await stubPack(packBase) });
  const shot = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await run.win.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  };
  try {
    const { app, win } = run;
    await fakeCard(app);
    await openChangeDemo(win);

    // 1. the detector goes to the library
    const saved = await win.evaluate(
      (d) => window.aio.invoke('detectors:save', { where: 'library', detector: d }),
      detector(DETECTOR_ID) as never,
    );
    expect(saved).toMatchObject({ ok: true, version: 1 });

    // 2. Detections: two photos picked, Detect, Detectors (on this computer)
    await win.locator('.nav-item', { hasText: 'Detections' }).click();
    const sheet = win.getByTestId('det-sheet');
    const tiles = sheet.locator('.det-tile');
    await expect(tiles.first()).toBeVisible();
    await tiles.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(sheet.locator('.det-tile.picked')).toHaveCount(PHOTOS.length);
    await win.getByTestId('det-ai-open').click();
    await win.getByTestId('det-mode-detectors').check();
    const dialog = win.getByTestId('det-ai-dialog');
    await expect(dialog).toBeVisible();

    // 3. the detector toggled on: no blocker, an estimate, Start
    const toggle = win.getByTestId(`det-vlm-det-${DETECTOR_ID}`);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId(`det-vlm-threshold-${DETECTOR_ID}`)).toContainText('0.80');
    await expect(win.getByTestId('det-vlm-blocker')).toHaveCount(0);
    await expect(win.getByTestId('det-vlm-estimate')).toContainText(`${PHOTOS.length} photos`);
    await shot('detect-dialog-detectors');
    await win.getByTestId('det-vlm-start').click();
    await expect(dialog).toHaveCount(0);

    // the job ends done
    await expect
      .poll(
        async () => {
          const { jobs } = await win.evaluate(() => window.aio.invoke('jobs:list', {}));
          const job = jobs.find((j) => j.pipeline === 'detect.vlm');
          if (job?.status === 'failed') throw new Error(`detect.vlm failed: ${job.error ?? ''}`);
          return job?.status;
        },
        { timeout: 180_000, intervals: [1000] },
      )
      .toBe('done');

    // 4. the review: one pass in the strip, its drafts scored by the fake
    const pass = win.getByTestId('det-vlm-pass');
    await expect(pass).toHaveCount(1, { timeout: 30_000 });
    await expect(pass).toContainText('Dark patch');
    const counts = win.getByTestId('det-vlm-counts');
    await expect(counts).toHaveText('2 shown, 2 hidden');
    await tiles.first().click();
    const score = win.getByTestId('det-vlm-score');
    await expect(score).toHaveText(VLM_HIGH.toFixed(2));

    // 5. the bar: lowered under LOW every draft shows, with both scores of the fake; raised to
    // its top (0.95, HIGH itself) only the HIGH drafts stay; lowered again they return
    const barLabel = 'Score bar for Dark patch';
    await setRange(win, barLabel, 0.5);
    await expect(counts).toHaveText('4 shown, 0 hidden');
    await expect(pass).toContainText('0.50');
    await tiles.first().click();
    const scores = new Set<string>();
    for (let i = 0; i < 4; i++) {
      scores.add((await score.textContent()) ?? '');
      await win.getByRole('button', { name: 'Next detection (J)' }).click();
    }
    expect([...scores].sort()).toEqual([VLM_LOW.toFixed(2), VLM_HIGH.toFixed(2)]);
    await setRange(win, barLabel, 0.95);
    await expect(counts).toHaveText('2 shown, 2 hidden');
    await setRange(win, barLabel, 0.5);
    await expect(counts).toHaveText('4 shown, 0 hidden');
    await setRange(win, barLabel, 0.8);
    await expect(counts).toHaveText('2 shown, 2 hidden');
    await shot('review-threshold-strip');

    // 6. reject one draft with "Not a defect": the ledger gains the line
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const ledgerFile = join(userData, 'detector-ledger', `${DETECTOR_ID}.jsonl`);
    const ledger = async (): Promise<LedgerLine[]> =>
      (await readFile(ledgerFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as LedgerLine);
    const before = (await ledger()).length;
    await tiles.first().click();
    await win.getByTestId('det-reject').click();
    const menu = win.getByRole('menu', { name: 'Why is it rejected?' });
    await expect(menu).toBeVisible();
    await shot('review-reject-reasons');
    await menu.getByRole('menuitem', { name: 'Not a defect' }).click();
    await expect(win.getByTestId('det-counts')).toContainText('1 rejected');
    await expect.poll(async () => (await ledger()).length, { timeout: 15_000 }).toBe(before + 1);
    const last = (await ledger()).at(-1);
    expect(last).toMatchObject({
      detectorId: DETECTOR_ID,
      verdict: 'rejected',
      reason: 'not-a-defect',
    });
    expect(last?.detectionId).toBeTruthy();
  } finally {
    await run.stop();
    await rm(packBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
