/**
 * Drag handles on the selected antenna's box, in the real app with the real `telecom.flag` job.
 * The RF fixture's panels are 1.3 m boxes; the cloud written here has 2.6 m panels behind them, so
 * each box covers only the lower half of its panel. P1 is selected with a click in 3D, its top
 * arrow dragged up the panel: only the top face moves, the chip names the height, the value labels
 * step aside. On release the unit is measured again from the points in the new box and saved as
 * flagged with the panel's height, its bottom where it was; a detection re-run keeps it.
 */
import type { EngineStage } from '@aio/engine';
import { AntennasFile, ProjectManifest, type AntennaUnit } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_ENV, expect, hasPipelinePython, test, tinyManifest } from './fixtures';
import { measureControl } from './island';
import { RF_SITE, writeRfProject } from './rfFixtures';
import { packPngCloud } from './telecomFixtures';

type Vec3 = [number, number, number];
type Box = AntennaUnit['box'];

interface Inspect {
  __stratlas: {
    stage(): EngineStage | null;
    antennas: {
      getState(): {
        selected: string | null;
        running: boolean;
        needsHint: boolean;
        message: string | null;
        file: { units: AntennaUnit[] } | null;
        boxEdit: { unitId: string; phase: 'drag' | 'measure'; box: Box } | null;
      };
    };
  };
}

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

/** Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI). */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

/** The full height of the panels in the cloud; the inventory's boxes are half of it. */
const PANEL_M = 2.6;

/** The tower and ground of the RF fixture, plus full height (2.6 m) panels behind each box. */
async function writePanelCloud(projectDir: string): Promise<void> {
  const [ox, oy] = tinyManifest().origin;
  const [cx, cz] = [RF_SITE.east - ox, -(RF_SITE.north - oy)];
  const xyz: number[] = [];
  for (let y = 0; y <= RF_SITE.heightM + 2.5; y += 0.1)
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      xyz.push(cx + 0.4 * Math.cos(a), y, cz + 0.4 * Math.sin(a));
    }
  for (let r = 1; r <= 10; r += 1)
    for (let k = 0; k < 36; k++) {
      const a = (k * Math.PI) / 18;
      xyz.push(cx + r * Math.cos(a), 0, cz + r * Math.sin(a));
    }
  const panels: [number, number][] = [
    [0, RF_SITE.heightM],
    [120, RF_SITE.heightM],
    [240, RF_SITE.heightM],
    [300, RF_SITE.heightM - 6],
  ];
  for (const [az, h] of panels) {
    const a = (az * Math.PI) / 180;
    const [ax, az2] = [Math.cos(a), Math.sin(a)];
    const [ox2, oz2] = [Math.sin(a), -Math.cos(a)];
    const [c0, c1, c2] = [cx + 0.8 * ox2, h - 0.65, cz + 0.8 * oz2];
    // a box 0.3 x 2.6 x 0.15 from the bottom of the drawn box up: its six faces as points
    const step = 0.03;
    const put = (u: number, v: number, d: number) =>
      xyz.push(c0 + ax * u + ox2 * d, c1 + v, c2 + az2 * u + oz2 * d);
    for (let v = 0; v <= PANEL_M; v += step) {
      for (let u = -0.15; u <= 0.15; u += step) {
        put(u, v, 0.075);
        put(u, v, -0.075);
      }
      for (let d = -0.075; d <= 0.075; d += step) {
        put(-0.15, v, d);
        put(0.15, v, d);
      }
    }
    for (let u = -0.15; u <= 0.15; u += step)
      for (let d = -0.075; d <= 0.075; d += step) put(u, PANEL_M, d);
  }
  const count = await packPngCloud(projectDir, 'tower', xyz, [170, 178, 186], 0.02);
  const path = join(projectDir, 'manifest.json');
  const manifest = ProjectManifest.parse(JSON.parse(await readFile(path, 'utf8')));
  for (const l of manifest.layers) if (l.kind === 'pointcloud') l.pointCount = count;
  await writeFile(path, JSON.stringify(manifest));
}

/**
 * Look at P1 (it faces grid north) from the front, a little east and above, far enough back that
 * the whole 2.6 m panel behind its box is in view at 1100 x 720 with the right panel open.
 */
async function view(win: Page): Promise<void> {
  const [ox, oy] = tinyManifest().origin;
  const [cx, cz] = [RF_SITE.east - ox, -(RF_SITE.north - oy)];
  await win.evaluate(
    ([x, z, h]) => {
      (window as unknown as Inspect).__stratlas.stage()?.restoreView(
        {
          position: [x + 2.6, h + 1.9, z - 0.8 - 4.4],
          target: [x, h + 0.65, z - 0.8],
        },
        false,
      );
    },
    [cx, cz, RF_SITE.heightM] as const,
  );
  await win.waitForTimeout(1_200);
}

