/**
 * The point cloud features of the model add-ons, with the real pipeline Python and PDAL: the noisy
 * synthetic COPC of the cleanup e2e (cleanupHelpers.ts, no client data) in the tiny project.
 *
 * - Ground classifier: Clean up, Remove noise with Also mark ground ticked runs `pointcloud.clean`
 *   with ground (main swaps in the add-on's SMRF settings); the result line shows the ground points
 *   and the noise run record carries `groundMarked`.
 * - Segmentation: a photo posed above the cloud with an outlined finding; right-click its tile in
 *   Inspect, Classify on point cloud, class 6, Classify. `segment.lift` lifts the outline and the
 *   region joins the cloud's cleanup recipe as one step, which Undo takes out again.
 *
 * The add-ons are installed into the data folder before the app starts, with main's own installer
 * (`installAddonArchive`) on the fake archives of `src/main/addons/addon.fakes.ts`; the Settings
 * side of installing is addons.spec.ts. A development interpreter reports its pack version as
 * `dev`, so the 0.35.0 gates pass.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddonKind } from '@aio/schema';
import { fakeAddonArchive } from '../src/main/addons/addon.fakes';
import { installAddonArchive } from '../src/main/addons/install';
import {
  drawn,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  writeNoisyProject,
} from './cleanupHelpers';
import { PDAL, PIPELINE_ENV, expect, hasPdal, hasPipelinePython, test } from './fixtures';
import { openInspect, photoTiles } from './inspect';
import { solidPng } from './panoFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'no pipeline Python (uv sync in python/, or QUADRION_E2E_PYTHON)');
test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

/** Install a fake add-on of this kind into the data folder, as Settings would. */
async function installAddon(dataRoot: string, base: string, id: string, kind: AddonKind) {
  const a = fakeAddonArchive({ id, kind });
  const file = join(base, a.fileName);
  await writeFile(file, a.bytes);
  const r = await installAddonArchive(file, { dataRoot });
  expect(r).toMatchObject({ ok: true });
}

// the project and the add-on are on disk before the app starts (and reads the add-on list)
test.describe('ground', () => {
  test.beforeEach(async ({ dataRoot }) => {
    await writeNoisyProject(dataRoot.projectDir);
    await installAddon(dataRoot.root, dataRoot.base, 'ground-classifier', 'point-classifier');
  });

  test('Remove noise with Also mark ground marks ground points', async ({ win }) => {
    test.setTimeout(240_000);
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await openNoisyProject(win);
    await openCleanupFromMenu(win);
    const ground = win.getByTestId('cleanup-noise-ground');
    await expect(ground).not.toBeChecked();
    await ground.check();
    await win.getByTestId('cleanup-noise-run').click();
    const result = win.getByTestId('cleanup-noise-ground-result');
    await expect(result).toContainText('ground points', { timeout: 180_000 });
    const marked = (await recipeOf(win))?.noise?.groundMarked ?? 0;
    expect(marked).toBeGreaterThan(0);
    await expect(result).toContainText(`${String(marked)} ground points`);
  });
});

// ---------------------------------------------------------------- Classify on point cloud

const W = 800;
const H = 600;
/** Project local metres (x east, y up, z south): 50 m above the cloud, looking down and north. */
const EYE: [number, number, number] = [20, 50, -12];
const TARGET: [number, number, number] = [20, 0, -20];

/** three.js camera quaternion [x, y, z, w] looking from `eye` at `target` with +Y up. */
function lookQ(eye: number[], target: number[]): [number, number, number, number] {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - (b[i] ?? 0));
  const norm = (a: number[]) => {
    const l = Math.hypot(...a);
    return a.map((v) => v / l);
  };
  const cross = (a: number[], b: number[]) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const z = norm(sub(eye, target));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  // rotation matrix with columns x, y, z
  const m = (r: number, c: number) => [x, y, z][c]?.[r] ?? 0;
  const tr = m(0, 0) + m(1, 1) + m(2, 2);
  const s = Math.sqrt(tr + 1) * 2; // tr > 0 for a camera looking mostly down and ahead
  return [(m(2, 1) - m(1, 2)) / s, (m(0, 2) - m(2, 0)) / s, (m(1, 0) - m(0, 1)) / s, s / 4];
}

