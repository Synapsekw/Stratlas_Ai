/**
 * COPC point clouds end to end on a synthetic project (no client data): the 16 000 point fixture
 * of @aio/pointcloud (ground, a building, trees; ASPRS classes 2, 6 and 5) streams through
 * aio:// range reads into the worker pool, colours by classification with a legend, hides a
 * class, and shows in the perf HUD; colours by elevation over the points' own heights (not the
 * octree cube) with a hand-set range from the point cloud panel. Runs everywhere.
 */
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, tinyManifest } from './fixtures';

const FIXTURE = join(
  import.meta.dirname,
  '../../../packages/pointcloud/test-data/synthetic.copc.laz',
);
const SHOTS = process.env.QUADRION_SHOTS;

interface Inspect {
  __stratlas: {
    stage(): {
      perfStats(): { points: number; frames: number };
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
    } | null;
    pointcloud: {
      getState(): {
        setColourMode(m: string): void;
        setEdl(on: boolean): void;
        setHeightRange(r: [number, number] | null): void;
        heightRange: [number, number] | null;
      };
    };
  };
}

interface Ramp {
  /** uHeight of every drawn node. */
  ranges: [number, number][];
  /** Ramp position (0 bottom, 1 top) of sampled points, sorted. */
  ts: number[];
}

/** The elevation uniform of each drawn node and where its points fall on the ramp (EDL off). */
function readRamp(): Ramp {
  interface Obj {
    children: Obj[];
    isPoints?: boolean;
    matrixWorld: { elements: number[] };
    geometry?: { attributes: { position: { array: ArrayLike<number>; count: number } } };
    material?: { uniforms?: { uHeight?: { value: { x: number; y: number } } } };
  }
  const st = (
    window as unknown as { __stratlas: { stage(): { scene: Obj } | null } }
  ).__stratlas.stage();
  const ranges: [number, number][] = [];
  const ts: number[] = [];
  const walk = (o: Obj) => {
    const u = o.material?.uniforms?.uHeight?.value;
    if (o.isPoints && o.geometry && u) {
      ranges.push([u.x, u.y]);
      const p = o.geometry.attributes.position;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < p.count; i += 7) {
        const y =
          (e[1] ?? 0) * (p.array[3 * i] ?? 0) +
          (e[5] ?? 0) * (p.array[3 * i + 1] ?? 0) +
          (e[9] ?? 0) * (p.array[3 * i + 2] ?? 0) +
          (e[13] ?? 0);
        ts.push((y - u.x) / Math.max(1e-3, u.y - u.x));
      }
    }
    for (const c of o.children) walk(c);
  };
  if (st) walk(st.scene);
  ts.sort((a, b) => a - b);
  return { ranges, ts };
}

test.beforeEach(async ({ dataRoot }) => {
  const base = tinyManifest();
  const manifest: ProjectManifestInput = {
    ...base,
    layers: [
      {
        kind: 'pointcloud',
        id: 'synthetic',
        name: 'Synthetic COPC cloud',
        src: { path: 'clouds/synthetic.copc.laz' },
        format: 'copc',
        pointCount: 16000,
      },
    ],
  };
  await mkdir(join(dataRoot.projectDir, 'clouds'), { recursive: true });
  await copyFile(FIXTURE, join(dataRoot.projectDir, 'clouds', 'synthetic.copc.laz'));
  await writeFile(
    join(dataRoot.projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
});

test('a COPC layer streams, colours by classification and hides a class', async ({ win }) => {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await win.evaluate(() => {
    const w = window as unknown as Inspect;
    w.__stratlas.stage()?.restoreView({ position: [20, 45, 30], target: [20, 3, -20] }, false);
    w.__stratlas.pointcloud.getState().setColourMode('classification');
  });
  const legend = win.locator('[data-component="classification-legend"]');
  await expect(legend).toBeVisible({ timeout: 30_000 });
  await expect(legend.getByRole('button', { name: 'Hide Ground' })).toBeVisible();
  await expect(legend.getByRole('button', { name: 'Hide Building' })).toBeVisible();
  await expect(legend.getByRole('button', { name: 'Hide High vegetation' })).toBeVisible();

  // the perf HUD counts the points drawn
  await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+Shift+F');
  const hud = win.locator('[data-perf-hud]');
  await expect(hud).toBeVisible();
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.stage()?.perfStats().points ?? 0,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(16000);
  await expect(hud).toContainText('points 16 k');
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'copc-synthetic-classes.png') });

  await legend.getByRole('button', { name: 'Hide Ground' }).click();
  await expect(legend.getByRole('button', { name: 'Show Ground' })).toBeVisible();
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'copc-synthetic-no-ground.png') });
});

