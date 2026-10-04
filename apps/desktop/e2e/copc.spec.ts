/**
 * COPC point clouds end to end on a synthetic project (no client data): the 16 000 point fixture
 * of @aio/pointcloud (ground, a building, trees; ASPRS classes 2, 6 and 5) streams through
 * aio:// range reads into the worker pool, colours by classification with a legend, hides a
 * class, and shows in the perf HUD. Runs everywhere.
 */
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, tinyManifest } from './fixtures';

const FIXTURE = join(
  import.meta.dirname,
  '../../../packages/pointcloud/test-data/synthetic.copc.laz',
);
const SHOTS = process.env.STRATLAS_SHOTS;

interface Inspect {
  __stratlas: {
    stage(): {
      perfStats(): { points: number; frames: number };
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
    } | null;
    pointcloud: { getState(): { setColourMode(m: string): void; setEdl(on: boolean): void } };
  };
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
