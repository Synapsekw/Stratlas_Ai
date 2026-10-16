/**
 * Drop to ground (16 Oct 2026): a point cloud that floats 31 m over the site drops onto the
 * project ground level from its row menu, the manifest takes the new height offset and the drawn
 * points land on y = 0, and Ctrl+Z lifts it back. A model and a cloud marked together drop in one
 * step. The height offset typed in Properties moves the drawn points live, with Undo. Synthetic
 * data only (the @aio/pointcloud COPC fixture and the tiny quad); off-screen; zero network.
 */
import { glbBounds } from '@aio/project/builder';
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test, tinyGlb, tinyManifest, type DataRoot } from './fixtures';

const FIXTURE = join(
  import.meta.dirname,
  '../../../packages/pointcloud/test-data/synthetic.copc.laz',
);
const CLOUD = 'Synthetic COPC cloud';

interface Probe {
  __stratlas: { stage(): { perfStats(): { points: number } } | null };
}

interface Layer {
  id: string;
  heightOffsetM?: number;
  transform?: number[];
}

/** Write the tiny project with the synthetic cloud (and the quad when `quadLift` is given). */
async function seed(
  dataRoot: DataRoot,
  opts: { heightOffsetM?: number; quadLift?: number },
): Promise<void> {
  const base = tinyManifest();
  const cloud: ProjectManifestInput['layers'][number] = {
    kind: 'pointcloud',
    id: 'synthetic',
    name: CLOUD,
    src: { path: 'clouds/synthetic.copc.laz' },
    format: 'copc',
    pointCount: 16000,
    ...(opts.heightOffsetM === undefined ? {} : { heightOffsetM: opts.heightOffsetM }),
  };
  const layers: ProjectManifestInput['layers'] = [cloud];
  if (opts.quadLift !== undefined) {
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, opts.quadLift, 0, 1];
    for (const l of base.layers) if (l.kind === 'mesh') layers.push({ ...l, transform });
  }
  await mkdir(join(dataRoot.projectDir, 'clouds'), { recursive: true });
  await copyFile(FIXTURE, join(dataRoot.projectDir, 'clouds', 'synthetic.copc.laz'));
  await writeFile(
    join(dataRoot.projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse({ ...base, layers }), null, 2),
  );
}

async function layerOf(dataRoot: DataRoot, id: string): Promise<Layer | undefined> {
  const m = JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as {
    layers: Layer[];
  };
  return m.layers.find((l) => l.id === id);
}

/** Open the tiny project and wait until the cloud's points are drawn. */
async function openCloud(win: Page, id: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as Probe).__stratlas.stage()?.perfStats().points ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  // the rows sit in kind groups under "Every date", which start folded
  const toggles = win.locator('[data-testid^="tree-group-toggle-"][aria-expanded="false"]');
  while ((await toggles.count()) > 0) await toggles.first().click();
  await expect(win.getByTestId('tree-row-synthetic').first()).toBeVisible();
}

/** The 2nd percentile local y of every drawn point (as copc.spec.ts's readRamp walks them). */
function lowY(): number | null {
  interface Obj {
    children: Obj[];
    isPoints?: boolean;
    visible: boolean;
    matrixWorld: { elements: number[] };
    geometry?: { attributes: { position?: { array: ArrayLike<number>; count: number } } };
  }
  const st = (
    window as unknown as { __stratlas: { stage(): { scene: Obj } | null } }
  ).__stratlas.stage();
  const ys: number[] = [];
  const walk = (o: Obj) => {
    const p = o.geometry?.attributes.position;
    if (o.isPoints && o.visible && p) {
      const e = o.matrixWorld.elements;
      for (let i = 0; i < p.count; i += 3) {
        ys.push(
          (e[1] ?? 0) * (p.array[3 * i] ?? 0) +
            (e[5] ?? 0) * (p.array[3 * i + 1] ?? 0) +
            (e[9] ?? 0) * (p.array[3 * i + 2] ?? 0) +
            (e[13] ?? 0),
        );
      }
    }
    for (const c of o.children) walk(c);
  };
  if (st) walk(st.scene);
  if (ys.length === 0) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(0.02 * (ys.length - 1))] ?? null;
}

const low = (win: Page) => win.evaluate(lowY);

/** The quad's lowest vertex, from the GLB's own accessors. */
function quadMinY(): number {
  const glb = tinyGlb();
  const len = glb.readUInt32LE(12);
  const b = glbBounds(JSON.parse(glb.subarray(20, 20 + len).toString('utf8')) as unknown);
  if (!b) throw new Error('no quad bounds');
  return b.min[1];
}

