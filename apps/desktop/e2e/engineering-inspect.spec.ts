/**
 * Engineering model inspection and Place model end to end (acceptance E), on synthetic data only:
 * the chimney of `@aio/modelling`'s `stackModel` written as an engineering GLB into a project of
 * its own. Hover shows the brief; a click selects and highlights the whole component (all its
 * materials) and no other; Focus frames it; Escape and a background click clear; an orbit drag
 * selects nothing; a hidden component is not hit, the one behind it is; the component list
 * selects; ids and descriptions survive a GLB import and a `.aio` package. Place model puts the
 * tiny project's quad at a typed E N, drags the move handle in the real WebGL view, turns it,
 * saves, reopens and undoes.
 */
import { buildEngineeringGlb, stackModel } from '@aio/modelling';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

type V3 = [number, number, number];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PROJECT = { id: 'e2e-eng', name: 'E2E engineering stack' };
const ORIGIN: V3 = [500000, 3200000, 0];

interface Vec {
  x: number;
  y: number;
  z: number;
  distanceTo(v: Vec): number;
  project(c: unknown): Vec;
}
interface Box {
  min: Vec;
  max: Vec;
  clone(): Box;
  applyMatrix4(m: unknown): Box;
}
interface Obj {
  name: string;
  isMesh?: boolean;
  matrixWorld: unknown;
  geometry: { uuid: string; boundingBox: Box | null; computeBoundingBox(): void };
  material: { type: string; name: string; emissiveIntensity?: number };
  children: Obj[];
  getObjectByName(n: string): Obj | undefined;
  traverse(cb: (o: Obj) => void): void;
}
interface StageProbe {
  camera: { position: Vec & { constructor: new (x: number, y: number, z: number) => Vec } };
  canvas: HTMLCanvasElement;
  scene: Obj;
  components(layerId: string): { id: string; name: string; description?: string }[];
  hiddenNodes(layerId: string): string[];
  pickAt(x: number, y: number): { node: string } | null;
}
interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        selection: { kind: string; id: string; layer?: string } | null;
        flyTo(t: unknown): void;
        project: {
          id: string;
          manifest: { layers: { id: string; kind: string; transform?: number[] }[] };
        } | null;
      };
    };
    stage(): StageProbe | null;
  };
}

/** `projects/e2e-eng/` with the synthetic chimney as an engineering GLB at the origin. */
async function writeEngineeringProject(dataRoot: DataRoot): Promise<string> {
  const dir = join(dataRoot.root, 'projects', PROJECT.id);
  await mkdir(join(dir, 'models'), { recursive: true });
  const { glb } = buildEngineeringGlb(stackModel(), {
    detail: 'fast',
    drafts: true,
    generator: 'e2e',
  });
  await writeFile(join(dir, 'models', 'stack.glb'), glb);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: PROJECT.id,
    name: PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: ORIGIN,
    captures: [{ id: 'capture-1', label: 'Synthetic capture', date: '2026-01-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'stack',
        name: 'Synthetic chimney',
        src: { path: 'models/stack.glb' },
        transform: IDENTITY,
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return join(dir, 'models', 'stack.glb');
}

const engTest = test.extend<{ engGlb: string }>({
  engGlb: async ({ dataRoot }, use) => {
    await use(await writeEngineeringProject(dataRoot));
  },
});

/**
 * The centre of a component's meshes in the 3D view (local frame), by node name; with `belowTop`
 * that far under its top instead (a flue shows only above the windshield).
 */
async function nodeCentre(win: Page, name: string, belowTop?: number): Promise<V3> {
  const c = await win.evaluate(
    ([n, below]) => {
      const st = (window as unknown as Probe).__stratlas.stage();
      const node = st?.scene.getObjectByName('layer:stack')?.getObjectByName(n);
      if (!node) return null;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      node.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox?.clone().applyMatrix4(o.matrixWorld);
        if (!b) return;
        const mins = [b.min.x, b.min.y, b.min.z];
        const maxs = [b.max.x, b.max.y, b.max.z];
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k] ?? Infinity, mins[k] ?? Infinity);
          hi[k] = Math.max(hi[k] ?? -Infinity, maxs[k] ?? -Infinity);
        }
      });
      const mid = lo.map((v, k) => (v + (hi[k] ?? v)) / 2);
      if (below !== null) mid[1] = (hi[1] ?? 0) - below;
      return mid;
    },
    [name, belowTop ?? null] as const,
  );
  if (!c || c.some((v) => !Number.isFinite(v))) throw new Error(`no ${name} in the 3D view`);
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

