import { fromWgs84, toWgs84 } from '@aio/geo';
import { withExif } from '@aio/project/builder/testing';
import type { Issue, LensModel, Quat, Vec3 } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, launchApp, test } from './fixtures';
import { copyRealData, hasRealProject, missingRealProject, realProjectDir } from './realData';

/**
 * The inspection pipeline (Asset Inspection Kit) run from the Jobs panel against the real pipeline
 * runtime: on a project built in the app from raw photos and a model, and on a temporary copy of
 * the HCl project. Needs the development venv (`uv sync` in python/) or QUADRION_E2E_PYTHON.
 */
const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.QUADRION_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));
const hasPython = existsSync(venvPython);
/** The real HCl project, only read (realData.ts); the test runs on a copy. */
const HCL = realProjectDir('hcl').replace(/\\/g, '/');

// ---------------------------------------------------------------- camera maths (app lens.ts)

function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Pixel of a local point in a pinhole photo of `size`, or null outside the frame. */
function toPixel(
  cam: { pos: Vec3; q: Quat },
  hfovDeg: number,
  size: [number, number],
  p: Vec3,
): [number, number] | null {
  const rel = rotate(
    [-cam.q[0], -cam.q[1], -cam.q[2], cam.q[3]],
    [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]],
  );
  if (rel[2] >= 0) return null;
  const f = size[0] / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  const x = size[0] / 2 + (f * rel[0]) / -rel[2];
  const y = size[1] / 2 - (f * rel[1]) / -rel[2];
  return x >= 0 && y >= 0 && x <= size[0] && y <= size[1] ? [x, y] : null;
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

const meshPoint = (i: Issue): Vec3 | null => {
  const s = i.sightings.find((x) => x.on === 'mesh');
  return s?.on === 'mesh' && s.geom.type === 'spoint' ? s.geom.p : null;
};

/** Distance from an issue's mesh sighting to a point (Infinity without one). */
const offBy = (i: Issue | undefined, p: Vec3) => {
  const q = i ? meshPoint(i) : null;
  return q ? dist(q, p) : Infinity;
};

const box = (px: [number, number], half: number) => [
  px[0] - half,
  px[1] - half,
  px[0] + half,
  px[1] + half,
];

// ---------------------------------------------------------------- raw inputs

/** A GLB box (outward faces, counter-clockwise) from `min` to `max`, Y up. */
function boxGlb(min: Vec3, max: Vec3): Buffer {
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const h: Vec3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  // normal, u, v with u x v = normal
  const faces: [Vec3, Vec3, Vec3][] = [
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  const ext = (d: Vec3) => Math.abs(d[0]) * h[0] + Math.abs(d[1]) * h[1] + Math.abs(d[2]) * h[2];
  for (const [n, u, v] of faces) {
    const hn = ext(n);
    const hu = ext(u);
    const hv = ext(v);
    const base = pos.length / 3;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const)
      for (const k of [0, 1, 2] as const)
        pos.push(c[k] + n[k] * hn + u[k] * hu * su + v[k] * hv * sv);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const positions = new Float32Array(pos);
  const indices = new Uint16Array(idx);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0', generator: 'aio e2e inspection' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tower_body' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const body = pad(bin, 0);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(json, 0x4e4f534a), chunk(body, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}

/** Make the next native open dialog return these files (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

interface Inspect {
  __stratlas: {
    workspace: {
      getState: () => { issues: Issue[]; project: { id: string; root: string } | null };
    };
  };
}

const workspaceIssues = (win: Page) =>
  win.evaluate(() => (window as unknown as Inspect).__stratlas.workspace.getState().issues);

/** Start the inspection pipeline from the Jobs panel and wait for it to finish. */
async function runInspection(win: Page, expectDefault: boolean): Promise<string> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
  await expect(win.locator('.jobs-rt')).toContainText('Pipeline pack dev');
  await win.getByRole('button', { name: 'New job' }).click();
  const pick = win.getByLabel('Pipeline', { exact: true });
  if (expectDefault) await expect(pick).toHaveValue('inspection.run');
  else await pick.selectOption('inspection.run');
  await expect(win.getByLabel('Detections', { exact: true })).toBeVisible();
  await win.getByTestId('job-start').click();
  const detail = win.locator('.job-detail');
  await expect(detail.locator('.jd-h h2')).toHaveText('Inspection: detections to issues');
  await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 180_000 });
  await expect(detail.locator('.jd-steps li[data-state="done"]')).toHaveCount(6);
  return (await detail.locator('.jd-t .mono').textContent()) ?? '';
}

