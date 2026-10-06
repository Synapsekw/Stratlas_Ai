/**
 * Same view on the other date (M8 C4): the Frames pane in the split pairs the frame of the playing
 * clip, or a photo, with the closest view of another survey date by camera pose, follows the clock,
 * and compares side by side, by swipe and by blend.
 *
 * Synthetic two-date project written here (no client data): two flights east over flat ground,
 * the second one 0.8 m south, 1 m higher, slower and starting 2 s before its clip, so the matching
 * frame is known exactly: date B second vB = (xA + 60) / 4 - 2 with xA = -50 + 5 vA. Clips carry
 * no footage (the pane shows "No footage"); the photos are generated textures, the later one of
 * the middle pair with a bright new "structure". When C8's two-date demo lands, this spec can
 * switch to it and take the pairs from its truth.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Page } from '@playwright/test';
import { expect, test, tinyGlb, tinyManifest } from './fixtures';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const START_A = Date.UTC(2026, 0, 1, 10, 0, 0);
const START_B = Date.UTC(2026, 5, 1, 10, 0, 0);
const LENS = { model: 'pinhole', hfovDeg: 70, aspect: 1.5 };

/** Camera heading east, 60 degrees down: three.js Euler YXZ (yaw -90, pitch -60). */
function eastDown(): [number, number, number, number] {
  const h = (d: number) => (d * Math.PI) / 360;
  const [yx, yy, yz, yw] = [0, Math.sin(h(-90)), 0, Math.cos(h(-90))];
  const [px, py, pz, pw] = [Math.sin(h(-60)), 0, 0, Math.cos(h(-60))];
  return [
    yw * px + yx * pw + yy * pz - yz * py,
    yw * py - yx * pz + yy * pw + yz * px,
    yw * pz + yx * py - yy * px + yz * pw,
    yw * pw - yx * px - yy * py - yz * pz,
  ];
}
const Q = eastDown();

function flight(start: number, x0: number, speed: number, z: number, y: number, seconds: number) {
  const samples = [];
  for (let i = 0; i <= seconds * 10; i++)
    samples.push({ t: i * 100, pos: [x0 + (speed * i) / 10, y, z], q: Q });
  return { schema: 'aio.flight/1', startUtcMs: start, lens: LENS, samples };
}

/** A grey texture of random blocks (seeded), with an optional bright square. */
async function texture(path: string, seed: number, patch: boolean) {
  const w = 240;
  const h = 160;
  const px = Buffer.alloc(w * h * 3, 90);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 120; k++) {
    const x0 = Math.floor(rnd() * w);
    const y0 = Math.floor(rnd() * h);
    const bw = 4 + Math.floor(rnd() * 24);
    const bh = 4 + Math.floor(rnd() * 24);
    const v = Math.floor(rnd() * 200);
    for (let y = y0; y < Math.min(h, y0 + bh); y++)
      for (let x = x0; x < Math.min(w, x0 + bw); x++)
        px.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
  }
  if (patch)
    for (let y = 60; y < 100; y++)
      for (let x = 100; x < 140; x++) px.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3);
  await sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(path);
}

async function writeProject(root: string) {
  const dir = join(root, 'projects', 'e2e-frames');
  for (const sub of ['models', 'video', 'photos']) await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, 'models', 'site.glb'), tinyGlb());
  await writeFile(join(dir, 'video', 'a.json'), JSON.stringify(flight(START_A, -50, 5, 0, 30, 20)));
  await writeFile(
    join(dir, 'video', 'b.json'),
    JSON.stringify(flight(START_B, -60, 4, 0.8, 31, 30)),
  );
  const photo = (id: string, x: number, z: number) => ({
    id,
    src: { path: `photos/${id}.png` },
    pos: [x, 30, z],
    q: Q,
    lens: LENS,
  });
  for (const i of [0, 1, 2]) {
    await texture(join(dir, 'photos', `p${String(i)}.png`), 11 + i, false);
    await texture(join(dir, 'photos', `q${String(i)}.png`), 11 + i, i === 1);
  }
  const video = (id: string, name: string, capture: string, start: number, offsetMs: number) => ({
    kind: 'video',
    id,
    name,
    visible: true,
    capture,
    src: { path: `video/${id}.mp4` },
    flight: {
      src: { path: `video/${id === 'clip-2026-01-01' ? 'a' : 'b'}.json` },
      startUtcMs: start,
    },
    lens: LENS,
    offsetMs,
  });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      ...tinyManifest(),
      id: 'e2e-frames',
      name: 'E2E frames',
      captures: [
        { id: 'jan', label: 'January flight', date: '2026-01-01' },
        { id: 'jun', label: 'June flight', date: '2026-06-01' },
      ],
      layers: [
        {
          kind: 'mesh',
          id: 'site',
          name: 'Site',
          visible: true,
          src: { path: 'models/site.glb' },
          transform: IDENTITY,
        },
        video('clip-2026-01-01', 'Flight 1 Jan 2026', 'jan', START_A, 0),
        video('clip-2026-06-01', 'Flight 1 Jun 2026', 'jun', START_B, 2000),
        {
          kind: 'photos',
          id: 'photos-2026-01-01',
          name: 'Photos 1 Jan 2026',
          visible: true,
          capture: 'jan',
          items: [0, 10, 20].map((x, i) => photo(`p${String(i)}`, x, 200)),
        },
        {
          kind: 'photos',
          id: 'photos-2026-06-01',
          name: 'Photos 1 Jun 2026',
          visible: true,
          capture: 'jun',
          items: [0.5, 10.5, 20.5].map((x, i) => photo(`q${String(i)}`, x, 200.2)),
        },
      ],
    }),
  );
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
}