async function openByName(win: Page, name: string, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as Probe).__stratlas.workspace.getState().project?.id ?? null,
        ),
      { timeout: 60_000 },
    )
    .toBe(id);
}

const selection = (win: Page) =>
  win.evaluate(() => (window as unknown as Probe).__stratlas.workspace.getState().selection);

/** Fly the camera to look at `p` from `dir`, `distance` away, and let it settle. */
async function look(win: Page, p: V3, distance: number, dir: V3) {
  await win.evaluate(
    ([at, d, from]) => {
      (window as unknown as Probe).__stratlas.workspace
        .getState()
        .flyTo({ kind: 'point', p: at, distance: d, dir: from });
    },
    [p, distance, dir] as const,
  );
  await win.waitForTimeout(2500);
}

/** A world point (local frame) on screen, in client pixels, with its normalised device point. */
async function screenOf(win: Page, p: V3) {
  const s = await win.evaluate((at) => {
    const st = (window as unknown as Probe).__stratlas.stage();
    if (!st) return null;
    const V = st.camera.position.constructor;
    const v = new V(at[0], at[1], at[2]).project(st.camera);
    const r = st.canvas.getBoundingClientRect();
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
      ndc: [v.x, v.y] as [number, number],
    };
  }, p);
  if (!s) throw new Error('no 3D view');
  return s;
}

const pickAt = (win: Page, ndc: [number, number]) =>
  win.evaluate(
    ([x, y]) => (window as unknown as Probe).__stratlas.stage()?.pickAt(x, y)?.node ?? null,
    ndc,
  );