test('Settings, Graphics quality overrides the detected GPU tier', async ({ win }) => {
  await win.getByRole('button', { name: 'Settings' }).first().click();
  await win.getByRole('button', { name: 'Graphics quality' }).click();
  const presets = win.getByRole('group', { name: 'Graphics quality preset' });
  await expect(presets.getByRole('button', { name: /^Auto \(/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await presets.getByRole('button', { name: 'Low', exact: true }).click();
  await expect(presets.getByRole('button', { name: 'Low', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(win.getByTestId('graphics-preset')).toContainText('2 M');
  const s = await win.evaluate(() => {
    const w = window as unknown as {
      __stratlas: { pointcloud: { getState(): { budget: number; edl: boolean } } };
    };
    return w.__stratlas.pointcloud.getState();
  });
  expect(s).toMatchObject({ budget: 2_000_000, edl: false });
});

test('elevation colours spread over the cloud heights, with a hand-set range', async ({ win }) => {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await win.evaluate(() => {
    const w = window as unknown as Inspect;
    w.__stratlas.stage()?.restoreView({ position: [20, 45, 30], target: [20, 3, -20] }, false);
    w.__stratlas.pointcloud.getState().setEdl(false);
    w.__stratlas.pointcloud.getState().setColourMode('height');
  });
  const legend = win.locator('[data-component="elevation-legend"]');
  await expect(legend).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.stage()?.perfStats().points ?? 0,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(16000);
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

  const ramp = await win.evaluate(readRamp);
  // one range for every node, and it is the points' (about 0 to 15 m), not the 40 m octree cube
  expect(ramp.ranges.length).toBeGreaterThan(1);
  expect(new Set(ramp.ranges.map((r) => r.join(','))).size).toBe(1);
  const [lo, hi] = ramp.ranges[0] ?? [0, 0];
  expect(hi - lo).toBeGreaterThan(2);
  expect(hi - lo).toBeLessThan(30);
  // the colours use the ramp: points from its bottom tenth to its top tenth
  const q = (f: number) => ramp.ts[Math.floor(f * (ramp.ts.length - 1))] ?? NaN;
  expect(q(0.02)).toBeLessThan(0.1);
  expect(q(0.98)).toBeGreaterThan(0.9);
  // the legend shows the same range in metres (origin height 0)
  await expect(legend).toHaveAttribute(
    'aria-label',
    `Elevation colour ramp from ${lo.toFixed(1)} m to ${hi.toFixed(1)} m`,
  );
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'copc-synthetic-elevation.png') });

  // the point cloud panel stretches the ramp by hand and Auto brings the automatic range back
  await win.getByRole('button', { name: 'Point cloud', exact: true }).click();
  const range = win.getByTestId('elevation-range');
  await expect(range.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  await range.getByLabel('Elevation ramp top').fill('5');
  await expect(range.getByRole('button', { name: 'Auto' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(legend).toHaveAttribute('aria-label', /to 5\.0 m$/);
  // every node takes the new range on the next frame
  await expect
    .poll(async () => (await win.evaluate(readRamp)).ranges.every((r) => Math.abs(r[1] - 5) < 1e-6))
    .toBe(true);
  await range.getByRole('button', { name: 'Auto' }).click();
  await expect
    .poll(() =>
      win.evaluate(
        () => (window as unknown as Inspect).__stratlas.pointcloud.getState().heightRange,
      ),
    )
    .toBeNull();
  await expect(legend).toHaveAttribute(
    'aria-label',
    `Elevation colour ramp from ${lo.toFixed(1)} m to ${hi.toFixed(1)} m`,
  );
});
