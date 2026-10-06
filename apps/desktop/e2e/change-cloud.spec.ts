/**
 * Point cloud and 3D model change (M8 stream C3) end to end, on synthetic data only: a fictional
 * yard where, between 10 Jan and 10 Feb 2026, a pipe moves 0.6 m north, a box is added, a skid is
 * removed and the tank gets a 0.25 m dent (`python/scripts/change_fixture.py`).
 *
 * - The change cloud (`packages/pointcloud/test-data/change.copc.laz`, made by `change.cloud`) runs
 *   everywhere: colour mode Change from the point cloud panel, the moved pipe warm and the tank
 *   neutral in the drawn pixels, the threshold hiding unchanged points, the distance under the
 *   pointer.
 * - Running `change.cloud` and `change.mesh` in the pipeline pack needs the development venv
 *   (`uv sync` in python/) or STRATLAS_E2E_PYTHON; the cloud run also PDAL (AIO_PDAL or the
 *   development install). Skipped without them.
 *
 * Once stream C8's two-date demo lands, the runs switch to its tank farm (truth.json counts).
 */
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launchApp, test, tinyManifest } from './fixtures';

const repo = join(import.meta.dirname, '..', '..', '..');
const CHANGE_COPC = join(repo, 'packages', 'pointcloud', 'test-data', 'change.copc.laz');
const FIXTURE_SCRIPT = join(repo, 'python', 'scripts', 'change_fixture.py');
const venvPython =
  process.env.STRATLAS_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));
const hasPython = existsSync(venvPython);
const pdal =
  process.env.AIO_PDAL ??
  (process.platform === 'win32' ? 'E:/Dev/tools/pdal/Library/bin/pdal.exe' : '/usr/bin/pdal');
const hasPdal = existsSync(pdal);

const CAPTURES = [
  { id: 'c1', label: 'January survey', date: '2026-01-10' },
  { id: 'c2', label: 'February survey', date: '2026-02-10' },
];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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
    pointcloud: { getState(): { setEdl(on: boolean): void; changeThreshold: number } };
    workspace: {
      getState(): { project: { manifest: { layers: { id: string; visible: boolean }[] } } | null };
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
      return {
        warm,
        grey,
        of: n * n,
        client: {
          x: rect.left + ((ndc.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        },
      };
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

    // the distance under the pointer
    const pipe = await sample(win, PIPE);
    await win.mouse.move(pipe.client.x, pipe.client.y);
    const hover = legend.getByTestId('change-hover');
    await expect(hover).toContainText('Under the pointer', { timeout: 10_000 });
    const metres = Number(/([\d.]+) m/.exec((await hover.textContent()) ?? '')?.[1]);
    expect(metres).toBeGreaterThan(0.1);
    // nothing to read on the volumes yet (C2's change.surface has not run)
    await expect(win.getByTestId('cloud-volume-change')).toContainText(
      'No volume change for these dates yet.',
    );
    expect(await network.outbound()).toEqual([]);
  });
});