/**
 * A tower inspection project built in the app from raw inputs: a 4 x 20 x 4 m box model and
 * three DJI photos with gimbal angles, imported through the raw import. Returns the project
 * folder, its posed photos and the pixel of a local point in a photo.
 */
async function buildTower(
  app: ElectronApplication,
  win: Page,
  dataRoot: { base: string; root: string },
) {
  // raw inputs: a 4 x 20 x 4 m tower and three DJI photos with gimbal angles
  const origin = fromWgs84([48.1352, 29.0276, 30], 32639);
  const W = 800;
  const H = 600;
  const plain = await sharp({
    create: { width: W, height: H, channels: 3, background: '#7a8590' },
  })
    .jpeg()
    .toBuffer();
  const shots: { name: string; at: Vec3; yaw: number; pitch: number }[] = [
    { name: 'DJI_0001.JPG', at: [25, 10, 0], yaw: -90, pitch: 0 },
    { name: 'DJI_0002.JPG', at: [20, 14, 12], yaw: -56.3, pitch: -10.5 },
    { name: 'DJI_0003.JPG', at: [0, 16, -25], yaw: 180, pitch: 0 },
  ];
  const files: string[] = [];
  for (const s of shots) {
    const [lon, lat, alt] = toWgs84(
      [origin[0] + s.at[0], origin[1] - s.at[2], 30 + s.at[1]],
      32639,
    );
    const f = join(dataRoot.base, s.name);
    await writeFile(
      f,
      withExif(
        {
          make: 'DJI',
          lat,
          lon,
          alt,
          focal35: 24,
          width: W,
          height: H,
          dateTimeOriginal: '2026:01:02 10:00:00',
          dji: {
            GimbalYawDegree: s.yaw.toFixed(1),
            GimbalPitchDegree: s.pitch.toFixed(1),
            GimbalRollDegree: '0',
            AbsoluteAltitude: alt.toFixed(2),
          },
        },
        plain,
      ),
    );
    files.push(f);
  }
  const glb = join(dataRoot.base, 'tower.glb');
  await writeFile(glb, boxGlb([-2, 0, -2], [2, 20, 2]));

  // 1. new inspection project (the wizard's default type)
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Tower inspection');
  await expect(wiz.getByRole('button', { name: /Inspection/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Create project' }).click();
  await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
  const root = join(dataRoot.root, 'projects', 'tower-inspection');

  // 2. raw import: photos with poses and the model
  await nextOpenDialog(app, [...files, glb]);
  await win.getByRole('button', { name: 'Import files' }).click();
  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 4 of 4 files', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Close' }).click();
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    type: string;
    layers: {
      kind: string;
      id: string;
      items?: { id: string; pos: Vec3; q: Quat; lens: LensModel }[];
    }[];
  };
  expect(manifest.type).toBe('inspection');
  const photos = manifest.layers.find((l) => l.kind === 'photos')?.items ?? [];
  expect(photos).toHaveLength(3);

  // 3. detections from a review pass: boxes around known points of the tower's faces. The kit
  // places a box at the median-distance hit of a 5 x 5 ray grid in its central half, which can
  // sit up to about a quarter box from the centre: small boxes keep that under 15 cm here.
  const EAST: Vec3 = [2, 10, 0];
  const NORTH: Vec3 = [0, 16, -2];
  const px = (i: number, p: Vec3) => {
    const ph = photos[i];
    if (!ph) throw new Error('photo missing');
    const r = toPixel(ph, ph.lens.hfovDeg, [W, H], p);
    if (!r) throw new Error(`${ph.id} does not see ${p.join(', ')}`);
    return r;
  };
  return { root, photos, px, EAST, NORTH };
}

