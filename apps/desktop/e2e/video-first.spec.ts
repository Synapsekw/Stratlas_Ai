/**
 * A project whose first data is drone video (founder: "a video-only project shows the videos but
 * they're not located anywhere"). A synthetic project in Kuwait (EPSG 32639) holds one clip whose
 * flight log was written by the first SRT importer: 60 fps poses whose GPS fix only changes five
 * times a second, the camera heading estimated from the track (north until the aircraft moves).
 * A synthetic map pack covers the site (empty vector tiles: valid, nothing drawn). Opening it
 * shows the 3D view and the map side by side, the flight path on the map, the 3D camera framed on
 * the path, the street map under it in 3D instead of the plain ground, the Add data button, and
 * the clip's card says its camera direction is estimated.
 */
import { cameraQuatFromGimbal, fromWgs84 } from '@aio/geo';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, test as base, type DataRoot } from './fixtures';

const ID = 'e2e-video-first';
const NAME = 'E2E video first';
const CLIP = 'Synthetic clip';
const SITE: [number, number] = [47.98, 29.38];
/** Keep a screenshot here when set. */
const SHOTS = process.env.QUADRION_SHOTS;

type V3 = [number, number, number];

interface Probe {
  __stratlas: {
    stage(): {
      contentBounds(): { min: { toArray(): V3 }; max: { toArray(): V3 } } | null;
      saveView(): { position: V3; target: V3 };
      scene: { getObjectByName(n: string): { visible: boolean } | undefined };
    } | null;
  };
}

/** The flight: hover 2 s, 300 m east at 6 m/s, then north; the fix changes every 200 ms. */
function truth(tMs: number): V3 {
  const s = Math.max(0, tMs - 2000) / 1000;
  const east = Math.min(s * 6, 300);
  const north = Math.max(0, s * 6 - 300);
  return [east, 40, -north];
}

/** The first importer's heading: north until the aircraft moved, then the raw 1 s track. */
function legacyHeadings(pos: readonly V3[], t: readonly number[]): number[] {
  const out: number[] = [];
  let last = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < pos.length; i++) {
    const ti = t[i] ?? 0;
    while ((t[lo] ?? 0) < ti - 1000) lo++;
    while (hi + 1 < pos.length && (t[hi + 1] ?? 0) <= ti + 1000) hi++;
    const a = pos[lo] ?? [0, 0, 0];
    const b = pos[hi] ?? [0, 0, 0];
    if (Math.hypot(b[0] - a[0], b[2] - a[2]) > 0.3)
      last = (Math.atan2(b[0] - a[0], -(b[2] - a[2])) * 180) / Math.PI;
    out.push(last);
  }
  return out;
}

/** A tiny real MP4 (two 32 x 32 frames) from the demo's own H.264 writer. */
async function tinyMp4(): Promise<Buffer> {
  const url = pathToFileURL(join(import.meta.dirname, '../../../tools/demo/h264.mjs')).href;
  const h264 = (await import(url)) as {
    encodeH264Pcm(frames: Uint8Array[], w: number, h: number): unknown;
    muxMp4(enc: unknown, o: { fps: number }): Buffer;
  };
  const frame = () => new Uint8Array(32 * 32 * 3).fill(96);
  return h264.muxMp4(h264.encodeH264Pcm([frame(), frame()], 32, 32), { fps: 2 });
}

async function writeProject(data: DataRoot): Promise<void> {
  const dir = join(data.root, 'projects', ID);
  for (const sub of ['video', 'flights']) await mkdir(join(dir, sub), { recursive: true });
  const o = fromWgs84([SITE[0], SITE[1], 0], 32639);
  const t: number[] = [];
  const pos: V3[] = [];
  for (let i = 0; i * (1000 / 60) <= 70_000; i++) {
    const ti = Math.round((i * 1000) / 60);
    t.push(ti);
    pos.push(truth(Math.floor(ti / 200) * 200));
  }
  const h = legacyHeadings(pos, t);
  const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const samples = t.map((ti, i) => ({
    t: ti,
    pos: pos[i],
    q: cameraQuatFromGimbal(h[i] ?? 0, -30, 0).map((v) => r(v, 7)),
  }));
  const startUtcMs = Date.UTC(2026, 0, 5, 7, 0, 0);
  const lens = { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 } as const;
  await writeFile(
    join(dir, 'flights', 'clip-1.json'),
    JSON.stringify({ schema: 'aio.flight/1', startUtcMs, lens, samples }),
  );
  await writeFile(join(dir, 'video', 'clip-1.mp4'), await tinyMp4());
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
        name: CLIP,
        src: { path: 'video/clip-1.mp4' },
        flight: { src: { path: 'flights/clip-1.json' }, startUtcMs },
        lens,
        offsetMs: 0,
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(input)));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  // a map pack over the site down to street zoom: empty vector tiles (valid, nothing drawn)
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
      label: 'E2E site streets',
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

test.setTimeout(120_000);

test('a video-only project is placed on the map and framed in 3D at once', async ({ win }) => {
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('.crumbs')).toContainText(NAME);

  // the 3D view and the map side by side
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  // the map draws the flight path
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
            | (Element & {
                __aioMap: {
                  getLayer(id: string): unknown;
                  querySourceFeatures(id: string): unknown[];
                };
              })
            | undefined;
          if (!el?.__aioMap.getLayer('aio-flights-line')) return 0;
          return el.__aioMap.querySourceFeatures('aio-flights').length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // the 3D view frames the flight path (east 0 to 300 m, north to about 100 m)
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const b = (window as unknown as Probe).__stratlas.stage()?.contentBounds();
          return b ? [...b.min.toArray(), ...b.max.toArray()] : null;
        }),
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const framed = await win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas.stage();
    const b = s?.contentBounds();
    return { min: b?.min.toArray(), max: b?.max.toArray(), view: s?.saveView() };
  });
  expect(framed.max?.[0]).toBeGreaterThan(290);
  expect(framed.min?.[0]).toBeLessThan(10);
  expect(framed.min?.[2]).toBeLessThan(-90);
  // the orbit target sits inside the path's box, not at the default origin view
  expect(framed.view?.target[0]).toBeGreaterThan(100);
  expect(framed.view?.target[0]).toBeLessThan(200);

  // the street map lies under it in 3D and the plain ground is gone
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const scene = (window as unknown as Probe).__stratlas.stage()?.scene;
          return {
            street: scene?.getObjectByName('basemap:site-street-map')?.visible ?? false,
            ground: scene?.getObjectByName('env:ground')?.visible ?? true,
          };
        }),
      { timeout: 45_000 },
    )
    .toEqual({ street: true, ground: false });

  // more data can be added from the datasets panel
  await expect(win.getByTestId('add-data')).toBeVisible();

  // the clip says its camera direction is estimated
  await win.locator('.sidebar').getByText(CLIP).first().click();
  await expect(win.getByText(/Camera direction estimated from the flight path/)).toBeVisible();
  if (SHOTS) {
    await win.waitForTimeout(1500);
    await win.screenshot({ path: join(SHOTS, 'video-first.png') });
  }
});