/** The noisy project plus a posed photo over the cloud and a finding outlined on it. */
async function writeLiftProject(projectDir: string): Promise<void> {
  await writeNoisyProject(projectDir);
  const path = join(projectDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf-8')) as {
    layers: Record<string, unknown>[];
    captures: { id: string }[];
  };
  await mkdir(join(projectDir, 'photos'), { recursive: true });
  await writeFile(join(projectDir, 'photos', 'p1.png'), solidPng(W, H, [90, 90, 90]));
  manifest.layers.push({
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    capture: manifest.captures[0]?.id,
    items: [
      {
        id: 'p1',
        src: { path: 'photos/p1.png' },
        pos: EYE,
        q: lookQ(EYE, TARGET),
        lens: { model: 'pinhole', hfovDeg: 60, aspect: W / H },
      },
    ],
  });
  await writeFile(path, JSON.stringify(manifest, null, 2));
  await mkdir(join(projectDir, 'detections'), { recursive: true });
  await writeFile(
    join(projectDir, 'detections', 'review.json'),
    JSON.stringify({
      schema: 'aio.detections/1',
      source: 'human',
      producer: 'e2e',
      layer: 'photos',
      detections: [
        {
          id: 'outline-1',
          photo: 'p1',
          class: 'roof',
          label: 'Roof',
          status: 'draft',
          bbox: [200, 150, 600, 450],
          space: 'source',
          width: W,
          height: H,
          geom: {
            type: 'polygon',
            points: [
              [200, 150],
              [600, 150],
              [600, 450],
              [200, 450],
            ],
          },
        },
      ],
    }),
  );
}

test.describe('lift', () => {
  test.beforeEach(async ({ dataRoot }) => {
    await writeLiftProject(dataRoot.projectDir);
    await installAddon(dataRoot.root, dataRoot.base, 'segmentation', 'segmenter');
  });

  test('Classify on point cloud lifts a photo outline into one cleanup step', async ({ win }) => {
    test.setTimeout(240_000);
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    // the posed photo changes the opening view: wait for the cloud, not for every point
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    await expect.poll(() => drawn(win), { timeout: 30_000 }).toBeGreaterThan(0);

    await openInspect(win);
    const p1 = win.getByTestId('inspect-photos').locator('[data-photo="p1"]');
    await expect(photoTiles(win)).toHaveCount(1);
    await p1.scrollIntoViewIfNeeded();
    await p1.click({ button: 'right' });
    await win.getByTestId('photos-classify-on-cloud').click();

    const dialog = win.getByTestId('lift-dialog');
    await expect(dialog.getByTestId('lift-count')).toContainText('1 outline');
    await dialog.getByTestId('lift-class').selectOption('6');
    await dialog.getByTestId('lift-run').click();
    await expect(dialog.getByTestId('lift-result')).toContainText('1 region', { timeout: 180_000 });
    await dialog.getByTestId('lift-close').click();

    const recipe = await recipeOf(win);
    expect(recipe?.regions).toHaveLength(1);
    expect(recipe?.regions[0]).toMatchObject({
      shape: 'lasso',
      action: { kind: 'class', value: 6 },
    });
    expect(recipe?.regions[0]?.label).toContain('p1');
    expect(recipe?.regions[0]?.depth?.far).toBeGreaterThan(0);

    // one step: Undo in Clean up takes the region out again
    await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
    await openCleanupFromMenu(win);
    await win.getByTestId('cleanup-undo').click();
    await expect.poll(async () => (await recipeOf(win))?.regions.length ?? 0).toBe(0);
  });
});