test('a floating cloud drops onto the project ground and Undo lifts it back', async ({
  dataRoot,
  win,
}) => {
  await seed(dataRoot, { heightOffsetM: 31 });
  await openCloud(win, dataRoot.projectId);
  // floating: its low points are about 31 m up
  await expect.poll(() => low(win), { timeout: 30_000 }).toBeGreaterThan(25);

  await win.getByTestId('tree-row-synthetic').first().click({ button: 'right' });
  await win.getByTestId('menu-drop-to-ground').click();
  const text = win.getByTestId('drop-text');
  await expect(text).toHaveText(
    /^Lowered Synthetic COPC cloud \d+\.\d m \(to the project ground level\)\.$/,
  );
  const shown = Number(/(\d+\.\d) m/.exec((await text.textContent()) ?? '')?.[1]);
  await expect
    .poll(async () => Math.abs(((await layerOf(dataRoot, 'synthetic'))?.heightOffsetM ?? 0) - 31))
    .toBeGreaterThan(1);
  const dropped = (await layerOf(dataRoot, 'synthetic'))?.heightOffsetM ?? NaN;
  expect(Math.abs(dropped - (31 - shown))).toBeLessThanOrEqual(0.051);
  // the drawn points follow: their low points sit on the project ground
  await expect
    .poll(async () => Math.abs((await low(win)) ?? Infinity), { timeout: 30_000 })
    .toBeLessThan(0.3);

  // Ctrl+Z while the notice shows lifts it back
  await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+z');
  await expect.poll(async () => (await layerOf(dataRoot, 'synthetic'))?.heightOffsetM).toBe(31);
  await expect(win.getByTestId('drop-redo')).toBeVisible();
  await expect.poll(() => low(win), { timeout: 30_000 }).toBeGreaterThan(25);
});

test('a model and a cloud marked together drop in one step', async ({ dataRoot, win }) => {
  await seed(dataRoot, { heightOffsetM: 31, quadLift: 12 });
  await openCloud(win, dataRoot.projectId);

  const cloudRow = win.getByTestId('tree-row-synthetic').first();
  const quadRow = win.getByTestId('tree-row-quad').first();
  await cloudRow.click({ modifiers: ['Control'] });
  await quadRow.click({ modifiers: ['Control'] });
  await quadRow.click({ button: 'right' });
  await win.getByTestId('menu-drop-to-ground').click();
  await expect(win.getByTestId('drop-text')).toContainText('Moved 2 datasets onto the ground');

  await expect
    .poll(async () => (await layerOf(dataRoot, 'quad'))?.transform?.[13] ?? NaN)
    .toBeCloseTo(-quadMinY(), 2);
  expect((await layerOf(dataRoot, 'synthetic'))?.heightOffsetM ?? 31).toBeLessThan(31);
});

test('a height offset typed in Properties moves the drawn points, with Undo', async ({
  dataRoot,
  win,
}) => {
  await seed(dataRoot, {});
  await openCloud(win, dataRoot.projectId);
  await expect.poll(() => low(win), { timeout: 30_000 }).not.toBeNull();
  const before = (await low(win)) ?? NaN;

  await win.getByTestId('tree-row-synthetic').first().click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.properties').click();
  await expect(win.getByTestId('layer-props')).toBeVisible();
  const field = win.getByTestId('layer-props-height-offset');
  await expect(field).toHaveValue('0');
  await field.fill('7.5');
  await win.getByTestId('layer-props-height-save').click();

  await expect.poll(async () => (await layerOf(dataRoot, 'synthetic'))?.heightOffsetM).toBe(7.5);
  await expect(win.getByTestId('drop-text')).toContainText(CLOUD);
  // the drawn points move live by the offset
  await expect
    .poll(async () => Math.abs(((await low(win)) ?? Infinity) - (before + 7.5)), {
      timeout: 30_000,
    })
    .toBeLessThan(0.3);

  await win.getByTestId('layer-props-close').click();
  await expect(win.getByTestId('layer-props')).toBeHidden();
  await win.getByTestId('drop-undo').click();
  await expect
    .poll(async () => (await layerOf(dataRoot, 'synthetic'))?.heightOffsetM)
    .toBeUndefined();
  await expect
    .poll(async () => Math.abs(((await low(win)) ?? Infinity) - before), { timeout: 30_000 })
    .toBeLessThan(0.3);
});