engTest(
  'engineering components: brief, select, highlight, focus, clear, hide, list',
  async ({ engGlb, win }) => {
    test.setTimeout(180_000);
    expect(engGlb).toContain('stack.glb');
    await openByName(win, PROJECT.name, PROJECT.id);
    await expect
      .poll(
        () =>
          win.evaluate(
            () =>
              (window as unknown as Probe).__stratlas
                .stage()
                ?.components('stack')
                .map((c) => c.id) ?? [],
          ),
        { timeout: 60_000 },
      )
      .toContain('flue-2');

    // flue-2 seen from the east: flue-4 stands behind it on the same line
    // the flues stand 1 m proud of the windshield: aim at that part, from the east and above
    const flue = await nodeCentre(win, 'flue-2', 0.4);
    await look(win, flue, 30, [1, 0.35, 0]);
    const at = await screenOf(win, flue);
    expect(await pickAt(win, at.ndc)).toBe('flue-2');

    // hover: the brief names it and says how to select
    await win.mouse.move(at.x - 20, at.y - 20);
    await win.mouse.move(at.x, at.y, { steps: 5 });
    const brief = win.getByTestId('component-brief');
    await expect(brief).toContainText('flue 2');
    await expect(brief).toContainText('Click to select');

    // click selects the component by its id
    await win.mouse.click(at.x, at.y);
    await expect.poll(() => selection(win)).toMatchObject({ kind: 'asset', id: 'flue-2' });
    await expect(win.getByTestId('component-card')).toContainText('flue 2');

    // Focus component frames it: the camera comes closer
    await look(win, flue, 120, [1, 0.4, 0.4]);
    const dist = () =>
      win.evaluate((p) => {
        const st = (window as unknown as Probe).__stratlas.stage();
        if (!st) return Infinity;
        const V = st.camera.position.constructor;
        return st.camera.position.distanceTo(new V(p[0], p[1], p[2]));
      }, flue);
    const far = await dist();
    await win.getByTestId('component-focus').click();
    await expect.poll(dist, { timeout: 10_000 }).toBeLessThan(far * 0.6);

    // Escape clears; a background click clears
    await look(win, flue, 30, [1, 0.35, 0]);
    await win.mouse.click(at.x, at.y);
    await expect.poll(() => selection(win)).toMatchObject({ id: 'flue-2' });
    await win.keyboard.press('Escape');
    await expect.poll(() => selection(win)).toBeNull();
    await win.mouse.click(at.x, at.y);
    await expect.poll(() => selection(win)).toMatchObject({ id: 'flue-2' });
    const box = await win.locator('[data-scene-view] canvas').first().boundingBox();
    if (!box) throw new Error('no canvas');
    // the sky beside the chimney
    await win.mouse.click(box.x + 15, box.y + box.height / 2);
    await expect.poll(() => selection(win)).toBeNull();

    // an orbit drag across the flue selects nothing
    await win.mouse.move(at.x, at.y);
    await win.mouse.down();
    await win.mouse.move(at.x + 60, at.y, { steps: 8 });
    await win.mouse.up();
    await win.waitForTimeout(300);
    expect(await selection(win)).toBeNull();

    // hide flue-2 from the component list: a click there hits what stands behind it
    await look(win, flue, 30, [1, 0.35, 0]);
    await win.mouse.click(at.x, at.y);
    await expect.poll(() => selection(win)).toMatchObject({ id: 'flue-2' });
    const list = win.getByTestId('component-list');
    await list.getByTestId('component-search').fill('flue 2');
    await list.locator('[data-testid="component-row"][data-id="flue-2"] .cl-eye').click();
    await expect
      .poll(() =>
        win.evaluate(() => (window as unknown as Probe).__stratlas.stage()?.hiddenNodes('stack')),
      )
      .toEqual(['flue-2']);
    await expect(win.getByTestId('component-card')).toContainText('Hidden in the 3D view');
    await win.keyboard.press('Escape');
    await win.mouse.click(at.x, at.y);
    await win.waitForTimeout(300);
    expect((await selection(win))?.id ?? null).not.toBe('flue-2');
    expect(await pickAt(win, at.ndc)).not.toBe('flue-2');

    // a warning light is several meshes (bracket, housing, lens): all tinted, its twin is not
    const centre = await nodeCentre(win, 'light-l1-1');
    await look(win, centre, 6, [0, 0.1, -1]);
    const lamp = await screenOf(win, centre);
    expect(await pickAt(win, lamp.ndc)).toBe('light-l1-1');
    await win.mouse.click(lamp.x, lamp.y);
    await expect.poll(() => selection(win)).toMatchObject({ id: 'light-l1-1' });
    const tint = await win.evaluate(() => {
      const st = (window as unknown as Probe).__stratlas.stage();
      const layer = st?.scene.getObjectByName('layer:stack');
      const hl = st?.scene.getObjectByName('engine:highlight');
      const meshes = (n: Obj | undefined) => {
        const out: Obj[] = [];
        n?.traverse((o) => {
          if (o.isMesh) out.push(o);
        });
        return out;
      };
      const mine = meshes(layer?.getObjectByName('light-l1-1'));
      const twin = meshes(layer?.getObjectByName('light-l1-2'));
      const tinted = new Set(
        (hl?.children ?? [])
          .filter((c) => c.material.type !== 'ShaderMaterial')
          .map((c) => c.geometry.uuid),
      );
      return {
        meshes: mine.length,
        materials: new Set(mine.map((m) => m.material.name)).size,
        allTinted: mine.every((m) => tinted.has(m.geometry.uuid)),
        twinTinted: twin.some((m) => tinted.has(m.geometry.uuid)),
        twinEmissive: twin.map((m) => m.material.emissiveIntensity ?? 0),
      };
    });
    expect(tint.meshes).toBeGreaterThanOrEqual(3);
    expect(tint.materials).toBeGreaterThanOrEqual(3);
    expect(tint.allTinted).toBe(true);
    expect(tint.twinTinted).toBe(false);

    // the list selects too (a click or a tap on its row)
    await list.getByTestId('component-search').fill('');
    await list.locator('[data-testid="component-row"][data-id="light-l1-2"] .cl-name').click();
    await expect.poll(() => selection(win)).toMatchObject({ kind: 'asset', id: 'light-l1-2' });
    // selecting it did not change how its materials are drawn in the scene
    const after = await win.evaluate(() => {
      const st = (window as unknown as Probe).__stratlas.stage();
      const out: number[] = [];
      st?.scene
        .getObjectByName('layer:stack')
        ?.getObjectByName('light-l1-2')
        ?.traverse((o) => {
          if (o.isMesh) out.push(o.material.emissiveIntensity ?? 0);
        });
      return out;
    });
    expect(after).toEqual(tint.twinEmissive);
  },
);

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

