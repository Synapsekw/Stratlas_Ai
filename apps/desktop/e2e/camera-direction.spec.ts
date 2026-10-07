/**
 * Align camera to map (video direction keyframes, phase 1). A synthetic video-only project in
 * Kuwait (EPSG 32639): one 10 s clip whose flight log has no gimbal angles (the camera direction
 * is estimated from the track), a map pack over the site. Right-click the drone on the map, Align
 * camera to map, set a keyframe at 2 s looking 30 degrees and one at 8 s looking 90 degrees, Done:
 * the 3D camera at 5 s looks 60 degrees, orientation.json holds the keyframes (the manifest stays as
 * it was), Undo and Redo work, the
 * keyframes survive a reload, a right-click on the flight path jumps the playhead there, and
 * Clear direction keyframes (with confirm) can be undone.
 */
import { cameraQuatFromGimbal, fromWgs84 } from '@aio/geo';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, test as base, type DataRoot } from './fixtures';

const ID = 'e2e-camera-direction';
const NAME = 'E2E camera direction';
const SITE: [number, number] = [47.98, 29.38];
const START = Date.UTC(2026, 0, 5, 7, 0, 0);
const SHOTS = process.env.QUADRION_SHOTS;

type V3 = [number, number, number];

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        nowMs: number;
        setTime(ms: number): void;
        project: { manifest: { layers: { id: string }[] } } | null;
      };
    };
    videoRig(): {
      currentPose(): { q: { x: number; y: number; z: number; w: number } } | null;
    } | null;
  };
}

interface MapEl extends Element {
  __aioMap: {
    getLayer(id: string): unknown;
    getContainer(): HTMLElement;
    project(ll: [number, number]): { x: number; y: number };
    querySourceFeatures(id: string): { geometry: { type: string; coordinates: unknown } }[];
    queryRenderedFeatures(box: [[number, number], [number, number]]): { layer: { id: string } }[];
  };
}

/** Hover 2 s, then east at 6 m/s (300 m), then north. The fix changes every 200 ms. */
function truth(tMs: number): V3 {
  const s = Math.max(0, tMs - 2000) / 1000;
  const east = Math.min(s * 6, 300);
  const north = Math.max(0, s * 6 - 300);
  return [east, 40, -north];
}

/** A 10 s MP4 (20 frames of 32 x 32 at 2 fps) from the demo's own H.264 writer. */
async function clipMp4(): Promise<Buffer> {
  const url = pathToFileURL(join(import.meta.dirname, '../../../tools/demo/h264.mjs')).href;
  const h264 = (await import(url)) as {
    encodeH264Pcm(frames: Uint8Array[], w: number, h: number): unknown;
    muxMp4(enc: unknown, o: { fps: number }): Buffer;
  };
  const frames = Array.from({ length: 20 }, (_, i) => new Uint8Array(32 * 32 * 3).fill(40 + i * 8));
  return h264.muxMp4(h264.encodeH264Pcm(frames, 32, 32), { fps: 2 });
}

async function writeProject(data: DataRoot): Promise<void> {
  const dir = join(data.root, 'projects', ID);
  for (const sub of ['video', 'flights']) await mkdir(join(dir, sub), { recursive: true });
  const o = fromWgs84([SITE[0], SITE[1], 0], 32639);
  const samples = [];
  for (let i = 0; i * (1000 / 60) <= 70_000; i++) {
    const t = Math.round((i * 1000) / 60);
    // the importer's estimate: level, 30 degrees down, heading east once it moves
    samples.push({ t, pos: truth(Math.floor(t / 200) * 200), q: cameraQuatFromGimbal(90, -30, 0) });
  }
  const lens = { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 } as const;
  await writeFile(
    join(dir, 'flights', 'clip-1.json'),
    JSON.stringify({ schema: 'aio.flight/1', startUtcMs: START, lens, samples }),
  );
  await writeFile(join(dir, 'video', 'clip-1.mp4'), await clipMp4());
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: NAME,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [o[0], o[1], 0],
    captures: [{ id: 'capture-1', label: 'Synthetic capture', date: '2026-01-05' }],
    layers: [
      {
        kind: 'video',
        id: 'clip-1',
        name: 'Synthetic clip',
        src: { path: 'video/clip-1.mp4' },
        flight: { src: { path: 'flights/clip-1.json' }, startUtcMs: START },
        lens,
        offsetMs: 0,
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(input)));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
  const bbox: [number, number, number, number] = [
    SITE[0] - 0.03,
    SITE[1] - 0.03,
    SITE[0] + 0.03,
    SITE[1] + 0.03,
  ];
  const archive = pmtilesArchive({
    tiles: tilesOver(bbox, 0, 14, () => Buffer.alloc(0)),
    bbox,
    minZoom: 0,
    maxZoom: 14,
  });
  await writeFile(join(data.root, 'packs', 'e2e-site.pmtiles'), archive);
  await writeFile(
    join(data.root, 'packs', 'e2e-site.json'),
    JSON.stringify({
      id: 'e2e-site',
      label: 'E2E site',
      bbox,
      maxZoom: 14,
      sizeBytes: archive.length,
    }),
  );
}

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    await writeProject(dataRoot);
    await use(dataRoot);
  },
});

