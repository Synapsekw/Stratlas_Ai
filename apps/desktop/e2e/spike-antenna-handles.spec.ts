/**
 * THROWAWAY DESIGN SPIKE (feat/antenna-box-handles): screenshots of the three drag handle looks
 * on a selected antenna box, for the founder. Not a test: it only captures PNGs into SPIKE_OUT.
 *
 * The RF fixture's panels are 1.3 m boxes; the cloud written here has 2.6 m panels, so each box
 * covers only the lower half of its panel, the case the handles are for.
 */
import type { EngineStage } from '@aio/engine';
import { ProjectManifest } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, tinyManifest } from './fixtures';
import { RF_SITE, writeRfProject } from './rfFixtures';
import { packPngCloud } from './telecomFixtures';

interface Inspect {
  __stratlas: {
    stage(): EngineStage | null;
    antennas: {
      getState(): { selected: string | null; file: unknown };
      setState(patch: Record<string, unknown>): void;
    };
  };
  __antennaHandles?: string;
  __spikeFile?: unknown;
}

const OUT = process.env.SPIKE_OUT ?? join(process.cwd(), 'spike-out');

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
    for (let v = 0; v <= 2.6; v += step) {
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
      for (let d = -0.075; d <= 0.075; d += step) put(u, 2.6, d);
  }
  const count = await packPngCloud(projectDir, 'tower', xyz, [170, 178, 186], 0.02);
  const path = join(projectDir, 'manifest.json');
  const manifest = ProjectManifest.parse(JSON.parse(await readFile(path, 'utf8')));
  for (const l of manifest.layers) if (l.kind === 'pointcloud') l.pointCount = count;
  await writeFile(path, JSON.stringify(manifest));
}

async function view(win: Page): Promise<void> {
  // P1 faces grid north: look at it from the front, a little east and above
  const [ox, oy] = tinyManifest().origin;
  const [cx, cz] = [RF_SITE.east - ox, -(RF_SITE.north - oy)];
  await win.evaluate(
    ([x, z, h]) => {
      (window as unknown as Inspect).__stratlas.stage()?.restoreView(
        {
          position: [x + 1.6, h + 1.45, z - 0.8 - 2.2],
          target: [x, h + 0.4, z - 0.8],
        },
        false,
      );
    },
    [cx, cz, RF_SITE.heightM] as const,
  );
  await win.waitForTimeout(1_200);
}

async function handleAt(win: Page, key: string): Promise<{ x: number; y: number }> {
  const box = await win.locator(`[data-ahs-handle="${key}"]`).boundingBox();
  if (!box) throw new Error(`no handle ${key}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('spike: antenna box handle looks', async ({ win, dataRoot }) => {
  test.setTimeout(300_000);
  await mkdir(OUT, { recursive: true });
  await writeRfProject(dataRoot.projectDir, { cloud: true });
  await writePanelCloud(dataRoot.projectDir);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await expect(win.getByTestId('antenna-labels-control')).toBeVisible({ timeout: 30_000 });
  await win
    .getByTestId('antenna-labels-control')
    .getByRole('button', { name: 'Off', exact: true })
    .click();
  await view(win);

  // select P1 with a click on its box in 3D
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
  await expect
    .poll(() =>
      win.evaluate(() => (window as unknown as Inspect).__stratlas.antennas.getState().selected),
    )
    .toBe('ant-p1');
  await win.waitForTimeout(2_000);
  await win.getByRole('button', { name: 'Hide the right panel' }).click();
  await win.waitForTimeout(800);
  await win.evaluate(() => {
    const w = window as unknown as Inspect;
    w.__spikeFile = w.__stratlas.antennas.getState().file;
    // the other units hidden, so only the selected box and its handles show
    w.__stratlas.antennas.setState({
      hidden: { 'ant-p2': true, 'ant-p3': true, 'ant-p4': true },
    });
  });
  const scene = win.locator('[data-scene-view]').first();

  for (const look of ['A', 'B', 'C'] as const) {
    await win.evaluate((l) => {
      const w = window as unknown as Inspect;
      w.__stratlas.antennas.setState({ file: w.__spikeFile });
      w.__antennaHandles = l;
    }, look);
    await view(win);
    await expect(win.locator('[data-ahs-handle="1:+"]')).toBeVisible();
    // hover the top handle for the idle shot of A (hover grows it); the others idle plain
    await win.mouse.move(5, 5);
    await win.waitForTimeout(400);
    await scene.screenshot({ path: join(OUT, `${look.toLowerCase()}-idle.png`) });
    // drag the top face up to the top of the panel and hold it there
    const top = await handleAt(win, '1:+');
    await win.mouse.move(top.x, top.y);
    await win.mouse.down();
    for (let i = 1; i <= 10; i++) await win.mouse.move(top.x, top.y - 11 * i);
    await win.waitForTimeout(600);
    await scene.screenshot({ path: join(OUT, `${look.toLowerCase()}-drag.png`) });
    await win.mouse.up();
  }
});