const componentsOf = (win: Page, layer: string) =>
  win.evaluate(
    (id) =>
      (window as unknown as Probe).__stratlas
        .stage()
        ?.components(id)
        .map((c) => ({ id: c.id, description: c.description ?? '' })) ?? [],
    layer,
  );

engTest(
  'component ids and descriptions survive a GLB import and a .aio package',
  async ({ engGlb, app, win, dataRoot }) => {
    test.setTimeout(300_000);
    await openByName(win, PROJECT.name, PROJECT.id);
    const want = stackModel()
      .assemblies.map((a) => ({ id: a.id, description: a.description }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const sorted = (l: { id: string; description: string }[]) =>
      [...l].sort((a, b) => a.id.localeCompare(b.id));
    await expect
      .poll(async () => sorted(await componentsOf(win, 'stack')), { timeout: 60_000 })
      .toEqual(want);

    // the same GLB imported again as a new layer
    const copy = join(dataRoot.base, 'stack-again.glb');
    await writeFile(copy, await readFile(engGlb));
    await nextOpenDialog(app, [copy]);
    await win.keyboard.press('Control+K');
    await win.keyboard.type('Import raw data');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('import-panel')).toContainText('Imported 1 of 1 files', {
      timeout: 60_000,
    });
    const added = await win.evaluate(
      () =>
        (window as unknown as Probe).__stratlas.workspace
          .getState()
          .project?.manifest.layers.find((l) => l.kind === 'mesh' && l.id !== 'stack')?.id ?? '',
    );
    expect(added).not.toBe('');
    await expect
      .poll(async () => sorted(await componentsOf(win, added)), { timeout: 60_000 })
      .toEqual(want);

    // exported as a .aio package and opened as a customer would (read-only, its own data folder)
    const file = join(dataRoot.base, 'stack.aio');
    await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
    await win.getByTestId('export-package').click();
    const dialog = win.getByTestId('package-export');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('pkg-size')).not.toContainText('...');
    await app.evaluate(({ dialog: d }, target) => {
      d.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
    }, file);
    await dialog.getByTestId('pkg-export').click();
    await expect(dialog.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });

    const customer: DataRoot = {
      base: dataRoot.base,
      root: join(dataRoot.base, 'customer-data'),
      userData: join(dataRoot.base, 'customer-user'),
      projectId: '',
      projectDir: '',
    };
    await mkdir(customer.root, { recursive: true });
    const network = new NetworkGuard();
    const c = await launchApp(customer, {}, [file]);
    await network.attach(c);
    try {
      const cw = await c.firstWindow();
      await cw.waitForLoadState('domcontentloaded');
      await expect(cw.getByTestId('readonly-chip')).toBeVisible({ timeout: 60_000 });
      await cw.locator('.nav-item', { hasText: 'Scene' }).first().click();
      await expect
        .poll(async () => sorted(await componentsOf(cw, 'stack')), { timeout: 60_000 })
        .toEqual(want);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await c.close();
    }
  },
);

// ---------------------------------------------------------------- Place model

interface Saved {
  layers: { id: string; transform: number[] }[];
}
const quadTransform = async (dataRoot: DataRoot) =>
  (
    JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as Saved
  ).layers.find((l) => l.id === 'quad')?.transform ?? [];

/** Heading of a Y-up layer transform, degrees clockwise from north (model +X towards south). */
const headingOf = (t: number[]) => (Math.atan2(t[2] ?? 0, t[0] ?? 1) * 180) / Math.PI;

