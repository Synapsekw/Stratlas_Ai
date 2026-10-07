/**
 * The Model builder (BLD-11, M8 stream C5) end to end on the change demo (C8, synthetic, no client
 * data): its plot plan (`sources/plot-plan.dxf`, the unitless and the broken variants), placed by
 * the control points of `truth.json` (`modelling.drawing.control`), the parts drafted from it, by
 * hand and by the scripted agent, built and picked; then primitives fitted to the demo's modelling
 * scan (`modelling.scan.layer`), one rejected, built. Numbers come from `truth.json`: exact where
 * the app is deterministic (a drawing), within the scan's noise where it fits. The real pipeline
 * pack runs in the development venv; the demo opens as a working copy, so the bundled demo is
 * never written. The zero-network guard of the fixture stays on.
 */
import type { ProcModel, ProcPart, ProjectManifest } from '@aio/schema';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';

type V2 = [number, number];
type V3 = [number, number, number];

/** `truth.json` `modelling`, as the change demo writes it (tools/demo/build-change-demo.mjs). */
type TruthPart = { tag: string; layer?: string } & (
  | { kind: 'cylinder'; base: V3; radius: number; height: number }
  | { kind: 'extrusion'; footprint: V2[]; baseY: number; height: number }
  | { kind: 'box'; centre: V3; size: V3; rotY: number }
  | { kind: 'pipe'; from: V3; to: V3; radius: number }
);
interface Modelling {
  drawing: {
    file: string;
    units: string;
    unitless: { file: string; units: string };
    broken: { file: string };
    control: { id: string; drawing: V2; local: V3; lonLat: V2 }[];
    parts: TruthPart[];
  };
  scan: { layer: string; noiseM: number; parts: TruthPart[]; counts: Record<string, number> };
}

interface Placement {
  units: string;
  unitM: number;
  matrix: [number, number, number, number, number, number];
  baseY: number;
  rmsM: number | null;
  provisional?: boolean;
}

interface Probe {
  __stratlas: {
    workspace: {
      getState(): { selection: unknown; flyTo(t: unknown): void };
    };
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

test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_AI_TEST_PROVIDER: '1' } });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const modelling = (truth: { modelling: unknown }) => truth.modelling as Modelling;
const json = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;
const parts = (panel: ReturnType<Page['getByTestId']>) =>
  panel.getByRole('listbox').getByRole('option');

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

/** Drawing (x, y) to local (x, z) through a placement matrix. */
const toLocal = (p: Placement, d: V2): V2 => {
  const [a, b, c, dd, tx, tz] = p.matrix;
  return [a * d[0] + b * d[1] + tx, c * d[0] + dd * d[1] + tz];
};

type Rect = [number, number, number, number];
const box2 = (pts: readonly V2[]): Rect => {
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
};

/** Where a fitted box or extrusion stands: [x0, z0, x1, z1] and its top height. */
function footprintOf(p: ProcPart): { rect: Rect; top: number } | null {
  if (p.kind === 'box') {
    const [cx, by, cz] = p.base;
    const [len, h, wid] = p.size;
    const turned = Math.abs(Math.cos(((p.yawDeg ?? 0) * Math.PI) / 180)) < 0.5;
    const [hx, hz] = turned ? [wid / 2, len / 2] : [len / 2, wid / 2];
    return { rect: [cx - hx, cz - hz, cx + hx, cz + hz], top: by + h };
  }
  if (p.kind === 'extrusion') return { rect: box2(p.footprint), top: p.baseY + p.height };
  return null;
}

