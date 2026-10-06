import type { ProjectManifest } from '@aio/schema';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { createDataRoot, expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

/**
 * The Model builder (BLD-11, M8 stream C5) end to end on synthetic data only: a DXF plot plan
 * written here (two tanks with tags and heights, a building), a point cloud of a tank and a box
 * (kit-packed, made here), the real pipeline pack (the development venv) and the scripted agent.
 * Switch to the C8 change and modelling demo (its DXF, scan and truth.json) once it is on main.
 */
const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.STRATLAS_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));
const hasPython = existsSync(venvPython);

/** An ASCII DXF from group-code pairs. */
function dxf(entities: (string | number)[][], units: number | null): string {
  const pairs: (string | number)[] = [];
  if (units !== null) pairs.push(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, units, 0, 'ENDSEC');
  pairs.push(0, 'SECTION', 2, 'ENTITIES');
  for (const e of entities) pairs.push(...e);
  pairs.push(0, 'ENDSEC', 0, 'EOF');
  const out: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    out.push(String(pairs[i]).padStart(3, ' '), String(pairs[i + 1]));
  }
  return `${out.join('\r\n')}\r\n`;
}

const circle = (h: string, layer: string, x: number, y: number, r: number) => [
  0,
  'CIRCLE',
  5,
  h,
  8,
  layer,
  10,
  x,
  20,
  y,
  30,
  0,
  40,
  r,
];
const text = (h: string, layer: string, x: number, y: number, s: string) => [
  0,
  'TEXT',
  5,
  h,
  8,
  layer,
  10,
  x,
  20,
  y,
  30,
  0,
  40,
  0.8,
  1,
  s,
];
const rect = (h: string, layer: string, x: number, y: number, w: number, d: number) => [
  0,
  'LWPOLYLINE',
  5,
  h,
  8,
  layer,
  90,
  4,
  70,
  1,
  10,
  x,
  20,
  y,
  10,
  x + w,
  20,
  y,
  10,
  x + w,
  20,
  y + d,
  10,
  x,
  20,
  y + d,
];

/** A fictional plot plan in metres: tanks T-101 and T-102, and a workshop. */
const PLOT = [
  circle('1A', 'TANKS', 20, 30, 6),
  text('1B', 'TANKS', 18, 30, 'T-101'),
  text('1C', 'TANKS', 18, 28, 'height=12.5'),
  circle('2A', 'TANKS', 50, 30, 4),
  text('2B', 'TANKS', 48, 30, 'T-102'),
  text('2C', 'TANKS', 48, 28, 'height=10'),
  rect('3A', 'BUILDINGS', 0, 0, 12, 8),
  text('3B', 'BUILDINGS', 4, 4, 'height=4'),
];

/** A synthetic kit-packed cloud (local frame, mm): ground, a tank r 3 m h 6 m, a box. */
function scanCloud(): { bin: Buffer; count: number } {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const pts: number[] = [];
  const add = (x: number, y: number, z: number) => {
    pts.push(x + rnd() * 0.02, y + rnd() * 0.02, z + rnd() * 0.02);
  };
  for (let x = -20; x <= 20; x += 0.3) for (let z = -20; z <= 20; z += 0.3) add(x, 0, z);
  // tank at (8, -8)
  for (let a = 0; a < 2 * Math.PI; a += 0.05)
    for (let y = 0.1; y <= 6; y += 0.15) add(8 + 3 * Math.cos(a), y, -8 + 3 * Math.sin(a));
  for (let r = 0; r < 3; r += 0.2)
    for (let a = 0; a < 2 * Math.PI; a += 0.1) add(8 + r * Math.cos(a), 6, -8 + r * Math.sin(a));
  // box 4 x 2.5 x 3 at (-8, 8)
  const [bx, bz, sx, sy, sz] = [-8, 8, 4, 2.5, 3];
  for (let u = -sx / 2; u <= sx / 2; u += 0.12)
    for (let v = 0.1; v <= sy; v += 0.12) {
      add(bx + u, v, bz - sz / 2);
      add(bx + u, v, bz + sz / 2);
    }
  for (let w = -sz / 2; w <= sz / 2; w += 0.12)
    for (let v = 0.1; v <= sy; v += 0.12) {
      add(bx - sx / 2, v, bz + w);
      add(bx + sx / 2, v, bz + w);
    }
  for (let u = -sx / 2; u <= sx / 2; u += 0.12)
    for (let w = -sz / 2; w <= sz / 2; w += 0.12) add(bx + u, sy, bz + w);
  const count = pts.length / 3;
  const xyz = Buffer.alloc(count * 6);
  for (let i = 0; i < pts.length; i++) xyz.writeInt16LE(Math.round((pts[i] ?? 0) * 1000), i * 2);
  return { bin: Buffer.concat([xyz, Buffer.alloc(count, 128)]), count };
}

const open = new Set<ElectronApplication>();