test.describe('change runs in the pipeline pack', () => {
  test.skip(!hasPython, `no pipeline Python at ${venvPython} (uv sync in python/)`);

  /** The synthetic yard of both dates, written by the fixture script. */
  function makeYard(dir: string, copc: boolean) {
    execFileSync(venvPython, [FIXTURE_SCRIPT, dir, ...(copc ? ['--copc'] : [])], {
      env: { ...process.env, AIO_PDAL: pdal },
      stdio: 'pipe',
    });
  }

  async function runJob(win: Page, pipeline: string, project: string, params: object) {
    // the same request the cloud and model change producers make (change/producers/*.ts)
    const r = await win.evaluate(
      ({ pipeline, project, params }) =>
        window.aio.invoke('jobs:start', {
          pipeline: pipeline as 'change.cloud',
          project,
          params: params as Record<string, unknown>,
        }),
      { pipeline, project, params },
    );
    if (!r.ok) throw new Error(r.error);
    const jobId = r.job.id;
    await expect
      .poll(
        async () => {
          const list = await win.evaluate(() => window.aio.invoke('jobs:list', {}));
          const job = list.jobs.find((j) => j.id === jobId);
          return job?.status === 'failed' ? `failed: ${job.error ?? ''}` : job?.status;
        },
        { timeout: 120_000 },
      )
      .toBe('done');
  }

  const layerShown = (win: Page, id: string) =>
    expect
      .poll(() =>
        win.evaluate(
          (id) =>
            (window as unknown as Inspect).__stratlas.workspace
              .getState()
              .project?.manifest.layers.some((l) => l.id === id) ?? false,
          id,
        ),
      )
      .toBe(true);

  test('Run cloud change: a change cloud layer appears, coloured by its distances', async ({
    dataRoot,
    network,
  }) => {
    test.skip(!hasPdal, `no PDAL at ${pdal} (set AIO_PDAL)`);
    test.setTimeout(180_000);
    makeYard(dataRoot.projectDir, true);
    await writeManifest(
      dataRoot.projectDir,
      CAPTURES.map((c) => ({
        kind: 'pointcloud' as const,
        id: `site-${c.date}`,
        name: `Site ${c.date}`,
        capture: c.id,
        src: { path: `clouds/site-${c.date}.copc.laz` },
        format: 'copc' as const,
      })),
    );
    const app = await launchApp(dataRoot, { STRATLAS_PIPELINE_PYTHON: venvPython, AIO_PDAL: pdal });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await openYard(win);
      await runJob(win, 'change.cloud', dataRoot.projectDir, {
        layerFrom: 'site-2026-01-10',
        layerTo: 'site-2026-02-10',
        captures: { from: 'c1', to: 'c2' },
        minDistM: 0.05,
        maxDistM: 0.3,
      });
      // the open project reloads its manifest: the change cloud is a layer
      await layerShown(win, 'c1-c2-cloud');
      const set = JSON.parse(
        await readFile(join(dataRoot.projectDir, 'change', 'c1-c2-cloud.json'), 'utf8'),
      ) as { items: { verdict: string; at: number[] }[]; registration: { ok: boolean } };
      expect(set.registration.ok).toBe(true);
      const verdicts = set.items.map((i) => i.verdict).sort();
      expect(verdicts).toEqual(['added', 'changed']);
      await win.evaluate((view) => {
        (window as unknown as Inspect).__stratlas.stage()?.restoreView(view, false);
      }, VIEW);
      await colourByChange(win);
      await expect(win.locator('[data-component="change-legend"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => (await sample(win, PIPE)).warm, { timeout: 30_000 })
        .toBeGreaterThan(3);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('Run model change: parts added, removed, moved and dented, and a deviation model', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(180_000);
    makeYard(dataRoot.projectDir, false);
    const tags = (date: 'e1' | 'e2', parts: string[]) =>
      parts.map((p) => ({ node: `${p}_${date}`, tag: p }));
    await writeManifest(dataRoot.projectDir, [
      {
        kind: 'mesh',
        id: 'site-e1',
        name: 'Site model 2026-01-10',
        capture: 'c1',
        src: { path: 'models/site-e1.glb' },
        transform: IDENTITY,
        tags: tags('e1', ['T-101', 'P-201', 'K-301']),
      },
      {
        kind: 'mesh',
        id: 'site-e2',
        name: 'Site model 2026-02-10',
        capture: 'c2',
        src: { path: 'models/site-e2.glb' },
        transform: IDENTITY,
        tags: tags('e2', ['T-101', 'P-201', 'B-401']),
      },
    ]);
    const app = await launchApp(dataRoot, { STRATLAS_PIPELINE_PYTHON: venvPython });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await openYard(win);
      await runJob(win, 'change.mesh', dataRoot.projectDir, {
        layerFrom: 'site-e1',
        layerTo: 'site-e2',
        captures: { from: 'c1', to: 'c2' },
        minDistM: 0.05,
        maxDistM: 0.3,
        samples: 20_000,
      });
      await layerShown(win, 'c1-c2-mesh');
      const set = JSON.parse(
        await readFile(join(dataRoot.projectDir, 'change', 'c1-c2-mesh.json'), 'utf8'),
      ) as {
        items: {
          part: string;
          verdict: string;
          offsetM?: number[];
          deviation?: { maxM: number };
        }[];
      };
      const byPart = Object.fromEntries(set.items.map((i) => [i.part, i]));
      expect(Object.fromEntries(set.items.map((i) => [i.part, i.verdict]))).toEqual({
        'B-401': 'added',
        'K-301': 'removed',
        'P-201': 'moved',
        'T-101': 'changed',
      });
      expect(byPart['P-201']?.offsetM?.[2]).toBeCloseTo(-0.6, 2);
      expect(byPart['T-101']?.deviation?.maxM).toBeGreaterThan(0.2);
      // the deviation model is a hidden layer of the later date until the person shows it
      const manifest = JSON.parse(
        await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8'),
      ) as { layers: { id: string; visible: boolean; capture?: string }[] };
      expect(manifest.layers.find((l) => l.id === 'c1-c2-mesh')).toMatchObject({
        visible: false,
        capture: 'c2',
      });
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