interface Hook {
  __stratlas: {
    workspace: {
      getState(): {
        setActiveClip(id: string | null): void;
        setTime(t: number): void;
        pause(): void;
        select(s: { kind: string; id: string; layer?: string } | null): void;
      };
    };
  };
}

async function clock(win: Page, clip: string, ms: number) {
  await win.evaluate(
    ({ clip, ms }) => {
      const ws = (window as unknown as Hook).__stratlas.workspace.getState();
      ws.pause();
      ws.setActiveClip(clip);
      ws.setTime(ms);
    },
    { clip, ms },
  );
}

/** Date B's frame for date A's video second (the flights' truth). */
const truthB = (vA: number) => (-50 + 5 * vA + 60) / 4 - 2;

test('the Frames pane shows the same view of the other date and follows the clock', async ({
  win,
  dataRoot,
}) => {
  await writeProject(dataRoot.root);
  await win.getByTestId('project-card').filter({ hasText: 'E2E frames' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await clock(win, 'clip-2026-01-01', START_A + 4500);

  await win.keyboard.press('3');
  const right = win.getByTestId('pane-chooser-right').locator('select').first();
  await expect(right.locator('option[value="frames"]')).toHaveCount(1);
  await right.selectOption('frames');
  const pane = win.getByTestId('frames-pane');
  await expect(pane).toBeVisible();

  // the matching frame of June, to the frame, with the distance and angle
  const score = win.getByTestId('frames-score');
  await expect(score).toHaveAttribute('data-layer', 'clip-2026-06-01');
  const t1 = Number(await score.getAttribute('data-t'));
  expect(Math.abs(t1 - truthB(4.5))).toBeLessThanOrEqual(1 / 30 + 1e-6);
  await expect(score).toHaveText(/^1\.3 m, 0 degrees apart$/);
  await expect(pane.getByTestId('frames-compare')).toHaveAttribute('data-mode', 'side');
  await expect(pane.getByText('1 Jan 2026').first()).toBeVisible();
  await expect(pane.getByText('1 Jun 2026').first()).toBeVisible();

  // scrub date A: date B follows
  await clock(win, 'clip-2026-01-01', START_A + 12_000);
  await expect
    .poll(async () => Math.abs(Number(await score.getAttribute('data-t')) - truthB(12)))
    .toBeLessThanOrEqual(1 / 30 + 1e-6);

  // swipe: a handle the keyboard and the pointer move
  await pane.getByTestId('frames-mode-swipe').click();
  const handle = pane.getByTestId('frames-swipe');
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  await handle.focus();
  await win.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '55');
  const box = await pane.getByTestId('frames-stack').boundingBox();
  if (!box) throw new Error('no frame stack');
  await win.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeLessThanOrEqual(27);
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThanOrEqual(23);
  // lined up by the ground: the later frame is drawn through the homography
  await pane.getByTestId('frames-warp').click();
  await expect(pane.getByTestId('frames-stack')).toHaveAttribute('data-warped', '');
});

test('a photo opens the same view of the other date, and blends', async ({ win, dataRoot }) => {
  await writeProject(dataRoot.root);
  await win.getByTestId('project-card').filter({ hasText: 'E2E frames' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  // the photo pane on the left, then "Same view on the other date"
  await win.keyboard.press('3');
  await win.getByTestId('pane-chooser-left').locator('select').first().selectOption('photo');
  await win.getByTestId('pane-photo').getByTestId('same-view').click();
  const pane = win.getByTestId('frames-pane');
  await expect(pane).toBeVisible();
  const score = pane.getByTestId('frames-score');
  // the photo pane shows January's first photo: June's first photo is the same view
  await expect(score).toHaveAttribute('data-photo', 'q0');
  await expect(score).toHaveAttribute('data-layer', 'photos-2026-06-01');
  await expect(score).toHaveText(/^0\.5 m, 0 degrees apart$/);
  await expect(pane.locator('img[data-state="ready"]')).toHaveCount(2);

  // stepping through January's photos keeps the pairing
  await pane.getByRole('button', { name: 'Next photo' }).click();
  await expect(score).toHaveAttribute('data-photo', 'q1');

  // blend halfway: the June photo (with its new structure) over the January one
  await pane.getByTestId('frames-mode-blend').click();
  await pane.getByTestId('frames-blend').fill('50');
  await expect(pane.getByTestId('frames-b')).toHaveCSS('opacity', '0.5');
});