async function start(data: DataRoot, env: Record<string, string> = {}) {
  const app = await launchApp(data, { STRATLAS_PIPELINE_PYTHON: venvPython, ...env });
  open.add(app);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  if (env.STRATLAS_AI_TEST_PROVIDER) {
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  }
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
  return { app, win, network };
}

async function openBuilder(win: Page) {
  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await palette.getByRole('combobox').fill('model builder');
  await palette.getByRole('option', { name: /Open the model builder/ }).click();
  const panel = win.getByTestId('model-builder');
  await expect(panel).toBeVisible();
  return panel;
}

async function importDxf(panel: ReturnType<Page['getByTestId']>, file: string, units = '') {
  await panel.getByRole('button', { name: 'Import drawing (DXF)' }).click();
  const form = panel.getByLabel('Import drawing');
  await form.getByLabel('DXF file').fill(file);
  if (units) await form.getByLabel('Drawing units').selectOption(units);
  await form.getByRole('button', { name: 'Import' }).click();
}

const manifestOf = async (data: DataRoot) =>
  JSON.parse(await readFile(join(data.projectDir, 'manifest.json'), 'utf8')) as ProjectManifest;

const parts = (panel: ReturnType<Page['getByTestId']>) =>
  panel.getByRole('listbox').getByRole('option');