test.setTimeout(180_000);

/** Heading (degrees clockwise from grid north) of the 3D camera at clip time `ms`. */
async function headingAt(win: Page, ms: number): Promise<number | null> {
  return win.evaluate(
    async ([t0, ms]) => {
      const s = (window as unknown as Probe).__stratlas;
      s.workspace.getState().setTime(t0 + ms);
      // the rig places the camera on its next frame
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const q = s.videoRig()?.currentPose()?.q;
      if (!q) return null;
      // q * (0, 0, -1)
      const fx = -2 * (q.x * q.z + q.w * q.y);
      const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      return ((((Math.atan2(fx, -fz) * 180) / Math.PI) % 360) + 360) % 360;
    },
    [START, ms] as const,
  );
}

/** Page position of a local point on the map. */
async function mapPoint(win: Page, local: V3): Promise<{ x: number; y: number }> {
  const o = fromWgs84([SITE[0], SITE[1], 0], 32639);
  const { toWgs84 } = await import('@aio/geo');
  const ll = toWgs84([o[0] + local[0], o[1] - local[2], 0], 32639);
  return win.evaluate((ll) => {
    const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as MapEl;
    const p = el.__aioMap.project([ll[0], ll[1]]);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, ll);
}

/** Page position of the drone marker on the map, once drawn. */
async function dronePoint(win: Page): Promise<{ x: number; y: number }> {
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
            MapEl | undefined;
          if (!el?.__aioMap.getLayer('aio-drone-point')) return false;
          return el.__aioMap
            .querySourceFeatures('aio-drone')
            .some((f) => f.geometry.type === 'Point');
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return win.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as MapEl;
    const f = el.__aioMap.querySourceFeatures('aio-drone').find((x) => x.geometry.type === 'Point');
    const p = el.__aioMap.project(f?.geometry.coordinates as [number, number]);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  });
}

/** The clip's keyframes in orientation.json (aio.orientation/1), or null. */
const savedKeys = async (data: DataRoot) => {
  const file = join(data.root, 'projects', ID, 'orientation.json');
  if (!existsSync(file)) return null;
  const o = JSON.parse(await readFile(file, 'utf8')) as {
    schema: string;
    clips: Record<string, { keys: { t: number; yaw: number }[] } | undefined>;
  };
  expect(o.schema).toBe('aio.orientation/1');
  return o.clips['clip-1']?.keys ?? null;
};

/** The manifest's video layer, which the keyframes never change. */
const manifestClip = async (data: DataRoot) =>
  JSON.parse(await readFile(join(data.root, 'projects', ID, 'manifest.json'), 'utf8')) as {
    layers: Record<string, unknown>[];
  };

async function setKeyAt(win: Page, ms: number, yaw: number) {
  await win.evaluate(
    ([t0, ms]) => {
      (window as unknown as Probe).__stratlas.workspace.getState().setTime(t0 + ms);
    },
    [START, ms] as const,
  );
  await win.getByTestId('align-input-yaw').fill(String(yaw));
  await win.getByTestId('align-set-key').click();
}