test.describe('inspection pipeline', () => {
  test.skip(!hasPython, `no Python with aio_pipelines at ${venvPython}`);

  test('a project built in the app runs the kit from the Jobs panel; issues land where the boxes are', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(240_000);
    const app = await launchApp(dataRoot, { QUADRION_PIPELINE_PYTHON: venvPython });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      const { root, photos, px, EAST, NORTH } = await buildTower(app, win, dataRoot);
      const [p1, p2, p3] = photos;
      await mkdir(join(root, 'detections'), { recursive: true });
      await writeFile(
        join(root, 'detections', 'review.json'),
        JSON.stringify({
          schema: 'aio.detections/1',
          source: 'human',
          producer: 'e2e reviewer',
          detections: [
            {
              id: 'r1',
              photo: p1?.id,
              class: 'corrosion',
              severity: 2,
              bbox: box(px(0, EAST), 5),
            },
            {
              id: 'r2',
              photo: p2?.id,
              class: 'corrosion',
              severity: 3,
              bbox: box(px(1, EAST), 5),
            },
            {
              id: 'r3',
              photo: p3?.id,
              class: 'crack',
              bbox: box(px(2, NORTH), 5),
              note: 'Hairline',
            },
          ],
        }),
      );
      // an AI pass nobody has reviewed yet: it must not count
      await writeFile(
        join(root, 'detections', 'ai.json'),
        JSON.stringify({
          schema: 'aio.detections/1',
          source: 'ai',
          detections: [
            {
              photo: p1?.id,
              class: 'damage',
              status: 'draft',
              confidence: 0.6,
              bbox: [10, 10, 60, 60],
            },
          ],
        }),
      );
      // a person's own issue, made in the app before the run
      const projectId = await win.evaluate(
        () => (window as unknown as Inspect).__stratlas.workspace.getState().project?.id ?? '',
      );
      const mine: Issue = {
        id: 'mine-1',
        code: 'F01',
        classId: 'damage',
        severityModelId: 'general-inspection',
        severity: 1,
        status: 'reviewed',
        title: 'Loose cable tray',
        note: '',
        author: 'e2e',
        createdAt: '2026-01-02T10:00:00Z',
        updatedAt: '2026-01-02T10:00:00Z',
        sightings: [
          {
            on: 'mesh',
            layer: 'mesh-tower',
            geom: { type: 'spoint', p: [-2, 3, 0], n: [-1, 0, 0] },
          },
        ],
        source: 'human',
      };
      const w = await win.evaluate(
        ({ projectId, mine }) =>
          window.aio.invoke('project:writeIssues', { projectId, issues: [mine] }),
        { projectId, mine },
      );
      expect(w.ok).toBe(true);

      // 4. the Jobs panel offers the inspection pipeline for an inspection project
      const jobId = await runInspection(win, true);
      const log = await readFile(join(root, 'jobs', jobId, 'job.log'), 'utf8');
      expect(log).toContain('1 draft, not reviewed');

      // 5. issues: the person's issue kept, two groups placed where the boxes are
      const issues = (
        JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as { issues: Issue[] }
      ).issues;
      expect(issues[0]).toEqual(mine);
      expect(issues).toHaveLength(3);
      const crack = issues.find((i) => i.classId === 'crack');
      const rust = issues.find((i) => i.classId === 'corrosion');
      expect(crack?.code).toBe('D01');
      expect(rust?.code).toBe('D02');
      expect(offBy(rust, EAST)).toBeLessThan(0.15);
      expect(offBy(crack, NORTH)).toBeLessThan(0.15);
      expect(rust?.sightings.filter((s) => s.on === 'image')).toHaveLength(2);
      expect(rust?.severity).toBe(3);
      expect(rust?.sightings.find((s) => s.on === 'mesh')).toMatchObject({ layer: 'mesh-tower' });

      // the open project took the merged issues
      await expect
        .poll(async () => (await workspaceIssues(win)).map((i) => i.id).sort())
        .toEqual(issues.map((i) => i.id).sort());
      await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
      await expect(win.getByText('Crack, Tower body').first()).toBeVisible();

      // contact sheets and stats for the report
      expect(existsSync(join(root, 'inspection', 'contact', 'sheet-00.jpg'))).toBe(true);
      const records = JSON.parse(
        await readFile(join(root, 'inspection', 'records.json'), 'utf8'),
      ) as { stats: { findings: number; mapped: number; defects: number } };
      expect(records.stats).toMatchObject({ findings: 3, mapped: 3, defects: 2 });

      // 6. run again: same issues, same ids (nothing duplicated)
      await runInspection(win, true);
      const again = (
        JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as { issues: Issue[] }
      ).issues;
      expect(again).toEqual(issues);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('an AI pass reviewed in the app: the pipeline places the accepted ones on their issue, no duplicate', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(240_000);
    const app = await launchApp(dataRoot, { QUADRION_PIPELINE_PYTHON: venvPython });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      const { root, photos, px, EAST, NORTH } = await buildTower(app, win, dataRoot);
      const [p1, p2, p3] = photos;
      await mkdir(join(root, 'detections'), { recursive: true });
      // an AI pass nobody reviewed yet: two views of one rust spot and a false alarm
      await writeFile(
        join(root, 'detections', 'ai-run-1.json'),
        JSON.stringify({
          schema: 'aio.detections/1',
          source: 'ai',
          producer: 'anthropic claude-opus-5-5',
          run: {
            id: 'run-1',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            promptVersion: 'detect-v1',
          },
          detections: [
            {
              id: 'a1',
              photo: p1?.id,
              class: 'corrosion',
              severity: 2,
              status: 'draft',
              confidence: 0.9,
              bbox: box(px(0, EAST), 5),
            },
            {
              id: 'a2',
              photo: p2?.id,
              class: 'corrosion',
              severity: 2,
              status: 'draft',
              confidence: 0.8,
              bbox: box(px(1, EAST), 5),
            },
            {
              id: 'a3',
              photo: p1?.id,
              class: 'corrosion',
              severity: 1,
              status: 'draft',
              confidence: 0.4,
              bbox: [10, 10, 60, 40],
            },
          ],
        }),
      );
      // a person's pass the pipeline turns into an issue of its own
      await writeFile(
        join(root, 'detections', 'review.json'),
        JSON.stringify({
          schema: 'aio.detections/1',
          source: 'human',
          detections: [{ id: 'r1', photo: p3?.id, class: 'crack', bbox: box(px(2, NORTH), 5) }],
        }),
      );

      // review: X rejects the false alarm, A accepts the first view, L links the second to it
      await win.locator('.sb-nav .nav-item', { hasText: 'Detections' }).click();
      const counts = win.getByTestId('det-counts');
      await expect(counts).toContainText('3 waiting · 1 accepted · 0 rejected');
      const inspector = win.getByTestId('det-inspector');
      await expect(inspector).toContainText('Confidence 40%');
      await win.getByTestId('det-sheet').locator('.det-tile').first().click();
      await win.keyboard.press('x');
      await expect(inspector).toContainText('Confidence 90%');
      await win.keyboard.press('a');
      await expect(counts).toContainText('1 waiting · 2 accepted · 1 rejected');
      await expect(inspector).toContainText('Confidence 80%');
      await win.keyboard.press('l');
      await win.getByPlaceholder('Find an issue by code or title').press('Enter');
      await expect(counts).toContainText('0 waiting · 3 accepted · 1 rejected');
      await expect(win.getByTestId('det-save')).toHaveText('Saved');

      // on disk: both views name the review's issue; the false alarm is rejected
      const pass = async () =>
        (
          JSON.parse(await readFile(join(root, 'detections', 'ai-run-1.json'), 'utf8')) as {
            detections: { id: string; status: string; issueId?: string }[];
          }
        ).detections;
      await expect
        .poll(async () => (await pass()).map((d) => `${d.id}:${d.status}`).join(','))
        .toBe('a1:accepted,a2:accepted,a3:rejected');
      const [a1, a2] = await pass();
      expect(a1?.issueId).toBeTruthy();
      expect(a2?.issueId).toBe(a1?.issueId);
      await expect
        .poll(async () =>
          (
            JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as { issues: Issue[] }
          ).issues.map((i) => i.id),
        )
        .toEqual([a1?.issueId]);

      // the pipeline places the review's issue and makes one issue of its own (the person's crack)
      const jobId = await runInspection(win, true);
      const log = await readFile(join(root, 'jobs', jobId, 'job.log'), 'utf8');
      expect(log).toContain('1 rejected');
      expect(log).toContain('1 accepted in the review');
      const issues = (
        JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as { issues: Issue[] }
      ).issues;
      expect(issues).toHaveLength(2);
      const rust = issues.find((i) => i.id === a1?.issueId);
      const crack = issues.find((i) => i.id !== a1?.issueId);
      expect(rust?.code).toBe('F01');
      expect(rust?.sightings.filter((s) => s.on === 'image')).toHaveLength(2);
      expect(rust?.sightings.filter((s) => s.on === 'mesh')).toHaveLength(1);
      expect(offBy(rust, EAST)).toBeLessThan(0.3);
      expect(crack).toMatchObject({ classId: 'crack', code: 'D01' });
      expect(issues.filter((i) => i.classId === 'corrosion')).toHaveLength(1);

      // the review shows the pipeline's issue and offers nothing to accept twice
      await win.locator('.sb-nav .nav-item', { hasText: 'Detections' }).click();
      await win.getByRole('button', { name: 'All', exact: true }).click();
      await expect(counts).toContainText('0 waiting · 3 accepted · 1 rejected');
      const crackTile = win
        .getByTestId('det-sheet')
        .locator('.det-tile', { hasText: p3?.id ?? '' });
      await crackTile.click();
      await expect(win.getByTestId('det-accepted-as')).toHaveText(
        'The inspection pipeline made issue D01 from it.',
      );
      await expect(win.getByTestId('det-accept')).toHaveCount(0);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('@realdata on a copy of HCl: detections on the tank photos become issues on the tank where they are', async ({
    dataRoot,
    network,
  }) => {
    test.skip(!hasRealProject('hcl'), missingRealProject('hcl'));
    test.setTimeout(300_000);
    // a temporary copy: the manifest without the 3.7 GB of video, the tank model, photos, issues
    const root = join(dataRoot.root, 'projects', 'hcl');
    const realIssues = await readFile(join(HCL, 'issues.json'));
    const realBefore = await fingerprint(HCL);
    const m = JSON.parse(await readFile(join(HCL, 'manifest.json'), 'utf8')) as {
      layers: { kind: string }[];
    };
    m.layers = m.layers.filter((l) => l.kind === 'mesh' || l.kind === 'photos');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'manifest.json'), JSON.stringify(m, null, 2));
    await writeFile(join(root, 'issues.json'), realIssues);
    // real copies, never links: the Python pipeline writes beside them, outside the app's guard
    for (const d of ['models', 'photos'])
      await copyRealData(['projects', 'hcl', d], join(root, d), { link: false });
    const before = (JSON.parse(realIssues.toString('utf8')) as { issues: Issue[] }).issues;

    const app = await launchApp(dataRoot, { QUADRION_PIPELINE_PYTHON: venvPython });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win.getByTestId('project-card').filter({ hasText: /HCl/i }).first().click();
      await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
      // Targets picked with the app's own engine raycast, independent of the pipeline's maths:
      // a point on the tank at the centre of one photo that a second photo sees unobstructed.
      const found: { targets: Target[] | null } = { targets: null };
      await expect
        .poll(
          async () => {
            found.targets = await win.evaluate(pickTargets, { size: HCL_SIZE, hfov: HCL_HFOV });
            return found.targets !== null;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const [t1, t2] = found.targets ?? [];
      if (!t1 || !t2) throw new Error('no targets');
      const dets = [
        ...t1.views.map((v, i) => ({
          id: `hcl-a${String(i)}`,
          photo: v.photo,
          class: 'coating-blister',
          severity: 3,
          bbox: box(v.px, 10),
        })),
        ...t2.views.map((v, i) => ({
          id: `hcl-b${String(i)}`,
          photo: v.photo,
          class: 'corrosion',
          severity: 4,
          bbox: box(v.px, 10),
        })),
      ];
      await mkdir(join(root, 'detections'), { recursive: true });
      await writeFile(
        join(root, 'detections', 'review.json'),
        JSON.stringify({ schema: 'aio.detections/1', source: 'human', detections: dets }),
      );

      await runInspection(win, false);

      const after = (
        JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as { issues: Issue[] }
      ).issues;
      // the 13 issues of the delivered review are all still there, unchanged
      expect(after.slice(0, before.length)).toEqual(before);
      const made = after.slice(before.length);
      expect(made).toHaveLength(2);
      const blister = made.find((i) => i.classId === 'coating-blister');
      const rust = made.find((i) => i.classId === 'corrosion');
      expect(offBy(blister, t1.p)).toBeLessThan(0.1);
      expect(offBy(rust, t2.p)).toBeLessThan(0.1);
      expect(blister?.sightings.find((s) => s.on === 'mesh')).toMatchObject({ layer: 'tank' });
      expect(blister?.severityModelId).toBe('hcl-lining');
      expect(new Set(made.map((i) => i.code)).size).toBe(2);
      for (const i of made) expect(before.some((b) => b.code === i.code)).toBe(false);
      await expect
        .poll(async () => (await workspaceIssues(win)).length, { timeout: 15_000 })
        .toBe(before.length + 2);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
    // the real project was only read
    expect(await fingerprint(HCL)).toEqual(realBefore);
  });
});

/** Names, sizes and modification times of a project's top level and issues. */
async function fingerprint(dir: string): Promise<string> {
  const names = (await readdir(dir)).sort();
  const rows = await Promise.all(
    names.map(async (n) => {
      const s = await stat(join(dir, n));
      return `${n}\t${String(s.size)}\t${String(s.mtimeMs)}`;
    }),
  );
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

const HCL_SIZE: [number, number] = [480, 360];
/** HCl photos carry no lens: the pipeline's default (the kit's 70 degrees). */
const HCL_HFOV = 70;

interface Target {
  p: Vec3;
  views: { photo: string; px: [number, number] }[];
}

/** In the page: two tank points, each seen by two photos, found with the engine's raycast. */
function pickTargets({ size, hfov }: { size: [number, number]; hfov: number }): Target[] | null {
  interface V {
    x: number;
    y: number;
    z: number;
  }
  interface Obj {
    userData: Record<string, unknown>;
    parent: unknown;
  }
  const w = window as unknown as {
    __stratlas: {
      workspace: {
        getState: () => {
          project: {
            manifest: {
              layers: { kind: string; items?: { id: string; pos?: Vec3; q?: Quat }[] }[];
            };
          } | null;
        };
      };
      stage: () => {
        camera: { position: { constructor: new (x: number, y: number, z: number) => V } };
        raycastRay: (o: V, d: V) => { point: V; object: Obj } | null;
      } | null;
    };
  };
  const st = w.__stratlas.stage();
  const project = w.__stratlas.workspace.getState().project;
  if (!st || !project) return null;
  const Vec = st.camera.position.constructor;
  const rot = (q: Quat, v: Vec3): Vec3 => {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ];
  };
  const f = size[0] / 2 / Math.tan((hfov * Math.PI) / 360);
  const layerOf = (o: Obj | null): string | null => {
    let x = o;
    while (x) {
      if (typeof x.userData.layerId === 'string') return x.userData.layerId;
      x = x.parent as Obj | null;
    }
    return null;
  };
  const d3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const cast = (pos: Vec3, q: Quat, px: number, py: number): Vec3 | null => {
    const d = rot(q, [(px - size[0] / 2) / f, (size[1] / 2 - py) / f, -1]);
    const h = st.raycastRay(new Vec(pos[0], pos[1], pos[2]), new Vec(d[0], d[1], d[2]));
    if (!h || layerOf(h.object) !== 'tank') return null;
    return [h.point.x, h.point.y, h.point.z];
  };
  const view = (pos: Vec3, q: Quat, p: Vec3): [number, number] | null => {
    const rel = rot([-q[0], -q[1], -q[2], q[3]], [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]]);
    if (rel[2] >= -0.3) return null;
    const x = size[0] / 2 + (f * rel[0]) / -rel[2];
    const y = size[1] / 2 - (f * rel[1]) / -rel[2];
    return x > 30 && y > 30 && x < size[0] - 30 && y < size[1] - 30 ? [x, y] : null;
  };
  const items = (project.manifest.layers.find((l) => l.kind === 'photos')?.items ?? []).filter(
    (p): p is { id: string; pos: Vec3; q: Quat } => Boolean(p.pos && p.q),
  );
  const out: Target[] = [];
  for (const a of items) {
    if (out.length === 2) break;
    const p = cast(a.pos, a.q, 240, 180);
    if (!p || d3(p, a.pos) > 6 || out.some((t) => d3(t.p, p) < 1.5)) continue;
    for (const b of items) {
      if (b.id === a.id || d3(b.pos, a.pos) < 0.5) continue;
      const px = view(b.pos, b.q, p);
      if (!px) continue;
      const back = cast(b.pos, b.q, px[0], px[1]);
      if (!back || d3(back, p) > 0.03) continue;
      out.push({
        p,
        views: [
          { photo: a.id, px: [240, 180] },
          { photo: b.id, px },
        ],
      });
      break;
    }
  }
  return out.length === 2 ? out : null;
}