test('the demo plot plan: units, a broken file, placed by control points, parts drafted, built and picked', async ({
  demoProject,
}) => {
  test.setTimeout(240_000);
  const { win, root, truth } = demoProject;
  const m = modelling(truth).drawing;
  const manifest = () => json<ProjectManifest>(join(root, 'manifest.json'));
  const panel = await openBuilder(win);
  const say = panel.getByTestId('model-builder-say');

  // a drawing without units is refused with the fix, then comes in with the units truth gives
  const unitless = join(root, m.unitless.file);
  await importDxf(panel, unitless);
  await expect(say).toHaveAttribute('role', 'alert', { timeout: 60_000 });
  await expect(say).toContainText('has no drawing units. Set the drawing units');
  await expect(say).toContainText('and import again.');
  await say.getByRole('button', { name: 'OK' }).click();
  await importDxf(panel, unitless, m.unitless.units);
  await expect(say).toContainText('The drawing is imported', { timeout: 60_000 });
  const mm = await json<Placement>(join(root, 'drawings', 'plot-plan-unitless', 'placement.json'));
  expect(mm).toMatchObject({ units: 'mm', unitM: 0.001, provisional: true });
  // the same tank in millimetres is the same tank in metres
  const t201 = m.parts.find((p) => p.tag === 'T-201');
  const mmParts = await json<ProcModel>(
    join(root, 'drawings', 'plot-plan-unitless', 'parts.procmodel.json'),
  );
  const mmTank = mmParts.parts.find((p) => p.tag === 'T-201');
  expect(mmTank?.kind === 'cylinder' && mmTank.radius).toBe(
    t201?.kind === 'cylinder' && t201.radius,
  );
  await say.getByRole('button', { name: 'OK' }).click();

  // a broken file: a clear error, the app stays up and imports the next file
  await importDxf(panel, join(root, m.broken.file));
  await expect(say).toHaveAttribute('role', 'alert', { timeout: 60_000 });
  await expect(say).toContainText('"plot-plan-broken.dxf" line');
  await expect(say).toContainText('The file is damaged or not a DXF');
  await say.getByRole('button', { name: 'OK' }).click();
  await expect(panel).toBeVisible();
  expect((await manifest()).layers.some((l) => l.id === 'plan-plot-plan-broken')).toBe(false);

  // the plot plan in metres: a plan layer and its candidate parts
  expect(existsSync(join(root, m.file))).toBe(true);
  await importDxf(panel, join(root, m.file));
  await expect(say).toContainText('The drawing is imported', { timeout: 60_000 });
  expect((await manifest()).layers.map((l) => l.id)).toContain('plan-plot-plan');
  await panel.getByLabel('Drawing', { exact: true }).selectOption('plot-plan');

  // the Model builder passes an accessibility audit with its import form open
  await panel.getByRole('button', { name: 'Import drawing (DXF)' }).click();
  await expectAccessible(win, 'Model builder, import', {
    include: '[data-testid="model-builder"]',
  });
  await panel.getByLabel('Import drawing').getByRole('button', { name: 'Cancel' }).click();

  // place it by two of the control points: CP1 typed as easting northing, CP3 as lat, lon
  const { origin } = await manifest();
  const cp = (id: string) => {
    const c = m.control.find((x) => x.id === id);
    if (!c) throw new Error(`truth.json has no control point ${id}`);
    return c;
  };
  const [cp1, cp3] = [cp('CP1'), cp('CP3')];
  await panel.getByRole('button', { name: 'Place by points' }).click();
  const place = panel.getByTestId('place-drawing');
  await expect(place.getByRole('button', { name: 'Pick on the plan' })).toBeEnabled();
  for (const [d, site] of [
    [
      cp1.drawing.join(' '),
      `${String(origin[0] + cp1.local[0])} ${String(origin[1] - cp1.local[2])}`,
    ],
    [cp3.drawing.join(' '), `${String(cp3.lonLat[1])}, ${String(cp3.lonLat[0])}`],
  ] as const) {
    await place.getByLabel('Drawing point (x y)').fill(d);
    await place.getByLabel('Drawing point (x y)').press('Enter');
    await place.getByLabel('Site point (E N, or lat, lon)').fill(site);
    await place.getByLabel('Site point (E N, or lat, lon)').press('Enter');
  }
  await expect(place.locator('tbody tr')).toHaveCount(2);
  await expectAccessible(win, 'Model builder, place by points', {
    include: '[data-testid="model-builder"]',
  });
  await place.getByRole('button', { name: 'Place the drawing' }).click();
  await expect(say).toContainText('The drawing is imported', { timeout: 60_000 });
  const placement = await json<Placement>(join(root, 'drawings', 'plot-plan', 'placement.json'));
  expect(placement).toMatchObject({ units: m.units, unitM: 1, baseY: 0 });
  expect(placement.provisional).toBeFalsy();
  // all four control points land where truth says, the two not used as well (within 1 cm)
  for (const c of m.control) {
    const [x, z] = toLocal(placement, c.drawing);
    expect(Math.hypot(x - c.local[0], z - c.local[2]), c.id).toBeLessThan(0.01);
  }

  // the agent drafts T-202 from the drawing; it waits for approval and sends no drawing content
  // (cloud AI on from the command search: the scripted test provider stands in for the cloud)
  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await palette.getByRole('combobox').fill('cloud AI');
  await palette.getByRole('option', { name: /Turn cloud AI on/ }).click();
  const agent = win.getByRole('region', { name: 'Agent' });
  const message = agent.getByRole('textbox', { name: 'Message the agent' });
  // the open panel checks its route again by itself when the AI settings change: no Check again
  await expect(message).toBeEnabled({ timeout: 15_000 });
  await expect(agent.getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await message.fill(
    'Make the tank T-202 from the drawing #tool propose_model_parts {"from":"drawing","drawing":"plot-plan","tags":["T-202"]}',
  );
  await message.press('Enter');
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
  expect(reply).not.toMatch(/radius|T-202|TANKS/);
  await expect(parts(panel)).toHaveCount(1);
  await expect(parts(panel).first()).toContainText('T-202');
  await expect(parts(panel).first()).toHaveAttribute('data-status', 'draft');

  // by hand: the rest of the drawing, every part truth lists, with its tag, kind and size
  await panel.getByRole('button', { name: 'From drawing' }).click();
  await expect(parts(panel)).toHaveCount(m.parts.length);
  const model = join(root, 'models', 'site-model.procmodel.json');
  const drafted = (await json<ProcModel>(model)).parts;
  const kinds = (list: readonly { kind: string }[]) => {
    const out: Record<string, number> = {};
    for (const p of list) out[p.kind] = (out[p.kind] ?? 0) + 1;
    return out;
  };
  // 3 cylinders, 2 extrusions, 2 boxes, 1 pipe
  expect(kinds(drafted)).toEqual(kinds(m.parts));
  for (const want of m.parts) {
    const got = drafted.find((p) => p.tag === want.tag);
    expect(got?.kind, want.tag).toBe(want.kind);
    if (!got) continue;
    if (want.kind === 'cylinder' && got.kind === 'cylinder') {
      expect(got.base, want.tag).toEqual(want.base);
      expect([got.radius, got.height], want.tag).toEqual([want.radius, want.height]);
    } else if (want.kind === 'extrusion' && got.kind === 'extrusion') {
      expect(box2(got.footprint as V2[]), want.tag).toEqual(box2(want.footprint));
      expect([got.baseY, got.height], want.tag).toEqual([want.baseY, want.height]);
    } else if (want.kind === 'box' && got.kind === 'box') {
      expect(got.base, want.tag).toEqual([want.centre[0], 0, want.centre[2]]);
      expect(got.size, want.tag).toEqual(want.size);
      expect(got.yawDeg, want.tag).toBe(want.rotY);
    } else if (want.kind === 'pipe' && got.kind === 'pipe') {
      expect(got.points, want.tag).toEqual([want.from, want.to]);
      // the plan states no pipe size (its label is "P-01 EL 1.5"): the draft takes the
      // default 300 mm, not the 600 mm of truth's radius 0.3 m; the person sets it
    }
  }
  const tank = parts(panel).filter({ hasText: 'T-201' });
  await expect(tank).toContainText(
    `height ${t201?.kind === 'cylinder' ? t201.height.toFixed(1) : ''} m`,
  );
  await panel.getByRole('button', { name: 'Accept all drafts' }).click();
  await expect(panel.locator('[data-status="accepted"]')).toHaveCount(m.parts.length);
  await tank.click();
  const height = panel.getByLabel('Height (m)', { exact: true });
  await height.fill('14');
  await height.press('Enter');
  await expect(tank).toContainText('height 14.0 m');
  await expectAccessible(win, 'Model builder, parts', { include: '[data-testid="model-builder"]' });

  await panel.getByRole('button', { name: 'Build model' }).click();
  await expect(say).toContainText('The model is built', { timeout: 60_000 });
  const layer = (await manifest()).layers.find((l) => l.id === 'model-site-model');
  expect(layer).toMatchObject({
    kind: 'mesh',
    derived: { kind: 'model', source: ['site-model'] },
    tags: expect.arrayContaining(
      m.parts.map((p) => expect.objectContaining({ node: p.tag, tag: p.tag })),
    ),
  });
  expect(existsSync(join(root, 'models', 'site-model.glb'))).toBe(true);

  // clicking the built T-201 above the demo's own tank (9 m, now 14 m) selects T-201
  await panel.getByRole('button', { name: 'Close' }).click();
  const [bx, , bz] = t201?.kind === 'cylinder' ? t201.base : [0, 0, 0];
  const at: V3 = [bx, 12, bz];
  await win.evaluate((p) => {
    (window as unknown as Probe).__stratlas.workspace
      .getState()
      .flyTo({ kind: 'point', p, distance: 70, dir: [0, 1, 1] });
  }, at);
  await win.waitForTimeout(2500);
  const screen = await win.evaluate((p) => {
    const stage = (window as unknown as Probe).__stratlas.stage();
    if (!stage) return null;
    const V = stage.camera.position.constructor;
    const v = new V(p[0], p[1], p[2]).project(stage.camera);
    const r = stage.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, at);
  expect(screen).not.toBeNull();
  if (screen) await win.mouse.click(screen.x, screen.y);
  await expect
    .poll(() =>
      win.evaluate(() => (window as unknown as Probe).__stratlas.workspace.getState().selection),
    )
    .toMatchObject({ kind: 'asset', id: 'T-201' });
});

test('primitives fitted to the demo scan where truth puts them, one rejected, built', async ({
  demoProject,
}) => {
  test.setTimeout(240_000);
  const { win, root, truth } = demoProject;
  const scan = modelling(truth).scan;
  const tol = 3 * scan.noiseM;
  const panel = await openBuilder(win);
  const say = panel.getByTestId('model-builder-say');
  await panel.getByLabel('Point cloud').selectOption(scan.layer);
  await panel.getByRole('button', { name: 'From point cloud' }).click();
  await expect(say).toContainText('draft parts fitted', { timeout: 120_000 });
  const fitted = (await json<ProcModel>(join(root, 'models', 'site-model.procmodel.json'))).parts;
  await expect(parts(panel)).toHaveCount(fitted.length);
  expect(fitted.every((p) => p.origin.by === 'fit' && p.status === 'draft')).toBe(true);

  const used = new Set<string>();
  const take = (p: ProcPart | undefined, tag: string) => {
    expect(p, `a fitted part for ${tag}`).toBeDefined();
    if (p) used.add(p.id);
    return p;
  };
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  for (const want of scan.parts) {
    if (want.kind === 'cylinder') {
      // the tanks: centre and radius within three times the scan noise
      const got = take(
        fitted.find(
          (p) =>
            p.kind === 'cylinder' &&
            Math.hypot(p.base[0] - want.base[0], p.base[2] - want.base[2]) <= tol,
        ),
        want.tag,
      );
      expect(got?.kind === 'cylinder' && near(got.radius, want.radius), want.tag).toBe(true);
    } else if (want.kind === 'box' || want.kind === 'extrusion') {
      // boxes and buildings: the footprint's sides and the top within three times the noise.
      // B-01 (truth: an extrusion) comes back as a box: C5 fits a rectangle as a box
      // (model.fit_cloud, "a rectangle is a box, not a four-corner extrusion").
      const rect: Rect =
        want.kind === 'box'
          ? [
              want.centre[0] - want.size[0] / 2,
              want.centre[2] - want.size[2] / 2,
              want.centre[0] + want.size[0] / 2,
              want.centre[2] + want.size[2] / 2,
            ]
          : box2(want.footprint);
      const top = want.kind === 'box' ? want.size[1] : want.baseY + want.height;
      const got = take(
        fitted.find((p) => {
          const f = footprintOf(p);
          return !!f && f.rect.every((v, i) => near(v, rect[i] ?? Number.NaN)) && near(f.top, top);
        }),
        want.tag,
      );
      expect(got?.kind, want.tag).toBe('box');
    } else {
      // P-01 runs on seven concrete supports: the fit takes pipe and supports for two long
      // boxes, no pipe (reported to the lead); together they cover truth's run at its height
      const run = fitted.flatMap((p) => {
        const f = footprintOf(p);
        const cx = f ? (f.rect[0] + f.rect[2]) / 2 : NaN;
        return f &&
          !used.has(p.id) &&
          near((f.rect[1] + f.rect[3]) / 2, want.from[2]) &&
          cx > want.from[0] &&
          cx < want.to[0] &&
          near(f.top, want.from[1] + want.radius)
          ? [{ p, f }]
          : [];
      });
      expect(run.map((r) => r.p.kind)).toEqual(['box', 'box']);
      expect(Math.min(...run.map((r) => r.f.rect[0]))).toBeLessThanOrEqual(want.from[0] + tol);
      expect(Math.max(...run.map((r) => r.f.rect[2]))).toBeGreaterThanOrEqual(want.to[0] - tol);
      for (const r of run) used.add(r.p.id);
    }
  }
  // nothing else: 3 tanks, 3 boxes, B-01 and the P-01 run
  expect(used.size).toBe(fitted.length);
  expect(fitted.filter((p) => p.kind === 'cylinder')).toHaveLength(scan.counts.cylinder ?? 0);

  // every part shows its fit quality; reject one of the pipe run's boxes with the keyboard
  const tanks = parts(panel).filter({ hasText: 'Cylinder' });
  await expect(tanks).toHaveCount(scan.counts.cylinder ?? 0);
  await expect(tanks.first()).toContainText(/Fitted, \d\.\d cm off/);
  const worst = [...fitted].sort(
    (a, b) =>
      (b.origin.by === 'fit' ? b.origin.residualM : 0) -
      (a.origin.by === 'fit' ? a.origin.residualM : 0),
  )[0];
  const reject = panel.locator(`[data-part="${worst?.id ?? ''}"]`);
  await reject.click();
  await win.keyboard.press('r');
  await expect(reject).toHaveAttribute('data-status', 'rejected');
  await panel.getByRole('button', { name: 'Accept all drafts' }).click();
  await expect(panel.locator('[data-status="accepted"]')).toHaveCount(fitted.length - 1);
  await expectAccessible(win, 'Model builder, fitted parts', {
    include: '[data-testid="model-builder"]',
  });
  await panel.getByRole('button', { name: 'Build model' }).click();
  await expect(say).toContainText('The model is built', { timeout: 60_000 });
  const built = (await json<ProjectManifest>(join(root, 'manifest.json'))).layers.find(
    (l) => l.id === 'model-site-model',
  );
  expect(built).toMatchObject({ kind: 'mesh', derived: { kind: 'model' } });
});
