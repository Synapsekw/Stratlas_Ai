/**
 * Point cloud and 3D model change (M8 stream C3) end to end, on synthetic data only.
 *
 * - The change cloud of a small fixed yard (`packages/pointcloud/test-data/change.copc.laz`, made
 *   by `change.cloud`) runs everywhere: colour mode Change from the point cloud panel, the moved
 *   pipe warm and the tank neutral in the drawn pixels, the threshold hiding unchanged points, the
 *   distance under the pointer.
 * - The runs use the change demo (C8) and the places and verdicts of its `truth.json`: Run cloud
 *   change and Run model change from the Changes panel. They need the development pipeline Python
 *   (`uv sync` in python/, or STRATLAS_E2E_PYTHON); the cloud run also PDAL (AIO_PDAL or the
 *   development install). Skipped without them.
 */
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  hasPdal,
  hasPipelinePython,
  PDAL,
  PIPELINE_ENV,
  test,
  tinyManifest,
  VENV_PYTHON,
} from './fixtures';

const repo = join(import.meta.dirname, '..', '..', '..');
const CHANGE_COPC = join(repo, 'packages', 'pointcloud', 'test-data', 'change.copc.laz');

const CAPTURES = [
  { id: 'c1', label: 'January survey', date: '2026-01-10' },
  { id: 'c2', label: 'February survey', date: '2026-02-10' },
];

/** Where to look (local frame, x east, y up, z south): the moved pipe and the tank. */
const PIPE: [number, number, number] = [19, 1.9, -8.6];
const TANK: [number, number, number] = [8, 6, -20];
const VIEW = { position: [15, 28, 14], target: [15, 1, -13] };

async function writeManifest(dir: string, layers: ProjectManifestInput['layers']) {
  const manifest: ProjectManifestInput = { ...tinyManifest(), captures: CAPTURES, layers };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
}

interface Inspect {
  __stratlas: {
    stage(): {
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
      renderNow(): void;
      renderer: { getContext(): WebGL2RenderingContext; domElement: HTMLCanvasElement };
      camera: { updateMatrixWorld(): void };
      controls: { target: { clone(): { set(x: number, y: number, z: number): Projectable } } };
    } | null;
    pointcloud: {
      getState(): { setEdl(on: boolean): void; changeThreshold: number; colourMode: string };
    };
    workspace: {
      getState(): {
        project: { manifest: { layers: { id: string; visible: boolean }[] } } | null;
        selection: { kind: string; id: string } | null;
      };
    };
  };
}
interface Projectable {
  project(camera: unknown): { x: number; y: number };
}