test('right-click the drone, align the camera to the map with two keyframes', async ({
  win,
  dataRoot,
}) => {
  const manifestBefore = await manifestClip(dataRoot);
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
  // the estimate looks east (the track) at 5 s
  await expect.poll(() => headingAt(win, 5000), { timeout: 30_000 }).not.toBeNull();
  expect(await headingAt(win, 5000)).toBeCloseTo(90, 0);

  // right-click the drone on the map: the menu, then Align camera to map
  await headingAt(win, 0);
  const drone = await dronePoint(win);
  await win.mouse.click(drone.x, drone.y, { button: 'right' });
  const menu = win.getByTestId('drone-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Align camera to map' })).toBeVisible();
  await win.getByTestId('drone-menu-align').click();
  const bar = win.getByTestId('align-bar');
  await expect(bar).toBeVisible();
  await expect(win.getByTestId('align-status')).toContainText('No keyframes');

  // two keyframes with different headings
  await bar.locator('summary').click();
  await setKeyAt(win, 2000, 30);
  await setKeyAt(win, 8000, 90);
  await expect(win.getByTestId('align-status')).toContainText('2 keyframes');
  // the timeline shows them while aligning
  await expect(win.getByTestId('timeline-direction-key')).toHaveCount(2);
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'camera-direction-align.png') });
  await win.getByTestId('align-done').click();
  await expect(bar).toBeHidden();
  await expect(win.getByTestId('direction-notice-text')).toHaveText('Saved 2 keyframes.');

  // saved: orientation.json has the track (the manifest is unchanged), the 3D camera turns half way
  expect(await manifestClip(dataRoot)).toEqual(manifestBefore);
  await expect
    .poll(() => savedKeys(dataRoot))
    .toMatchObject([
      { t: 2000, yaw: 30 },
      { t: 8000, yaw: 90 },
    ]);
  await expect.poll(() => headingAt(win, 5000)).toBeCloseTo(60, 0);
  expect(await headingAt(win, 0)).toBeCloseTo(30, 0);

  // Undo takes them away (back to the estimate), Redo puts them back
  await win.getByTestId('direction-undo').click();
  await expect.poll(() => savedKeys(dataRoot)).toBeNull();
  await expect.poll(() => headingAt(win, 5000)).toBeCloseTo(90, 0);
  await win.getByTestId('direction-redo').click();
  await expect.poll(() => savedKeys(dataRoot)).toHaveLength(2);
  await expect.poll(() => headingAt(win, 5000)).toBeCloseTo(60, 0);

  // they survive a reload of the app and the project
  await win.reload();
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.getByTestId('timeline-direction-key')).toHaveCount(2, { timeout: 30_000 });
  await expect.poll(() => headingAt(win, 5000), { timeout: 30_000 }).toBeCloseTo(60, 0);

  // right-click on the flight path: the playhead jumps there and the menu opens
  await win.keyboard.press('Escape');
  // a point of the path well behind the drone (at 9.5 s it is 45 m east looking east, its heading
  // arrow and footprint ahead of it), once the map shows the path there
  const PATH_MS = 3_000;
  await win.evaluate((t) => {
    (window as unknown as Probe).__stratlas.workspace.getState().setTime(t);
  }, START + 9500);
  let onPath = { x: 0, y: 0 };
  await expect
    .poll(
      async () => {
        onPath = await mapPoint(win, truth(PATH_MS));
        return win.evaluate((p) => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as MapEl;
          const r = el.__aioMap.getContainer().getBoundingClientRect();
          const x = p.x - r.left;
          const y = p.y - r.top;
          const ids = el.__aioMap
            .queryRenderedFeatures([
              [x - 6, y - 6],
              [x + 6, y + 6],
            ])
            .map((f) => f.layer.id);
          return ids.includes('aio-flights-line') && !ids.some((i) => i.startsWith('aio-drone'));
        }, onPath);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await win.mouse.click(onPath.x, onPath.y, { button: 'right' });
  await expect(win.getByTestId('drone-menu')).toBeVisible();
  const now = await win.evaluate(
    () => (window as unknown as Probe).__stratlas.workspace.getState().nowMs,
  );
  // within the few metres a click on a line can miss by (6 m/s)
  expect(Math.abs(now - (START + PATH_MS))).toBeLessThan(2500);
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('drone-menu')).toBeHidden();

  // Clear direction keyframes asks once more, then clears; Undo brings them back
  const again = await dronePoint(win);
  await win.mouse.click(again.x, again.y, { button: 'right' });
  await win.getByTestId('drone-menu-clear').click();
  await expect(win.getByTestId('drone-menu-clear')).toHaveText(/Click again to clear 2 keyframes/);
  await win.getByTestId('drone-menu-clear').click();
  await expect.poll(() => savedKeys(dataRoot)).toBeNull();
  await win.getByTestId('direction-undo').click();
  await expect.poll(() => savedKeys(dataRoot)).toHaveLength(2);
});
