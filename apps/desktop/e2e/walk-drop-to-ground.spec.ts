/**
 * Drop to ground for a 360 walk: the walk's pins stand at the model origin's height (ground 0)
 * while the ortho, the only floor drawn under its path, lies 6 m lower. Drop to ground on the walk's
 * right-click menu asks the floor under the path and sets the walk's height offset to about -6 m;
 * its pose file follows (the camera 1.7 m over the ortho) and Ctrl+Z puts it back. Skipped when
 * ffmpeg with libx264 is missing (CI installs it).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  createWalkCompareProject,
  ffmpegReady,
  openWalkProject,
  ORTHO_Y,
  walkRow,
  WALK_ID,
  WALK_LAYER,
  WALK_NAME,
} from './walkFixture';

interface Probe {
  __stratlas: {
    stage(): { scene: { getObjectByName(n: string): { children: unknown[] } | undefined } } | null;
  };
}

const offsetOf = async (dir: string): Promise<number | undefined> => {
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    layers: { id: string; heightOffsetM?: number }[];
  };
  return m.layers.find((l) => l.id === WALK_LAYER)?.heightOffsetM;
};

/** The camera heights of the walk's pose file while it walks (4 s to 62 s): lowest and highest. */
const poseHeights = async (dir: string): Promise<{ min: number; max: number } | null> => {
  try {
    const pose = JSON.parse(await readFile(join(dir, 'walks', WALK_ID, 'pose.json'), 'utf8')) as {
      samples: { t: number; pos: [number, number, number] }[];
    };
    const ys = pose.samples.filter((s) => s.t >= 4_000 && s.t <= 62_000).map((s) => s.pos[1]);
    return ys.length ? { min: Math.min(...ys), max: Math.max(...ys) } : null;
  } catch {
    return null;
  }
};

test.describe('Drop to ground for a walk', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a walk placed above the ortho drops onto it, its pose follows, and Ctrl+Z lifts it back', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const dir = await createWalkCompareProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);
    // the placed walks are drawn in 3D (their fits made, the ground there to ask)
    await expect
      .poll(
        () =>
          win.evaluate(
            () =>
              ((window as unknown as Probe).__stratlas
                .stage()
                ?.scene.getObjectByName('aio-walks-placed')?.children.length ?? 0) > 0,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(await offsetOf(dir)).toBeUndefined();

    const row = await walkRow(win);
    await row.click({ button: 'right' });
    await win.getByTestId('menu-drop-to-ground').click();
    const text = win.getByTestId('drop-text');
    await expect(text).toHaveText(
      new RegExp(`^Lowered ${WALK_NAME} 6\\.0 m \\(onto the floor in 3D\\)\\.$`),
      { timeout: 30_000 },
    );
    await expect.poll(() => offsetOf(dir)).toBeDefined();
    expect((await offsetOf(dir)) ?? NaN).toBeCloseTo(ORTHO_Y, 1);
    // the pose file follows: the camera 1.7 m over the ortho all along the walk
    await expect
      .poll(async () => (await poseHeights(dir))?.max ?? NaN, { timeout: 30_000 })
      .toBeCloseTo(ORTHO_Y + 1.7, 1);
    expect((await poseHeights(dir))?.min ?? NaN).toBeCloseTo(ORTHO_Y + 1.7, 1);

    // Ctrl+Z while the notice shows: the walk goes back to its pins' height
    await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 5 } });
    await win.keyboard.press('Control+z');
    await expect.poll(() => offsetOf(dir), { timeout: 30_000 }).toBeUndefined();
    await expect(win.getByTestId('drop-redo')).toBeVisible();
    await expect
      .poll(async () => (await poseHeights(dir))?.max ?? NaN, { timeout: 30_000 })
      .toBeCloseTo(1.7, 1);
  });
});