/** Pixels around a local point: warm (red, amber) ones and ones of the change ramp's grey. */
async function sample(win: Page, at: [number, number, number]) {
  return win.evaluate(
    ([p, radius]) => {
      const s = (window as unknown as Inspect).__stratlas.stage();
      if (!s) throw new Error('no stage');
      s.renderNow();
      const gl = s.renderer.getContext();
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      s.camera.updateMatrixWorld();
      const ndc = s.controls.target.clone().set(p[0], p[1], p[2]).project(s.camera);
      const cx = Math.round(((ndc.x + 1) / 2) * W);
      const cy = Math.round(((ndc.y + 1) / 2) * H);
      const n = 2 * radius + 1;
      const px = new Uint8Array(n * n * 4);
      gl.readPixels(cx - radius, cy - radius, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let warm = 0;
      let grey = 0;
      for (let i = 0; i < n * n; i++) {
        const r = px[4 * i] ?? 0;
        const g = px[4 * i + 1] ?? 0;
        const b = px[4 * i + 2] ?? 0;
        if (r - b > 60 && r >= g) warm++;
        // the ramp's grey: neutral, and well lighter than the dark stage behind the points
        if (Math.max(r, g, b) - Math.min(r, g, b) < 30 && Math.max(r, g, b) >= 60) grey++;
      }
      const rect = s.renderer.domElement.getBoundingClientRect();
      const client = {
        x: rect.left + ((ndc.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      };
      // the pointer reaches the canvas there, not a legend or panel drawn over the view
      const free = document.elementFromPoint(client.x, client.y) === s.renderer.domElement;
      return { warm, grey, of: n * n, client, free };
    },
    [at, 6] as const,
  );
}

async function openYard(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await win.evaluate((view) => {
    const w = window as unknown as Inspect;
    w.__stratlas.pointcloud.getState().setEdl(false);
    w.__stratlas.stage()?.restoreView(view, false);
  }, VIEW);
}

/** Point cloud panel, Colour by: Change. */
async function colourByChange(win: Page) {
  await win.getByRole('button', { name: 'Point cloud', exact: true }).click();
  const panel = win.getByTestId('cloud-panel');
  await expect(panel.getByRole('button', { name: 'Change', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await panel.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Change', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await win.keyboard.press('Escape');
}

test.describe('a change cloud', () => {
  test.beforeEach(async ({ dataRoot }) => {
    await mkdir(join(dataRoot.projectDir, 'change', 'c1-c2-cloud'), { recursive: true });
    await copyFile(
      CHANGE_COPC,
      join(dataRoot.projectDir, 'change', 'c1-c2-cloud', 'distance.copc.laz'),
    );
    await writeManifest(dataRoot.projectDir, [
      {
        kind: 'pointcloud',
        id: 'c1-c2-cloud',
        name: 'Cloud change 2026-01-10 to 2026-02-10',
        capture: 'c2',
        derived: { kind: 'change', from: 'c1', to: 'c2', changeId: 'c1-c2-cloud' },
        src: { path: 'change/c1-c2-cloud/distance.copc.laz' },
        format: 'copc',
        scalar: {
          dim: 'Distance',
          label: 'Distance',
          unit: 'm',
          range: [0, 0.3],
          diverging: false,
        },
      },
    ]);
  });

  test('colours by change: the moved pipe warm, the tank grey; the threshold hides unchanged points; the pointer reads the distance', async ({
    win,
    network,
  }) => {
    await openYard(win);
    await colourByChange(win);
    const legend = win.locator('[data-component="change-legend"]');
    await expect(legend).toBeVisible({ timeout: 30_000 });
    await expect(legend).toContainText('Change: distance to the earlier date');
    await expect(legend).toContainText('0.30 m');

    // every node streamed in, then the drawn pixels
    await expect
      .poll(async () => (await sample(win, PIPE)).warm, { timeout: 30_000 })
      .toBeGreaterThan(3);
    const tank = await sample(win, TANK);
    expect(tank.grey).toBeGreaterThan(3);
    expect(tank.warm).toBe(0);

    // hide changes under 10 cm: the tank goes, the pipe stays
    await legend.getByLabel('Hide changes smaller than').fill('0.1');
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.pointcloud.getState().changeThreshold,
        ),
      )
      .toBe(0.1);
    await expect(legend).toContainText('0.10 m');
    expect((await sample(win, TANK)).grey).toBe(0);
    expect((await sample(win, PIPE)).warm).toBeGreaterThan(3);

    // the distance under the pointer. At the smallest window (1100 x 700, the size the CI
    // runners' small screens give) the change legend in the bottom right of the 3D view covers
    // the pipe as VIEW frames it, so look straight at the pipe first: the middle of the view.
    await win.evaluate(
      ({ position, target }) => {
        (window as unknown as Inspect).__stratlas.stage()?.restoreView({ position, target }, false);
      },
      { position: [PIPE[0], PIPE[1] + 27, PIPE[2] + 27], target: [...PIPE] },
    );
    await expect.poll(async () => (await sample(win, PIPE)).warm).toBeGreaterThan(3);
    const pipe = await sample(win, PIPE);
    expect(pipe.free, 'the pipe is not under a legend or panel').toBe(true);
    await win.mouse.move(pipe.client.x, pipe.client.y);
    const hover = legend.getByTestId('change-hover');
    await expect(hover).toContainText('Under the pointer', { timeout: 10_000 });
    const metres = Number(/([\d.]+) m/.exec((await hover.textContent()) ?? '')?.[1]);
    // the pointer reads a drawn point only: none under the 10 cm threshold
    expect(metres).toBeGreaterThanOrEqual(0.1);
    // nothing to read on the volumes yet (C2's change.surface has not run)
    await expect(win.getByTestId('cloud-volume-change')).toContainText(
      'No volume change for these dates yet.',
    );
    expect(await network.outbound()).toEqual([]);
  });
});

test.describe('change runs on the change demo', () => {
  test.use({ appEnv: PIPELINE_ENV });
  test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);

  interface Region {
    id: string;
    verdict: string;
    bounds: { min: number[]; max: number[] };
  }
  interface SetItem {
    verdict: string;
    at?: number[];
    part?: string;
  }

  const layerShown = (win: Page, id: string) =>
    expect
      .poll(
        () =>
          win.evaluate(
            (id) =>
              (window as unknown as Inspect).__stratlas.workspace
                .getState()
                .project?.manifest.layers.some((l) => l.id === id) ?? false,
            id,
          ),
        { timeout: 180_000 },
      )
      .toBe(true);

  /** Changes tab, then the producer's Run button. */
  async function runProducer(win: Page, id: string) {
    await win.getByTestId('tab-changes').click();
    const panel = win.getByTestId('change-panel');
    await expect(panel).toBeVisible();
    const run = panel.getByTestId(`change-producer-${id}`);
    await expect(run).toBeEnabled();
    await run.click();
    return panel;
  }

  /** An item of the set with `verdict` whose place lies in the region's bounds (1 m margin). */
  const found = (items: SetItem[], r: Region) =>
    items.some(
      (i) =>
        i.verdict === r.verdict &&
        i.at !== undefined &&
        [0, 2].every(
          (k) =>
            (i.at?.[k] ?? NaN) >= (r.bounds.min[k] ?? 0) - 1 &&
            (i.at?.[k] ?? NaN) <= (r.bounds.max[k] ?? 0) + 1,
        ),
    );

  test('Run cloud change on the demo clouds: the added shelter and the removed container, coloured by change', async ({
    demoProject,
  }) => {
    test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);
    test.setTimeout(300_000);
    const { win, root, truth } = demoProject;
    const { from, to } = truth.captures;
    await runProducer(win, 'cloud');
    // the open project reloads its manifest: the change cloud is a layer
    await layerShown(win, `${from}-${to}-cloud`);
    const set = JSON.parse(
      await readFile(join(root, 'change', `${from}-${to}-cloud.json`), 'utf8'),
    ) as { items: SetItem[]; registration: { ok: boolean; shiftM: number } };
    expect(set.registration.ok).toBe(true);
    expect(set.registration.shiftM).toBeLessThan(0.05);
    const regions = (truth.changes.cloud as unknown as { regions: Region[] }).regions;
    // the shelter appeared and the container went: both found where truth.json puts them
    for (const id of ['S-01', 'C-01']) {
      const r = regions.find((x) => x.id === id);
      if (!r) throw new Error(`truth.json has no cloud region ${id}`);
      expect(found(set.items, r), id).toBe(true);
    }
    // the moved skid changed in its old place (its old and new places may join in one region)
    const skid = regions.find((x) => x.id === 'SK-01 old place');
    if (!skid) throw new Error('truth.json has no SK-01 region');
    expect(found(set.items, skid)).toBe(true);
    // the clouds are coloured by change at once, with the change legend
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.pointcloud.getState().colourMode,
        ),
      )
      .toBe('change');
    await expect(win.locator('[data-component="change-legend"]')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('Run model change on the demo models: the parts truth.json lists, and a click selects the part', async ({
    demoProject,
  }) => {
    test.setTimeout(300_000);
    const { win, root, truth } = demoProject;
    const { from, to } = truth.captures;
    const component = truth.changes.component as unknown as {
      items: { part: string; verdict: string; offsetM?: number[] }[];
      verdicts: Record<string, number>;
    };
    const panel = await runProducer(win, 'mesh');
    await layerShown(win, `${from}-${to}-mesh`);
    const rows = panel.locator('[data-testid="change-row"][data-kind="component"]');
    await expect(rows).toHaveCount(
      Object.values(component.verdicts).reduce((a, b) => a + b, 0),
      { timeout: 60_000 },
    );
    const set = JSON.parse(
      await readFile(join(root, 'change', `${from}-${to}-mesh.json`), 'utf8'),
    ) as { items: (SetItem & { offsetM?: number[]; nodeTo?: string })[] };
    expect(Object.fromEntries(set.items.map((i) => [i.part, i.verdict]))).toEqual(
      Object.fromEntries(component.items.map((i) => [i.part, i.verdict])),
    );
    const moved = component.items.find((i) => i.verdict === 'moved');
    const got = set.items.find((i) => i.part === moved?.part);
    for (const k of [0, 2]) expect(got?.offsetM?.[k]).toBeCloseTo(moved?.offsetM?.[k] ?? NaN, 1);

    // a click on the moved part selects it on the later date (both dates outline it)
    await panel
      .locator(`[data-testid="change-row"][data-id="component:${moved?.part ?? ''}"]`)
      .click();
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.workspace.getState().selection,
        ),
      )
      .toMatchObject({ kind: 'asset', id: got?.nodeTo });

    // the deviation model is a hidden layer of the later date until the person shows it
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      layers: { id: string; visible: boolean; capture?: string }[];
    };
    expect(manifest.layers.find((l) => l.id === `${from}-${to}-mesh`)).toMatchObject({
      visible: false,
      capture: to,
    });
  });
});