const add = (p: Vec3, q: Vec3, k: number): Vec3 => [
  p[0] + q[0] * k,
  p[1] + q[1] * k,
  p[2] + q[2] * k,
];

/** The centre of a box's bottom (-up) or top (+up) face, project ENZ. */
const face = (box: Box, sign: 1 | -1): Vec3 =>
  add(box.centre, box.axes[1], (sign * box.extents[1]) / 2);

const dist = (p: Vec3, q: Vec3) => Math.hypot(...add(p, q, -1));

/** A project ENZ point on screen (CSS px), through the stage camera. */
async function onScreen(win: Page, p: Vec3): Promise<{ x: number; y: number }> {
  const [ox, oy, oz] = tinyManifest().origin;
  const local: Vec3 = [p[0] - ox, p[2] - oz, -(p[1] - oy)];
  return win.evaluate((at) => {
    const stage = (window as unknown as Inspect).__stratlas.stage();
    if (!stage) throw new Error('no stage');
    stage.camera.updateMatrixWorld();
    const v = stage.camera.position.clone().set(at[0], at[1], at[2]).project(stage.camera);
    const r = stage.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, local);
}

/** Click P1's box in the 3D view. */
async function clickBox(win: Page): Promise<void> {
  const at = await win.evaluate(() => {
    const stage = (window as unknown as Inspect).__stratlas.stage();
    const mesh = stage?.scene.getObjectByName('antenna-box:ant-p1');
    if (!stage || !mesh) throw new Error('no box');
    stage.camera.updateMatrixWorld();
    const ndc = mesh.getWorldPosition(stage.camera.position.clone()).project(stage.camera);
    const r = stage.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((ndc.x + 1) / 2) * r.width, y: r.top + ((1 - ndc.y) / 2) * r.height };
  });
  await win.mouse.click(at.x, at.y);
}

const antennaState = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Inspect).__stratlas.antennas.getState();
    return {
      selected: s.selected,
      running: s.running,
      needsHint: s.needsHint,
      message: s.message,
      boxEdit: s.boxEdit,
      unit: s.file?.units.find((u) => u.id === 'ant-p1') ?? null,
    };
  });

const savedP1 = async (dir: string): Promise<AntennaUnit | null> => {
  const raw = await readFile(join(dir, 'telecom', 'antennas.json'), 'utf8').catch(() => null);
  if (!raw) return null;
  return AntennasFile.parse(JSON.parse(raw)).units.find((u) => u.id === 'ant-p1') ?? null;
};

