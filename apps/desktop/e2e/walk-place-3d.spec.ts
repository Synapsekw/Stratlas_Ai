/**
 * Placing a walk in the 3D view: a project on a local grid with no drawing (the 3D view is the only
 * surface), the walk's shape follows the pointer, a start click and an end click on the ground
 * place it, its End handle is dragged, Save writes a pose that keeps the walk's L, placed on the
 * model. The toolbar leaves the middle of the view free. Skipped when ffmpeg with libx264 is
 * missing (CI installs it).
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  createWalkProject,
  ffmpegReady,
  openWalkProject,
  poseBendM,
  rowAction,
  WALK_END,
  WALK_LAYER,
  WALK_START,
} from './walkFixture';

interface Probe {
  __stratlas: {
    stage(): {
      camera: {
        updateMatrixWorld(): void;
        position: {
          x: number;
          y: number;
          z: number;
          clone(): {
            set(
              x: number,
              y: number,
              z: number,
            ): { project(c: unknown): { x: number; y: number; z: number } };
          };
        };
      };
      renderer: { domElement: HTMLCanvasElement };
      restoreView(
        v: { position: [number, number, number]; target: [number, number, number] },
        animate?: boolean,
      ): void;
      scene: { getObjectByName(n: string): { visible: boolean } | undefined };
    } | null;
  };
}

/**
 * Look straight down on the middle of the L from 120 m, so the whole walk is on screen (the model
 * is a 1 m quad: the view has to reach well past it), and check the camera stays there.
 */
async function lookDown(win: Page): Promise<void> {
  await win.evaluate(() => {
    (window as unknown as Probe).__stratlas
      .stage()
      ?.restoreView({ position: [20, 120, -14.9], target: [20, 0, -15] }, false);
  });
  await win.waitForTimeout(500);
  const y = await win.evaluate(
    () => (window as unknown as Probe).__stratlas.stage()?.camera.position.y ?? 0,
  );
  expect(y).toBeCloseTo(120, 0);
}

/** The page point of a model point (x, height, z) in the 3D view. */
async function scenePoint(
  win: Page,
  p: [number, number, number],
): Promise<{ x: number; y: number }> {
  return win.evaluate((p) => {
    const st = (window as unknown as Probe).__stratlas.stage();
    if (!st) throw new Error('no stage');
    st.camera.updateMatrixWorld();
    const v = st.camera.position.clone().set(p[0], p[1], p[2]).project(st.camera);
    const r = st.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);
}

/** The preview line of the walk being placed is in the scene and shown. */
async function previewShown(win: Page): Promise<boolean> {
  return win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.stage()?.scene.getObjectByName('aio-walk-preview')
        ?.visible === true,
  );
}

test.describe('placing a walk in the 3D view', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a walk is placed in the 3D view by its start and end, and keeps its shape', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const dir = await createWalkProject(dataRoot.root, { drawing: false });
    await win.reload();
    await openWalkProject(win);
    await rowAction(win, 'place');
    const strip = win.getByTestId('walk-place-strip');
    await expect(strip).toHaveAttribute('data-step', 'start', { timeout: 30_000 });
    await expect(strip.getByTestId('walk-place-on')).toHaveValue('3d');
    // nothing to save before the start
    await expect(strip.getByTestId('walk-place-save')).toBeDisabled();
    await expect(
      win
        .getByRole('toolbar', { name: 'Stage tools' })
        .getByRole('button', { name: '3D', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const canvas = win.locator('[data-scene-view] canvas').first();
    await expect(canvas).toBeVisible();
    await lookDown(win);

    // the walk's shape follows the pointer over the ground
    const s = await scenePoint(win, [WALK_START[0], 0, WALK_START[1]]);
    await win.mouse.move(s.x + 3, s.y + 3);
    await win.mouse.move(s.x, s.y, { steps: 2 });
    await expect.poll(() => previewShown(win)).toBe(true);

    // start and end, as the synthetic walk went
    await win.mouse.click(s.x, s.y);
    await expect(strip).toHaveAttribute('data-step', 'end');
    const e = await scenePoint(win, [WALK_END[0], 0, WALK_END[1]]);
    await win.mouse.click(e.x, e.y);
    await expect(strip).toHaveAttribute('data-step', 'placed');

    // drag End 5 m south (the handle sits just above the ground)
    const from = await scenePoint(win, [WALK_END[0], 0.1, WALK_END[1]]);
    const to = await scenePoint(win, [WALK_END[0], 0, WALK_END[1] + 5]);
    await win.mouse.move(from.x, from.y);
    await win.mouse.down();
    await win.mouse.move(to.x, to.y, { steps: 6 });
    await win.mouse.up();
    await expect(strip).toHaveAttribute('data-step', 'placed');

    // the toolbar does not cover the middle of the view
    expect(
      await win.evaluate(() => {
        const c = document.querySelector('[data-scene-view] canvas');
        if (!c) return false;
        const r = c.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === c;
      }),
    ).toBe(true);

    await strip.getByTestId('walk-place-save').click();
    await expect(win.getByTestId('walk-place-strip')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => poseBendM(dir), { timeout: 30_000 }).toBeGreaterThan(15);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      layers: { id: string; place?: { pins: { at: [number, number] }[]; placedOn?: string } }[];
    };
    const layer = manifest.layers.find((l) => l.id === WALK_LAYER);
    expect(layer?.place?.placedOn).toBe('@model');
    expect(layer?.place?.pins).toHaveLength(2);
    // the End pin moved south with the drag (z grows southward)
    expect(layer?.place?.pins[1]?.at[1]).toBeGreaterThan(-28);
  });
});