/** The origin's E N H as the Place model panel shows it. */
async function shownPosition(win: Page): Promise<V3> {
  const text = await win.getByTestId('place-position').innerText();
  const m = /E (-?[\d.]+) N (-?[\d.]+) H (-?[\d.]+)/.exec(text);
  if (!m) throw new Error(`no position in "${text}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function openPlaceModel(win: Page) {
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Place model');
  await win.getByRole('option', { name: /Place model: move, turn, tilt and scale/ }).click();
  const panel = win.getByTestId('place-model');
  await expect(panel).toBeVisible();
  return panel;
}

engTest(
  'Place model: typed E N, a drag on the move handle, a turn, saved, reopened, undone',
  async ({ engGlb, win, dataRoot }) => {
    expect(engGlb).toContain('stack.glb');
    test.setTimeout(180_000);
    await openByName(win, 'E2E tiny project', 'e2e-tiny');
    const panel = await openPlaceModel(win);

    // a typed position in the project CRS
    await panel.getByTestId('place-typed').fill('500010 3200020 0');
    await panel.getByTestId('place-typed').press('Enter');
    await expect(panel.getByTestId('place-position')).toContainText(
      'E 500010.00 N 3200020.00 H 0.00',
    );

    // lifted 5 m, then dropped: the quad's underside lands on the ground again
    await panel.getByTestId('place-up').fill('5');
    await panel.getByTestId('place-up').press('Enter');
    await expect(panel.getByTestId('place-position')).toContainText('H 5.00');
    await panel.getByTestId('place-drop').click();
    await expect(panel.getByTestId('place-position')).toContainText('H 0.00');

    // drag the move handle's centre in the real 3D view
    const anchor: V3 = [10, 0, -20];
    await look(win, anchor, 12, [0.3, 1, 0.6]);
    const at = await screenOf(win, anchor);
    await win.mouse.move(at.x, at.y);
    await win.mouse.down();
    await win.mouse.move(at.x + 80, at.y + 10, { steps: 12 });
    await win.mouse.up();
    const dragged = await shownPosition(win);
    expect(Math.hypot(dragged[0] - 500010, dragged[1] - 3200020)).toBeGreaterThan(0.5);
    // the drag was not a click on the model
    expect(await selection(win)).toBeNull();

    // turn it to 30 degrees and save
    await panel.getByTestId('place-heading').fill('30');
    await panel.getByTestId('place-heading').press('Enter');
    await panel.getByTestId('place-done').click();
    await expect(panel.getByTestId('place-say')).toContainText('Placed and saved');
    const saved = await quadTransform(dataRoot);
    expect(headingOf(saved)).toBeCloseTo(30, 2);
    expect(ORIGIN[0] + (saved[12] ?? 0)).toBeCloseTo(dragged[0], 2);
    expect(ORIGIN[1] - (saved[14] ?? 0)).toBeCloseTo(dragged[1], 2);

    // the project opened again (another one in between, so it is read from disk) has it there
    await panel.getByRole('button', { name: 'Close' }).click();
    await openByName(win, PROJECT.name, PROJECT.id);
    await openByName(win, 'E2E tiny project', 'e2e-tiny');
    const reopened = await win.evaluate(
      () =>
        (window as unknown as Probe).__stratlas.workspace
          .getState()
          .project?.manifest.layers.find((l) => l.id === 'quad')?.transform ?? [],
    );
    reopened.forEach((v, i) => {
      expect(v).toBeCloseTo(saved[i] ?? NaN, 9);
    });

    // a second placement, saved, then undone: the first one is back
    const again = await openPlaceModel(win);
    await again.getByTestId('place-heading').fill('60');
    await again.getByTestId('place-heading').press('Enter');
    await again.getByTestId('place-done').click();
    await expect(again.getByTestId('place-say')).toContainText('Placed and saved');
    expect(headingOf(await quadTransform(dataRoot))).toBeCloseTo(60, 2);
    await again.getByTestId('place-undo').click();
    await expect
      .poll(async () => headingOf(await quadTransform(dataRoot)), { timeout: 15_000 })
      .toBeCloseTo(30, 2);
    const undone = await quadTransform(dataRoot);
    undone.forEach((v, i) => {
      expect(v).toBeCloseTo(saved[i] ?? NaN, 9);
    });
  },
);
