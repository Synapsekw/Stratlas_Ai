/**
 * The 1920 px review proxies on the real projects (outside CI; skipped where the projects are
 * missing or still carry the 960 px pieces). HCl: one continuous clip per flight replaced the
 * 60 s pieces, so flight 101 plays across the old 60 s boundary without stopping, and the
 * evidence frame of finding F10 (cut by the kit from the old piece `video-104-05` at 4.0 s) is what
 * the joined clip `video-104` shows at that photo's time. Al-Zour: same clips, same timing, now
 * 1920 px wide. Read-only: nothing in the projects is written.
 */
import { test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const HCL = join(DATA, 'projects', 'hcl');
const ALZOUR = join(DATA, 'projects', 'alzour');

interface Layer {
  id: string;
  kind: string;
  offsetMs?: number;
  flight?: { startUtcMs: number };
  items?: { id: string; takenAt?: string; src: { path: string } }[];
}
const layersOf = (root: string): Layer[] => {
  const file = join(root, 'manifest.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { layers: Layer[] }).layers;
};
const hclLayers = layersOf(HCL);
const alzourLayers = layersOf(ALZOUR);
const clipStart = (layers: Layer[], id: string): number => {
  const l = layers.find((x) => x.id === id);
  if (!l?.flight || l.offsetMs === undefined) throw new Error(`no clip ${id}`);
  return l.flight.startUtcMs + l.offsetMs;
};

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        nowMs: number;
        playing: boolean;
        activeClip: string | null;
        setActiveClip(id: string | null): void;
        setTime(t: number): void;
        play(): void;
        pause(): void;
      };
      subscribe(fn: (s: { playing: boolean; activeClip: string | null }) => void): () => void;
    };
  };
}

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-proxy-'));
    const network = new NetworkGuard();
    const app = await launchApp({
      base: dir,
      root: DATA,
      userData: join(dir, 'user'),
      projectId: 'hcl',
      projectDir: HCL,
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.setTimeout(180_000);

async function open(win: Page, card: string) {
  await win.getByTestId('project-card').filter({ hasText: card }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 30_000 });
}

/** Make a clip active at a project time (what a video sighting does), optionally playing. */
const seek = (win: Page, clip: string, tMs: number, play: boolean) =>
  win.evaluate(
    ([c, t, p]) => {
      const ws = (window as unknown as Inspect).__stratlas.workspace.getState();
      ws.pause();
      ws.setActiveClip(c);
      ws.setTime(t);
      if (p) ws.play();
    },
    [clip, tMs, play] as const,
  );

const video = (win: Page, clip: string) =>
  win.locator(`[data-video-window="${clip}"] video`).evaluate((v: HTMLVideoElement) => ({
    t: v.currentTime,
    src: v.currentSrc,
    width: v.videoWidth,
    height: v.videoHeight,
    seeking: v.seeking,
    ready: v.readyState,
  }));

/** What a clip's video shows: grey pixels of its element and the part of the picture in view. */
interface Shown {
  pix: Uint8Array;
  /** Fractions of the picture's width and height in view (object-fit cover crops the middle). */
  fx: number;
  fy: number;
}

/**
 * Seek `clip` (paused) to project time `tMs`, wait until its video stands at `atS` seconds, and
 * grab what it shows. The screenshot is kept in the test output.
 */
async function frameAt(
  win: Page,
  info: TestInfo,
  clip: string,
  tMs: number,
  atS: number,
): Promise<Shown> {
  await seek(win, clip, tMs, false);
  await expect
    .poll(
      async () => {
        const v = await video(win, clip);
        return !v.seeking && v.ready >= 2 ? v.t : -1;
      },
      { timeout: 30_000 },
    )
    .toBeCloseTo(atS, 1);
  await win.waitForTimeout(700);
  const el = win.locator(`[data-video-window="${clip}"] video`);
  const view = await el.evaluate((v: HTMLVideoElement) => {
    const r = v.getBoundingClientRect();
    const cover = getComputedStyle(v).objectFit === 'cover';
    const sx = r.width / v.videoWidth;
    const sy = r.height / v.videoHeight;
    const k = cover ? Math.max(sx, sy) : Math.min(sx, sy);
    const w = v.videoWidth * k;
    const h = v.videoHeight * k;
    // the on-screen rectangle that shows picture, and the fraction of the picture it shows
    const cw = Math.min(w, r.width);
    const ch = Math.min(h, r.height);
    return {
      clip: { x: r.x + (r.width - cw) / 2, y: r.y + (r.height - ch) / 2, width: cw, height: ch },
      fx: cw / w,
      fy: ch / h,
    };
  });
  const png = await win.screenshot({ clip: view.clip });
  await writeFile(info.outputPath(`${clip}-${atS.toFixed(1)}s.png`), png);
  return { pix: await grey(png), fx: view.fx, fy: view.fy };
}

const GW = 64;
const GH = 36;

/** Grey GWxGH pixels of an image, or of the middle `fx` x `fy` of it. */
async function grey(img: Buffer | string, fx = 1, fy = 1): Promise<Uint8Array> {
  const meta = await sharp(img).metadata();
  const w = Math.round(meta.width * fx);
  const h = Math.round(meta.height * fy);
  return new Uint8Array(
    await sharp(img)
      .extract({
        left: Math.floor((meta.width - w) / 2),
        top: Math.floor((meta.height - h) / 2),
        width: w,
        height: h,
      })
      .resize(GW, GH, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer(),
  );
}

/** How alike a reference image is to what the video shows, leaving out the HUD bands. */
async function likeness(ref: string, shown: Shown): Promise<number> {
  const band = (p: Uint8Array) => p.subarray(GW * 9, GW * (GH - 9));
  return ncc(band(await grey(ref, shown.fx, shown.fy)), band(shown.pix));
}

function ncc(a: Uint8Array, b: Uint8Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  ma /= a.length;
  mb /= b.length;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}

/** Watch the store: did playback stop or switch clips at any moment since the call? */
const watchPlayback = (win: Page) =>
  win.evaluate(() => {
    const w = window as unknown as Inspect & { __proxyWatch?: { stops: number; clips: string[] } };
    const log = { stops: 0, clips: [] as string[] };
    w.__proxyWatch = log;
    w.__stratlas.workspace.subscribe((s) => {
      if (!s.playing) log.stops++;
      if (s.activeClip && !log.clips.includes(s.activeClip)) log.clips.push(s.activeClip);
    });
  });
const watched = (win: Page) =>
  win.evaluate(
    () => (window as unknown as { __proxyWatch: { stops: number; clips: string[] } }).__proxyWatch,
  );

test.describe('HCl joined flight clips', () => {
  test.skip(
    !hclLayers.some((l) => l.id === 'video-101'),
    `HCl at ${HCL} has no joined clip video-101`,
  );

  test('a click on a whole-flight bar plays from the clicked point', async ({ win }) => {
    await open(win, 'HCl');
    const start = clipStart(hclLayers, 'video-101');
    const bar = win.locator('.seg-c[title^="Flight 101"]').first();
    await expect(bar).toBeVisible({ timeout: 30_000 });
    const box = await bar.boundingBox();
    if (!box) throw new Error('no flight 101 bar');
    await bar.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
    const now = await win.evaluate(
      () => (window as unknown as Inspect).__stratlas.workspace.getState().nowMs,
    );
    const len = 386_050;
    // within a pixel or two of three quarters in, not the clip start
    expect(Math.abs(now - (start + 0.75 * len))).toBeLessThan(len * 0.05);
  });

  test('flight 101 plays across the old 60 s boundary; F10 evidence is at its time', async ({
    win,
  }, testInfo) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    await open(win, 'HCl');

    // Play from 56 s to past 64 s of the joined clip: one clip, no stop at 60 s.
    const start = clipStart(hclLayers, 'video-101');
    await seek(win, 'video-101', start + 56_000, false);
    await expect
      .poll(async () => (await video(win, 'video-101')).ready, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    const v0 = await video(win, 'video-101');
    expect(v0.src).toMatch(/\/video\/v101\.mp4$/);
    expect([v0.width, v0.height]).toEqual([1920, 1080]);
    await watchPlayback(win);
    await win.evaluate(() => {
      (window as unknown as Inspect).__stratlas.workspace.getState().play();
    });
    await expect
      .poll(
        () =>
          win.evaluate(() => (window as unknown as Inspect).__stratlas.workspace.getState().nowMs),
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(start + 64_000);
    const w = await watched(win);
    expect(w.stops).toBe(0);
    expect(w.clips).toEqual(['video-101']);
    expect((await video(win, 'video-101')).t).toBeGreaterThan(63);

    // F10: its evidence photo is a frame the kit cut from piece video-104-05 at 4.0 s; the photo
    // time is the frame's project time. The joined clip must show that frame there (304.0 s).
    const photos = hclLayers.find((l) => l.kind === 'photos');
    const shot = photos?.items?.find((p) => p.id === 'F10_r-016-050');
    if (!shot?.takenAt) throw new Error('no F10 evidence photo');
    const t = Date.parse(shot.takenAt);
    const s104 = clipStart(hclLayers, 'video-104');
    expect((t - s104) / 1000).toBeCloseTo(304.0, 1);
    // At the photo time the clip shows the evidence frame; 20 s earlier it does not.
    const ref = join(HCL, shot.src.path);
    const right = await likeness(ref, await frameAt(win, testInfo, 'video-104', t, 304.0));
    const wrong = await likeness(ref, await frameAt(win, testInfo, 'video-104', t - 20_000, 284.0));
    expect(right).toBeGreaterThan(0.8);
    expect(right - wrong).toBeGreaterThan(0.1);
    process.stdout.write(`  F10 likeness ${right.toFixed(3)}, 20 s earlier ${wrong.toFixed(3)}\n`);
    expect(errors).toEqual([]);
  });
});

test.describe('Al-Zour 1920 px clips', () => {
  test.skip(
    !existsSync(join(ALZOUR, 'posters.before-1080', 'DJI_0666.jpg')),
    `Al-Zour at ${ALZOUR} has no 1920 px proxies`,
  );

  test('DJI_0666 plays at 1920 px and shows the old clip frame at 1 s', async ({
    win,
  }, testInfo) => {
    await open(win, 'Al-Zour');
    const id = 'clip-DJI_0666';
    const start = clipStart(alzourLayers, id);

    // At 1 s it shows what the old 960 px clip showed there (its poster); at 21 s it does not.
    const ref = join(ALZOUR, 'posters.before-1080', 'DJI_0666.jpg');
    const right = await likeness(ref, await frameAt(win, testInfo, id, start + 1_000, 1.0));
    const v = await video(win, id);
    expect(v.src).toMatch(/\/video\/DJI_0666\.mp4$/);
    expect([v.width, v.height]).toEqual([1920, 1012]);
    const wrong = await likeness(ref, await frameAt(win, testInfo, id, start + 21_000, 21.0));
    expect(right).toBeGreaterThan(0.8);
    expect(right - wrong).toBeGreaterThan(0.1);
    process.stdout.write(
      `  DJI_0666 likeness ${right.toFixed(3)}, 20 s later ${wrong.toFixed(3)}\n`,
    );

    // Seek deep into the clip and play on.
    await seek(win, id, start + 150_000, true);
    await watchPlayback(win);
    await expect
      .poll(
        () =>
          win.evaluate(() => (window as unknown as Inspect).__stratlas.workspace.getState().nowMs),
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(start + 154_000);
    expect((await watched(win)).stops).toBe(0);
    expect((await video(win, id)).t).toBeGreaterThan(153.5);
  });
});
