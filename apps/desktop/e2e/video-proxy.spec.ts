/**
 * The 1920 px review proxies on the real projects (outside CI; skipped where the projects are
 * missing or still carry the 960 px pieces). HCl: one continuous clip per flight replaced the
 * 60 s pieces, so flight 101 plays across the old 60 s boundary without stopping, and the
 * evidence frame of finding F10 (cut by the kit from the old piece `video-104-05` at 4.0 s) is what
 * the joined clip `video-104` shows at that photo's time. Al-Zour: same clips, same timing, now
 * 1920 px wide. The app runs on a temporary copy of each project (realData.ts, @realdata); the
 * real folders are only read for the expected frames.
 */
import type { Page, TestInfo } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, realDataTest } from './fixtures';
import { realProjectDir } from './realData';

const HCL = realProjectDir('hcl');
const ALZOUR = realProjectDir('alzour');

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

// The CI-sized window (1100 x 720), with the window's bands placing the Layers column as the
// installed app does (QUADRION_E2E_AUTOFOLD: below 1280 px it folds to an overlay), so the dates
// strip and its docked video tile have their real size
const test = realDataTest([], { env: { QUADRION_E2E_AUTOFOLD: '1' } });

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

/**
 * The docked tile shows its picture: the video has a box, nothing drawn stands over the middle of
 * it (a chip, a button), and the telemetry chips and the tile's buttons cover less than half of
 * the picture's middle band. Returns that covered share. A chip is an element that draws: a
 * background, or text of its own (the full-frame layers that only hold the chips do not count).
 */
async function expectTilePicture(win: Page, clip: string): Promise<number> {
  const seen = await win.locator(`[data-video-window="${clip}"] video`).evaluate((v) => {
    const r = v.getBoundingClientRect();
    const band = {
      left: r.left,
      right: r.right,
      top: r.top + r.height / 4,
      bottom: r.bottom - r.height / 4,
    };
    const draws = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      const bg = cs.backgroundColor;
      const filled = bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg);
      const text = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
      );
      return filled || text || el.tagName === 'svg' || el.tagName === 'BUTTON';
    };
    const chips = [
      ...(v.closest('[data-video-window]')?.querySelectorAll('*') ?? []),
      ...(v.closest('.vtile')?.querySelectorAll('.vtile-bar *') ?? []),
    ].filter((el) => el !== v && !el.contains(v) && draws(el));
    const boxes = chips.map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0);
    // the share of the band under any chip, sampled on a grid
    let hit = 0;
    let all = 0;
    for (let x = band.left + 2; x < band.right; x += 4)
      for (let y = band.top + 2; y < band.bottom; y += 4) {
        all++;
        if (boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) hit++;
      }
    // above the video at its middle: only layers that draw nothing
    const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const above = stack.slice(0, Math.max(0, stack.indexOf(v)));
    return {
      width: r.width,
      height: r.height,
      reached: stack.includes(v),
      over: above.filter(draws).map((el) => el.className || el.tagName),
      covered: all ? hit / all : 1,
    };
  });
  expect(seen.width, 'the docked tile has a picture').toBeGreaterThan(160);
  expect(seen.reached, 'the middle of the tile is the picture').toBe(true);
  expect(seen.over, 'chips over the middle of the tile').toEqual([]);
  expect(seen.covered, 'the chips cover the tile picture').toBeLessThan(0.5);
  return seen.covered;
}

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
  // the picture alone: the app's telemetry chips and the tile's buttons stand over the frame, and
  // in the docked tile (about 270 x 150 px) they cover a good part of the compared band
  const bare = await win.addStyleTag({
    content: `.vtile-bar, [data-video-window] *:not(video) { visibility: hidden !important; }
      [data-video-window] video { visibility: visible !important; }`,
  });
  const png = await win.screenshot({ clip: view.clip });
  await bare.evaluate((el: Node) => {
    el.parentNode?.removeChild(el);
  });
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

test.describe('@realdata HCl joined flight clips', () => {
  test.skip(
    !hclLayers.some((l) => l.id === 'video-101'),
    `HCl at ${HCL} has no joined clip video-101`,
  );
  test.use({ realProjects: ['hcl'] });

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
    const covered104 = await expectTilePicture(win, 'video-104');
    const wrong = await likeness(ref, await frameAt(win, testInfo, 'video-104', t - 20_000, 284.0));
    expect(right).toBeGreaterThan(0.8);
    expect(right - wrong).toBeGreaterThan(0.1);
    process.stdout.write(
      `  F10 likeness ${right.toFixed(3)}, 20 s earlier ${wrong.toFixed(3)}, chips over ${covered104.toFixed(2)}\n`,
    );
    expect(errors).toEqual([]);
  });
});

test.describe('@realdata Al-Zour 1920 px clips', () => {
  test.skip(
    !existsSync(join(ALZOUR, 'posters.before-1080', 'DJI_0666.jpg')),
    `Al-Zour at ${ALZOUR} has no 1920 px proxies`,
  );
  test.use({ realProjects: ['alzour'] });

  test('DJI_0666 plays at 1920 px and shows the old clip frame at 1 s', async ({
    win,
  }, testInfo) => {
    await open(win, 'Al-Zour');
    const id = 'clip-DJI_0666';
    const start = clipStart(alzourLayers, id);

    // At 1 s it shows what the old 960 px clip showed there (its poster); at 21 s it does not.
    const ref = join(ALZOUR, 'posters.before-1080', 'DJI_0666.jpg');
    const right = await likeness(ref, await frameAt(win, testInfo, id, start + 1_000, 1.0));
    const covered = await expectTilePicture(win, id);
    const v = await video(win, id);
    expect(v.src).toMatch(/\/video\/DJI_0666\.mp4$/);
    expect([v.width, v.height]).toEqual([1920, 1012]);
    const wrong = await likeness(ref, await frameAt(win, testInfo, id, start + 21_000, 21.0));
    expect(right).toBeGreaterThan(0.8);
    expect(right - wrong).toBeGreaterThan(0.1);
    process.stdout.write(
      `  DJI_0666 likeness ${right.toFixed(3)}, 20 s later ${wrong.toFixed(3)}, chips over ${covered.toFixed(2)}\n`,
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