test.describe('model builder', () => {
  test.skip(!hasPython, `no Python with aio_pipelines at ${venvPython}`);

  let data: DataRoot;
  test.beforeEach(async () => {
    data = await createDataRoot();
  });
  test.afterEach(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    open.clear();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('a DXF plot plan placed by two points, its parts drafted by the agent and by hand, built and picked', async () => {
    test.setTimeout(180_000);
    const plot = join(data.base, 'plot.dxf');
    const unitless = join(data.base, 'no-units.dxf');
    await writeFile(plot, dxf(PLOT, 6));
    await writeFile(unitless, dxf(PLOT, null));
    const { app, win, network } = await start(data, { STRATLAS_AI_TEST_PROVIDER: '1' });
    const panel = await openBuilder(win);
    const say = panel.getByTestId('model-builder-say');

    // a drawing without units is refused with the fix
    await importDxf(panel, unitless);
    await expect(say).toContainText('Set the drawing units', { timeout: 60_000 });
    await say.getByRole('button', { name: 'OK' }).click();

    // the plot plan comes in: a plan layer and its candidate parts
    await importDxf(panel, plot);
    await expect(say).toContainText('The drawing is imported', { timeout: 60_000 });
    expect((await manifestOf(data)).layers.map((l) => l.id)).toContain('plan-plot');

    // place it by two points: drawing (0, 0) and (100, 0) are at E 500100 and 500200, N 3200100
    await panel.getByRole('button', { name: 'Place by points' }).click();
    const place = panel.getByTestId('place-drawing');
    for (const [d, site] of [
      ['0 0', '500100 3200100'],
      ['100 0', '500200 3200100'],
    ] as const) {
      await place.getByLabel('Drawing point (x y)').fill(d);
      await place.getByLabel('Drawing point (x y)').press('Enter');
      await place.getByLabel('Site point (E N, or lat, lon)').fill(site);
      await place.getByLabel('Site point (E N, or lat, lon)').press('Enter');
    }
    await expect(place.locator('tbody tr')).toHaveCount(2);
    await place.getByRole('button', { name: 'Place the drawing' }).click();
    await expect(say).toContainText('The drawing is imported', { timeout: 60_000 });
    const placement = JSON.parse(
      await readFile(join(data.projectDir, 'drawings', 'plot', 'placement.json'), 'utf8'),
    ) as { matrix: number[]; provisional?: boolean };
    expect(placement.provisional).toBeFalsy();
    // drawing (20, 30) lies at local x 120, z -130
    const [a = 0, b = 0, c = 0, d = 0, tx = 0, tz = 0] = placement.matrix;
    expect(a * 20 + b * 30 + tx).toBeCloseTo(120, 1);
    expect(c * 20 + d * 30 + tz).toBeCloseTo(-130, 1);

    // the agent drafts T-102 from the drawing; it waits for approval and sends no drawing content
    const agent = win.getByRole('region', { name: 'Agent' });
    const box = agent.getByRole('textbox', { name: 'Message the agent' });
    await box.fill(
      'Make the tank T-102 from the drawing #tool propose_model_parts {"from":"drawing","tags":["T-102"]}',
    );
    await box.press('Enter');
    const preview = win.getByRole('dialog', { name: /Send to/ });
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Send' }).click();
    await expect(agent.locator('.step.awaiting')).toContainText('propose_model_parts');
    await expect(parts(panel)).toHaveCount(0);
    await agent.getByRole('button', { name: 'Approve' }).click();
    await expect(agent).toContainText('Tool propose_model_parts returned');
    const reply =
      (await agent.locator('text=Tool propose_model_parts returned').last().textContent()) ?? '';
    expect(reply).toContain('dxf-');
    expect(reply).not.toMatch(/radius|T-102|TANKS/);
    await expect(parts(panel)).toHaveCount(1);
    await expect(parts(panel).first()).toContainText('T-102');
    await expect(parts(panel).first()).toHaveAttribute('data-status', 'draft');

    // by hand: the rest of the drawing, with heights from the text
    await panel.getByRole('button', { name: 'From drawing' }).click();
    await expect(parts(panel)).toHaveCount(3);
    const t101 = parts(panel).filter({ hasText: 'T-101' });
    await expect(t101).toContainText('height 12.5 m');
    await panel.getByRole('button', { name: 'Accept all drafts' }).click();
    await expect(panel.locator('[data-status="accepted"]')).toHaveCount(3);
    await t101.click();
    const height = panel.getByLabel('Height (m)', { exact: true });
    await height.fill('14');
    await height.press('Enter');
    await expect(t101).toContainText('height 14.0 m');

    await panel.getByRole('button', { name: 'Build model' }).click();
    await expect(say).toContainText('The model is built', { timeout: 30_000 });
    const m = await manifestOf(data);
    const layer = m.layers.find((l) => l.id === 'model-site-model');
    expect(layer).toMatchObject({
      kind: 'mesh',
      derived: { kind: 'model', source: ['site-model'] },
      tags: expect.arrayContaining([{ node: 'T-101', tag: 'T-101', area: 'tank' }]),
    });
    expect(existsSync(join(data.projectDir, 'models', 'site-model.glb'))).toBe(true);

    // clicking the tank in the 3D view selects T-101
    await panel.getByRole('button', { name: 'Close' }).click();
    await win.evaluate(() => {
      (
        window as unknown as {
          __stratlas: { workspace: { getState(): { flyTo(t: unknown): void } } };
        }
      ).__stratlas.workspace
        .getState()
        .flyTo({ kind: 'point', p: [120, 7, -130], distance: 70, dir: [0, 1, 1] });
    });
    await win.waitForTimeout(2500);
    const at = await win.evaluate(() => {
      const stage = (
        window as unknown as {
          __stratlas: {
            stage(): {
              camera: {
                position: {
                  constructor: new (
                    x: number,
                    y: number,
                    z: number,
                  ) => { project(c: unknown): { x: number; y: number } };
                };
              };
              canvas: HTMLCanvasElement;
            } | null;
          };
        }
      ).__stratlas.stage();
      if (!stage) return null;
      const V = stage.camera.position.constructor;
      const v = new V(120, 7, -130).project(stage.camera);
      const r = stage.canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    });
    expect(at).not.toBeNull();
    if (at) await win.mouse.click(at.x, at.y);
    await expect
      .poll(() =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: { workspace: { getState(): { selection: unknown } } };
              }
            ).__stratlas.workspace.getState().selection,
        ),
      )
      .toMatchObject({ kind: 'asset', id: 'T-101' });

    expect(await network.outbound()).toEqual([]);
    await app.close();
    open.delete(app);
  });

  test('primitives fitted to a point cloud: draft parts with a fit quality, one rejected, built', async () => {
    test.setTimeout(180_000);
    const { bin, count } = scanCloud();
    await mkdir(join(data.projectDir, 'clouds'), { recursive: true });
    await writeFile(join(data.projectDir, 'clouds', 'scan.bin'), bin);
    const m = await manifestOf(data);
    await writeFile(
      join(data.projectDir, 'manifest.json'),
      JSON.stringify({
        ...m,
        layers: [
          ...m.layers,
          {
            kind: 'pointcloud',
            id: 'scan',
            name: 'Modelling scan',
            visible: true,
            src: { path: 'clouds/scan.bin' },
            format: 'kit-packed',
            pointCount: count,
          },
        ],
      }),
    );
    const { app, win, network } = await start(data);
    const panel = await openBuilder(win);
    await panel.getByRole('button', { name: 'From point cloud' }).click();
    const say = panel.getByTestId('model-builder-say');
    await expect(say).toContainText('draft parts fitted', { timeout: 120_000 });
    const tank = parts(panel).filter({ hasText: 'Cylinder' });
    const skid = parts(panel).filter({ hasText: 'Box' });
    await expect(tank).toHaveCount(1);
    await expect(tank).toContainText(/radius 3\.0 m/);
    await expect(tank).toContainText(/Fitted, \d\.\d cm off/);
    await expect(skid).toHaveCount(1);
    // reject the box with the keyboard, accept the rest
    await skid.click();
    await win.keyboard.press('r');
    await expect(skid).toHaveAttribute('data-status', 'rejected');
    await panel.getByRole('button', { name: 'Accept all drafts' }).click();
    await expect(tank).toHaveAttribute('data-status', 'accepted');
    await panel.getByRole('button', { name: 'Build model' }).click();
    await expect(say).toContainText('The model is built', { timeout: 30_000 });
    const built = (await manifestOf(data)).layers.find((l) => l.id === 'model-site-model');
    expect(built).toMatchObject({ kind: 'mesh', derived: { kind: 'model' } });
    expect(await network.outbound()).toEqual([]);
    await app.close();
    open.delete(app);
  });
});
