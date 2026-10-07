/**
 * Align photo to map. A synthetic project in Kuwait (EPSG 32639) whose photos were imported by the
 * real raw import from DJI JPEGs with XMP gimbal angles (heading 90, 45 degrees down): two taken a
 * metre apart (one cluster on the map), a third 40 m away a few minutes later, a fourth an hour
 * later (another flight). Right-click the cluster on the map: its photos are listed; pick one,
 * Align photo to map, turn it to heading 80, Done: the photo is saved as a correction (the
 * imported pose unchanged), the 3D frustum turns, and the two other photos of that flight take the
 * same correction on request (not the photo of the later flight). Undo takes it back; Reset
 * alignment from the menu can be undone too.
 */
import { fromWgs84 } from '@aio/geo';
import { importRawFiles, NO_PIPELINE } from '@aio/project/builder';
import { withExif } from '@aio/project/builder/testing';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, test as base, type DataRoot } from './fixtures';

const ID = 'e2e-photo-align';
const NAME = 'E2E photo align';
const SITE: [number, number] = [47.98, 29.38];
const SHOTS = process.env.QUADRION_SHOTS;

interface PhotoItem {
  id: string;
  pos?: number[];
  q?: number[];
  takenAt?: string;
  correction?: { yawDeg: number; pitchDeg: number; rollDeg: number };
}

interface MapEl extends Element {
  __aioMap: {
    getContainer(): HTMLElement;
    getLayer(id: string): unknown;
    project(ll: [number, number]): { x: number; y: number };
    querySourceFeatures(id: string): {
      properties: Record<string, unknown> | null;
      geometry: { type: string; coordinates: unknown };
    }[];
  };
}

interface Probe {
  __stratlas: {
    stage(): {
      scene: {
        traverse(
          f: (o: {
            name: string;
            userData: Record<string, unknown>;
            getMatrixAt?: (i: number, m: unknown) => void;
          }) => void,
        ): void;
      };
    } | null;
  };
}

async function writeProject(data: DataRoot): Promise<void> {
  const dir = join(data.root, 'projects', ID);
  await mkdir(dir, { recursive: true });
  const o = fromWgs84([SITE[0], SITE[1], 0], 32639);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: NAME,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [o[0], o[1], 0],
    captures: [{ id: 'capture-1', label: 'Synthetic capture', date: '2026-01-05' }],
    layers: [],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(input)));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));

  // four DJI photos with XMP gimbal angles, imported by the real raw import
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 140, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const shots: [string, number, number, string][] = [
    // name, metres east, metres north, time
    ['DJI_0001', 0, 0, '2026:01:05 10:00:00'],
    ['DJI_0002', 1, 0, '2026:01:05 10:01:00'],
    ['DJI_0003', 40, 30, '2026:01:05 10:05:00'],
    ['DJI_0004', 80, -20, '2026:01:05 11:30:00'],
  ];
  const paths: string[] = [];
  for (const [name, e, n, time] of shots) {
    const { toWgs84 } = await import('@aio/geo');
    const ll = toWgs84([o[0] + e, o[1] + n, 0], 32639);
    const file = join(data.base, `${name}.JPG`);
    await writeFile(
      file,
      withExif(
        {
          make: 'DJI',
          lat: ll[1],
          lon: ll[0],
          alt: 40,
          focal35: 24,
          width: 64,
          height: 48,
          dateTimeOriginal: time,
          dji: {
            GimbalYawDegree: '+90.0',
            GimbalPitchDegree: '-45.0',
            GimbalRollDegree: '0',
            AbsoluteAltitude: '+40.00',
            RelativeAltitude: '+40.00',
          },
        },
        jpeg,
      ),
    );
    paths.push(file);
  }
  await importRawFiles(dir, paths, {
    images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
    jobs: NO_PIPELINE,
    utcOffsetMin: 180,
  });

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

/** The photos of the manifest with their corrections from orientation.json. */
const photos = async (data: DataRoot): Promise<PhotoItem[]> => {
  const dir = join(data.root, 'projects', ID);
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    layers: { kind: string; id: string; items?: PhotoItem[] }[];
  };
  const set = m.layers.find((l) => l.kind === 'photos');
  const o = existsSync(join(dir, 'orientation.json'))
    ? (JSON.parse(await readFile(join(dir, 'orientation.json'), 'utf8')) as {
        photos: Record<string, Record<string, PhotoItem['correction']> | undefined>;
      })
    : null;
  return (set?.items ?? []).map((p) => {
    // the manifest's photo records never carry a correction
    expect(p).not.toHaveProperty('correction');
    const c = set ? o?.photos[set.id]?.[p.id] : undefined;
    return c ? { ...p, correction: c } : p;
  });
};

/** Page position of the photo cluster on the map, once drawn. */
async function clusterAt(win: Page): Promise<{ x: number; y: number }> {
  const found: { at: { x: number; y: number } | null } = { at: null };
  await expect
    .poll(
      async () => {
        found.at = await win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
            MapEl | undefined;
          if (!el?.__aioMap.getLayer('aio-photos-pt')) return null;
          const f = el.__aioMap
            .querySourceFeatures('aio-photos')
            .find((x) => x.properties?.cluster_id !== undefined);
          if (!f) return null;
          const p = el.__aioMap.project(f.geometry.coordinates as [number, number]);
          const r = el.__aioMap.getContainer().getBoundingClientRect();
          return { x: r.left + p.x, y: r.top + p.y };
        });
        return found.at !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found.at ?? { x: 0, y: 0 };
}