test('drags the top face of an antenna box up its panel and keeps it through a re-run', async ({
  win,
  dataRoot,
}) => {
  test.setTimeout(420_000);
  const dir = dataRoot.projectDir;
  await writeRfProject(dir, { cloud: true });
  await writePanelCloud(dir);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await expect(win.getByTestId('antenna-labels-control')).toBeVisible({ timeout: 30_000 });
  await view(win);

  // select P1 with a click on its box in 3D
  await clickBox(win);
  await expect.poll(async () => (await antennaState(win)).selected).toBe('ant-p1');
  // a selection may fly the camera: look at P1 again
  await view(win);

  const handles = win.getByTestId('antenna-handles');
  await expect(handles).toBeVisible();
  await expect(handles.locator('[data-face]')).toHaveCount(6);

  const before = (await antennaState(win)).unit;
  if (!before) throw new Error('no P1 in the store');
  const bottom0 = face(before.box, -1);
  const top0 = face(before.box, 1);
  expect(before.box.extents[1]).toBeCloseTo(1.3, 3);

  // press on the top arrow and drag it up to just short of the panel's top
  const top = handles.locator('[data-face="1:+"]');
  const cone = await top.locator('.antenna-handle-cone').boundingBox();
  if (!cone) throw new Error('no top arrow on screen');
  const from = { x: cone.x + cone.width / 2, y: cone.y + cone.height / 2 };
  const goal = await onScreen(win, add(bottom0, before.box.axes[1], PANEL_M - 0.05));
  const topNow = await onScreen(win, top0);
  // the pointer keeps its offset from the face centre it grabbed
  const to = { x: goal.x + from.x - topNow.x, y: goal.y + from.y - topNow.y };
  expect(to.y, 'the goal lies above the arrow on screen').toBeLessThan(from.y - 40);
  const canvas = await win.locator('[data-scene-view] canvas').first().boundingBox();
  if (!canvas) throw new Error('no scene canvas');
  expect(to.y, 'the goal is in the view').toBeGreaterThan(canvas.y + 20);
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++)
    await win.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );

  // mid-drag: the arrow is the active one, the chip names the height, the value labels step aside
  await expect(top).toHaveAttribute('data-active', '1');
  const chip = win.getByTestId('antenna-handle-readout');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/^HHeight \d+\.\d\d m$/);
  await expect(win.locator('.antenna-labels .sv-label[data-key*=":dim:"]:visible')).toHaveCount(0);
  const mid = (await antennaState(win)).boxEdit;
  expect(mid?.unitId).toBe('ant-p1');
  expect(mid?.phase).toBe('drag');
  if (!mid) throw new Error('no drag in the store');
  expect(mid.box.extents[1]).toBeGreaterThan(before.box.extents[1] + 0.5);
  expect(dist(face(mid.box, -1), bottom0), 'the bottom face stays put (m)').toBeLessThan(0.001);
  expect(face(mid.box, 1)[2], 'the top face moves up').toBeGreaterThan(top0[2] + 0.5);
  const chipValue = Number((await chip.textContent())?.match(/(\d+\.\d\d) m$/)?.[1]);
  expect(chipValue).toBeCloseTo(mid.box.extents[1], 2);
  if (EVIDENCE) {
    await mkdir(EVIDENCE, { recursive: true });
    await win
      .locator('[data-scene-view]')
      .first()
      .screenshot({ path: join(EVIDENCE, 'final-drag.png') });
  }

  // release: the unit is measured again from the points in the new box, saved as flagged
  await win.mouse.up();
  await expect.poll(async () => (await savedP1(dir))?.origin, { timeout: 180_000 }).toBe('flagged');
  await expect.poll(async () => (await antennaState(win)).boxEdit, { timeout: 60_000 }).toBeNull();
  const after = await savedP1(dir);
  if (!after) throw new Error('no P1 on disk');
  const height = after.heightM?.value ?? 0;
  expect(height, 'the height grows toward the panel (m)').toBeGreaterThan(2.2);
  expect(height).toBeLessThan(PANEL_M + 0.15);
  expect(after.box.extents[1]).toBeCloseTo(height, 2);
  expect(dist(face(after.box, -1), bottom0), 'the bottom stays near (m)').toBeLessThan(0.05);
  await expect(chip).toBeHidden();

  // a detection re-run keeps the flagged unit as it is
  await measureControl(win, 'telecom-tool-clearance');
  await expect(win.getByTestId('telecom-tools')).toBeVisible();
  const detect = win.getByTestId('detect-antennas');
  await expect(detect).toBeEnabled({ timeout: 60_000 });
  await detect.click();
  await expect
    .poll(
      async () => {
        const s = await antennaState(win);
        if (s.needsHint) return 'asks for the tower';
        if (s.message) return `failed: ${s.message}`;
        return s.running ? 'running' : 'done';
      },
      { timeout: 180_000 },
    )
    .toBe('done');
  const rerun = AntennasFile.parse(
    JSON.parse(await readFile(join(dir, 'telecom', 'antennas.json'), 'utf8')),
  );
  expect(rerun.run.id, 'a new run is on disk').not.toBe('run-rf-e2e');
  // the re-run found the panel again but made no twin of the flagged unit
  const near = rerun.units.filter((u) => dist(u.box.centre, after.box.centre) < 0.3);
  expect(near.map((u) => u.id)).toEqual(['ant-p1']);
  const kept = await savedP1(dir);
  expect(kept?.origin).toBe('flagged');
  expect(kept?.heightM?.value).toBeCloseTo(height, 3);
  expect(dist(face(kept?.box ?? after.box, -1), face(after.box, -1))).toBeLessThan(0.001);

  if (EVIDENCE) {
    // the unit selected after the re-measure, handles showing, not dragging, the 3D view wide
    if ((await antennaState(win)).selected !== 'ant-p1') {
      await view(win);
      await clickBox(win);
      await expect.poll(async () => (await antennaState(win)).selected).toBe('ant-p1');
    }
    await win.getByRole('button', { name: 'Hide the right panel' }).click();
    await win.waitForTimeout(800);
    await view(win);
    await win.mouse.move(5, 5);
    await expect(handles).toBeVisible();
    await win.waitForTimeout(400);
    await win
      .locator('[data-scene-view]')
      .first()
      .screenshot({ path: join(EVIDENCE, 'final-idle.png') });
  }
});
