/**
 * Point cloud cleanup e2e: the noisy synthetic COPC (tools/pointcloud/synthetic-cloud.mjs with 40
 * outliers, no client data) in the tiny project, the Clean up panel opened from the layer's
 * right-click menu, and the window hooks of bootstrap.ts.
 */
import { ProjectManifest, type PointcloudCleanup, type ProjectManifestInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  STATE,
  compileCleanup,
  evaluateAll,
} from '../../../packages/pointcloud/src/cleanup/evaluate';
import { generate } from '../../../tools/pointcloud/synthetic-cloud.mjs';
import { expect, tinyManifest } from './fixtures';

export const NOISY_FIXTURE = join(
  import.meta.dirname,
  '../../../packages/pointcloud/test-data/noisy.copc.laz',
);
/** The fixture's construction (tools/pointcloud/README.md, "Test fixture"). */
export const CLOUD_POINTS = 16000;
export const HIGH_OUTLIERS = 40;
/** 40 high and 20 low isolated points, class 1. */
export const PLANTED = HIGH_OUTLIERS + Math.floor(HIGH_OUTLIERS / 2);
/** The fixture's rows (x, y, z, red, green, blue, intensity, class), from the same seeded generator. */
const ROWS = generate(CLOUD_POINTS, HIGH_OUTLIERS)
  .slice(1)
  .map((r) => r.split(',').map(Number));
export const NOISY_POINTS = ROWS.length;
export const LAYER = 'noisy';

export async function writeNoisyProject(projectDir: string): Promise<void> {
  const base = tinyManifest();
  const manifest: ProjectManifestInput = {
    ...base,
    layers: [
      {
        kind: 'pointcloud',
        id: LAYER,
        name: 'Noisy scan',
        src: { path: 'clouds/noisy.copc.laz' },
        format: 'copc',
        pointCount: NOISY_POINTS,
        capture: base.captures[0]?.id,
      },
    ],
  };
  await mkdir(join(projectDir, 'clouds'), { recursive: true });
  await copyFile(NOISY_FIXTURE, join(projectDir, 'clouds', 'noisy.copc.laz'));
  await writeFile(
    join(projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
}

interface Hooks {
  __stratlas: {
    stage(): {
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
    } | null;
    pointcloudCleanup: {
      store: { getState(): { layers: Record<string, { present: PointcloudCleanup | null }> } };
      drawn(layerId?: string): { drawn: number; loaded: number } | null;
      source(layerId: string): string | null;
      handle(h: string): { x: number; y: number } | null;
    };
  };
}

/** Sets the 3D view (local frame: the cloud spans x 0..40, z -40..0, heights -8..40). */
export async function setView(win: Page, position: number[], target: number[]): Promise<void> {
  await win.evaluate(
    ([p, t]) => {
      (window as unknown as Hooks).__stratlas
        .stage()
        ?.restoreView({ position: p, target: t }, false);
    },
    [position, target] as const,
  );
}

export async function openNoisyProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  // the whole cloud from above and to the south
  await setView(win, [20, 70, 35], [20, 0, -20]);
  // 16 060 points in a handful of nodes, far under the point budget: every node loads, so the
  // drawn counts the specs compare are whole-cloud counts, not level-of-detail samples
  await expect.poll(() => drawn(win), { timeout: 30_000 }).toBe(NOISY_POINTS);
}

export async function openCleanupFromMenu(win: Page): Promise<void> {
  const row = win.getByTestId(`tree-row-${LAYER}`);
  if (!(await row.isVisible())) {
    // folded away under its date folder or its group (as delete-and-start-over.spec.ts `row`)
    const folder = win.getByTestId('date-folder-capture-1');
    if ((await folder.count()) && (await folder.getAttribute('aria-expanded')) === 'false')
      await folder.getByRole('button').first().click();
    const group = win.getByTestId('tree-group-toggle-pointclouds');
    if ((await group.count()) && (await group.getAttribute('aria-expanded')) === 'false')
      await group.click();
  }
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await win.getByTestId('menu-pointcloud-cleanup').click();
  await expect(win.getByTestId('cleanup-panel')).toBeVisible();
}

export const drawn = (win: Page): Promise<number> =>
  win.evaluate(
    (id) => (window as unknown as Hooks).__stratlas.pointcloudCleanup.drawn(id)?.drawn ?? 0,
    LAYER,
  );

export const recipeOf = (win: Page): Promise<PointcloudCleanup | null> =>
  win.evaluate(
    (id) =>
      (window as unknown as Hooks).__stratlas.pointcloudCleanup.store.getState().layers[id]
        ?.present ?? null,
    LAYER,
  );

export const sourceOf = (win: Page): Promise<string | null> =>
  win.evaluate((id) => (window as unknown as Hooks).__stratlas.pointcloudCleanup.source(id), LAYER);

export const handleAt = (win: Page, h: string): Promise<{ x: number; y: number } | null> =>
  win.evaluate((face) => (window as unknown as Hooks).__stratlas.pointcloudCleanup.handle(face), h);

/** The middle of the 3D view reaches the canvas (no panel or bar covers it). */
export const middleReachesView = (win: Page): Promise<boolean> =>
  win.evaluate(() => {
    const c = document.querySelector('[data-scene-view] canvas');
    const r = c?.getBoundingClientRect();
    return r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === c : false;
  });

/** How many fixture points a save or an export keeps under `recipe` (the evaluator over every point). */
export function expectedKept(recipe: PointcloudCleanup): number {
  return statesOf(recipe).filter((s) => s <= STATE.hidden).length;
}

/**
 * How many fixture points the view draws under `recipe` once every node is loaded (kept only:
 * hidden selections, hidden classes, deletes and the box and heights are not drawn).
 */
export function expectedDrawn(recipe: PointcloudCleanup): number {
  return statesOf(recipe).filter((s) => s === STATE.kept).length;
}

function statesOf(recipe: PointcloudCleanup): Uint8Array {
  const xyz = ROWS.flatMap((r) => [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0]);
  const cls = ROWS.map((r) => r[7] ?? 0);
  return evaluateAll(compileCleanup(recipe), xyz, cls).state;
}