/** Heading of a photo's frustum in 3D (degrees clockwise from grid north). */
async function frustumHeading(win: Page, id: string): Promise<number | null> {
  return win.evaluate((id) => {
    let out: number | null = null;
    (window as unknown as Probe).__stratlas.stage()?.scene.traverse((o) => {
      const ids = o.userData.photoIds as string[] | undefined;
      if (o.name !== 'photo-planes' || !ids || !o.getMatrixAt) return;
      const i = ids.indexOf(id);
      if (i < 0) return;
      const m = { elements: new Array<number>(16).fill(0) };
      // a Matrix4-like target: getMatrixAt calls m.fromArray(array, offset)
      const target = {
        ...m,
        fromArray(a: ArrayLike<number>, off: number) {
          for (let k = 0; k < 16; k++) m.elements[k] = a[off + k] ?? 0;
          return target;
        },
      };
      o.getMatrixAt(i, target);
      const e = m.elements;
      // forward = -(third column), normalised in plan
      const fx = -(e[8] ?? 0);
      const fz = -(e[10] ?? 0);
      out = ((((Math.atan2(fx, -fz) * 180) / Math.PI) % 360) + 360) % 360;
    });
    return out;
  }, id);
}

test('right-click a photo cluster, align a photo to the map, correct its flight', async ({
  win,
  dataRoot,
}) => {
  const before = await photos(dataRoot);
  expect(before.map((p) => p.id)).toHaveLength(4);
  const imported = Object.fromEntries(before.map((p) => [p.id, p.q]));
  const p2 = before[1]?.id ?? '';

  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('.crumbs')).toContainText(NAME);
  // the map and 3D side by side, so the photos show as pins
  await win.evaluate(() => {
    (
      window as unknown as { __stratlas: { workspace: { getState(): { select(s: null): void } } } }
    ).__stratlas.workspace
      .getState()
      .select(null);
  });
  // heading 90 from true north is a little more from grid north (meridian convergence)
  await expect.poll(() => frustumHeading(win, p2), { timeout: 30_000 }).not.toBeNull();
  const h0 = (await frustumHeading(win, p2)) ?? 0;
  expect(Math.abs(h0 - 90)).toBeLessThan(3);
  const fix = Math.round((80 - h0) * 1000) / 1000;

  // a photo-only project may open on the 3D view alone: the menu needs the map
  const mode = await win.locator('.stage').getAttribute('data-mode');
  if (mode !== 'split') await win.getByRole('button', { name: /split/i }).first().click();

  // right-click the cluster of the first two photos: they are listed, then one photo's menu
  const cluster = await clusterAt(win);
  await win.mouse.click(cluster.x, cluster.y, { button: 'right' });
  const listed = win.getByTestId('photo-menu-list');
  await expect(listed).toBeVisible();
  await expect(listed.getByRole('menuitem')).toHaveCount(2);
  await listed.getByRole('menuitem', { name: p2 }).click();
  const menu = win.getByTestId('photo-menu');
  await expect(menu.getByRole('menuitem', { name: 'Align photo to map' })).toBeVisible();
  await win.getByTestId('photo-menu-align').click();

  // turn it to heading 80 in exact values, Done
  const bar = win.getByTestId('photo-align-bar');
  await expect(bar).toBeVisible();
  await bar.locator('summary').click();
  await win.getByTestId('photo-align-input-yaw').fill('80');
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'photo-align.png') });
  await win.getByTestId('photo-align-done').click();
  await expect(bar).toBeHidden();
  await expect(win.getByTestId('photo-align-notice-text')).toHaveText('Photo alignment saved.');

  // saved as a correction; the imported pose is unchanged; the 3D frustum turned
  await expect
    .poll(async () => (await photos(dataRoot)).find((p) => p.id === p2)?.correction?.yawDeg)
    .toBeCloseTo(fix, 1);
  expect((await photos(dataRoot)).find((p) => p.id === p2)?.q).toEqual(imported[p2]);
  await expect.poll(() => frustumHeading(win, p2), { timeout: 30_000 }).toBeCloseTo(80, 0);
  const saved = (await photos(dataRoot)).find((p) => p.id === p2)?.correction?.yawDeg ?? NaN;
  const fix2 = () => saved;

  // the two other photos of that flight take the same correction; the later flight does not
  await expect(win.getByTestId('photo-align-flight')).toHaveText(
    'Apply the same correction to the 2 other photos from this flight',
  );
  await win.getByTestId('photo-align-flight').click();
  await expect
    .poll(async () => (await photos(dataRoot)).map((p) => p.correction?.yawDeg ?? null))
    .toEqual([fix2(), fix2(), fix2(), null]);
  // Undo takes it back from those two
  await win.getByTestId('photo-align-undo').click();
  await expect
    .poll(async () => (await photos(dataRoot)).map((p) => p.correction?.yawDeg ?? null))
    .toEqual([null, fix2(), null, null]);

  // Reset alignment from the menu, then Undo
  const again = await clusterAt(win);
  await win.mouse.click(again.x, again.y, { button: 'right' });
  await win.getByTestId('photo-menu-list').getByRole('menuitem', { name: p2 }).click();
  await win.getByTestId('photo-menu-reset').click();
  await expect
    .poll(async () => (await photos(dataRoot)).find((p) => p.id === p2)?.correction)
    .toBeUndefined();
  await win.getByTestId('photo-align-undo').click();
  await expect
    .poll(async () => (await photos(dataRoot)).find((p) => p.id === p2)?.correction?.yawDeg)
    .toBeCloseTo(fix, 1);
});
