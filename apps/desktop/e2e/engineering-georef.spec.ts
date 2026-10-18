/**
 * Acceptance F in the running app, on synthetic data only (the chimney of `@aio/modelling`'s
 * `stackModel`, made-up coordinates): an engineering model placed in project A (turned 30 degrees
 * and moved) is exported as a bundle over IPC, and its GLB imported through Import raw data into
 * project B (another origin, same UTM zone) and project C (the next UTM zone). Every probe vertex,
 * read from the exported file, lands within 1 mm of where A put it, checked in the workspace
 * manifest and in the scene the app draws. The truth is written out by hand from A's transform.
 * A plain GLB keeps the identity and no placement; a GLB whose coordinate system the app cannot
 * read asks for Place model. A `.aio` package of a placed model opens with its placement.
 */
import { fromWgs84, georefToLayerTransform, toWgs84, worldOfModelPoint } from '@aio/geo';
import { buildEngineeringGlb, readGlb, stackModel } from '@aio/modelling';
import {
  ProjectManifest,
  SCHEMA_VERSION,
  type Georef,
  type Layer,
  type ProcModel,
  type ProjectManifestInput,
} from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test, tinyGlb, type DataRoot } from './fixtures';

type V3 = [number, number, number];
type Mat4 = number[];
type MeshLayer = Extract<Layer, { kind: 'mesh' }>;

const rad = Math.PI / 180;
/** Project A: zone 39N, synthetic origin. */
const A = {
  id: 'e2e-geo-a',
  name: 'E2E georef A',
  epsg: 32639,
  origin: [500000, 3200000, 0] as V3,
};
/** Project B: the same zone, another origin. */
const B = {
  id: 'e2e-geo-b',
  name: 'E2E georef B',
  epsg: 32639,
  origin: [499000, 3201500, 10] as V3,
};
/** Project C: the next zone east, an origin near the same ground. */
const C = (() => {
  const p = fromWgs84(toWgs84([500000, 3200000, 0], 32639), 32640);
  return {
    id: 'e2e-geo-c',
    name: 'E2E georef C',
    epsg: 32640,
    origin: [Math.round(p[0]), Math.round(p[1]), 0] as V3,
  };
})();
/** Project D: a placed engineering model, for the package. */
const D = {
  id: 'e2e-geo-d',
  name: 'E2E georef D',
  epsg: 32639,
  origin: [500000, 3200000, 0] as V3,
};

/** A's layer: turned 30 degrees clockwise seen from above, moved 25 m east, 2 m up, 40 m north. */
const c30 = Math.cos(30 * rad);
const s30 = Math.sin(30 * rad);
const TA: Mat4 = [c30, 0, s30, 0, 0, 1, 0, 0, -s30, 0, c30, 0, 25, 2, -40, 1];
/** Ground truth (E, N, H in zone 39N) of a model point, by hand: local = TA p, then A's frame. */
function truth(p: V3): V3 {
  const lx = c30 * p[0] - s30 * p[2] + 25;
  const ly = p[1] + 2;
  const lz = s30 * p[0] + c30 * p[2] - 40;
  return [A.origin[0] + lx, A.origin[1] - lz, A.origin[2] + ly];
}

/** The stack fixture with every component accepted. */
function model(): ProcModel {
  const m = stackModel();
  return { ...m, id: 'stack', assemblies: m.assemblies.map((a) => ({ ...a, status: 'accepted' })) };
}

async function writeProject(
  dataRoot: DataRoot,
  p: { id: string; name: string; epsg: number; origin: V3 },
  layers: ProjectManifestInput['layers'] = [],
): Promise<string> {
  const dir = join(dataRoot.root, 'projects', p.id);
  await mkdir(join(dir, 'models'), { recursive: true });
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: p.id,
    name: p.name,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: p.epsg },
    origin: p.origin,
    captures: [{ id: 'capture-1', label: 'Synthetic capture', date: '2026-01-01' }],
    layers,
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
  return dir;
}

/** Project A: the model, its built GLB, and its layer placed by `TA`. */
async function writeA(dataRoot: DataRoot): Promise<void> {
  const dir = await writeProject(dataRoot, A, [
    {
      kind: 'mesh',
      id: 'model-stack',
      name: 'Synthetic chimney',
      src: { path: 'models/stack.glb' },
      transform: TA,
      derived: { kind: 'model', source: ['stack'] },
    },
  ]);
  const m = model();
  await writeFile(join(dir, 'models', 'stack.procmodel.json'), JSON.stringify(m, null, 2));
  const { glb } = buildEngineeringGlb(m, { detail: 'fast', drafts: false, generator: 'e2e' });
  await writeFile(join(dir, 'models', 'stack.glb'), glb);
}

const geoTest = test.extend<{ projects: undefined }>({
  projects: async ({ dataRoot }, use) => {
    await writeA(dataRoot);
    await writeProject(dataRoot, B);
    await writeProject(dataRoot, C);
    await use(undefined);
  },
});

interface Vec {
  x: number;
  y: number;
  z: number;
}
interface Obj {
  name: string;
  userData: Record<string, unknown>;
  parent: Obj | null;
  updateWorldMatrix(parents: boolean, children: boolean): void;
  localToWorld(v: Vec): Vec;
  traverse(cb: (o: Obj) => void): void;
}
interface Probe {
  aio: { invoke(c: string, r: unknown): Promise<unknown> };
  __stratlas: {
    workspace: {
      getState(): {
        project: { id: string; manifest: { layers: Layer[] } } | null;
      };
    };
    stage(): {
      camera: { position: { constructor: new (x: number, y: number, z: number) => Vec } };
      scene: Obj;
    } | null;
  };
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
  // Georeference checks include the geometry actually drawn in the Scene workbench.
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
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

/** Import one file through Import raw data; the new mesh layer and the import message. */
async function importFile(
  app: ElectronApplication,
  win: Page,
  file: string,
): Promise<{ layer: MeshLayer; message: string }> {
  const before = await meshIds(win);
  await nextOpenDialog(app, [file]);
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Import raw data');
  await win.keyboard.press('Enter');
  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 60_000 });
  const message = await panel.innerText();
  await panel.getByRole('button', { name: 'Close' }).click();
  const layers = await win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest.layers ?? [],
  );
  const layer = layers.find((l): l is MeshLayer => l.kind === 'mesh' && !before.includes(l.id));
  if (!layer) throw new Error(`no new mesh layer after importing ${file}`);
  return { layer, message };
}

const meshIds = (win: Page) =>
  win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.workspace
        .getState()
        .project?.manifest.layers.filter((l) => l.kind === 'mesh')
        .map((l) => l.id) ?? [],
  );

/** Model-space probes read from the GLB: the first vertex of three component nodes. */
function probesOf(glb: Uint8Array): { node: string; local: V3; model: V3 }[] {
  const { json, bin } = readGlb(glb);
  interface N {
    name?: string;
    translation?: number[];
    mesh?: number;
  }
  const nodes = (json.nodes ?? []) as N[];
  const meshes = (json.meshes ?? []) as { primitives: { attributes: { POSITION: number } }[] }[];
  const accessors = (json.accessors ?? []) as { bufferView: number }[];
  const views = (json.bufferViews ?? []) as { byteOffset?: number }[];
  const out: { node: string; local: V3; model: V3 }[] = [];
  for (const name of ['shaft-1', 'flue-2', 'light-l2-1']) {
    const n = nodes.find((x) => x.name === name);
    const prim = n?.mesh === undefined ? undefined : meshes[n.mesh]?.primitives[0];
    const acc = prim ? accessors[prim.attributes.POSITION] : undefined;
    const view = acc ? views[acc.bufferView] : undefined;
    if (!n || !view) throw new Error(`no vertex on ${name}`);
    const f = new Float32Array(bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + 12));
    const local: V3 = [f[0] ?? NaN, f[1] ?? NaN, f[2] ?? NaN];
    const t = n.translation ?? [0, 0, 0];
    out.push({
      node: name,
      local,
      model: [(t[0] ?? 0) + local[0], (t[1] ?? 0) + local[1], (t[2] ?? 0) + local[2]],
    });
  }
  return out;
}

/** World E, N, H of node-local points as the scene draws the layer `layerId`. */
async function drawnWorld(
  win: Page,
  layerId: string,
  origin: V3,
  probes: { node: string; local: V3 }[],
): Promise<V3[] | null> {
  const locals = await win.evaluate(
    ([id, ps]) => {
      const st = (window as unknown as Probe).__stratlas.stage();
      if (!st) return null;
      let root: Obj | null = null;
      st.scene.traverse((o) => {
        if (!root && o.userData.layerId === id) root = o;
      });
      const layer = root as Obj | null;
      if (!layer) return null;
      const V = st.camera.position.constructor;
      const out: [number, number, number][] = [];
      for (const p of ps) {
        let node: Obj | null = null;
        layer.traverse((o) => {
          if (!node && o.name === p.node) node = o;
        });
        const found = node as Obj | null;
        if (!found) return null;
        found.updateWorldMatrix(true, false);
        const w = found.localToWorld(new V(p.local[0], p.local[1], p.local[2]));
        out.push([w.x, w.y, w.z]);
      }
      return out;
    },
    [layerId, probes] as const,
  );
  // the scene is the project's local frame: x east, y up, z south of the origin
  return locals?.map(([x, y, z]) => [origin[0] + x, origin[1] - z, origin[2] + y]) ?? null;
}

function expectClose(a: V3, b: V3, tol: number, what: string): void {
  for (let i = 0; i < 3; i++)
    expect(Math.abs((a[i] ?? NaN) - (b[i] ?? NaN)), `${what} [${String(i)}]`).toBeLessThan(tol);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

geoTest(
  'an engineering model exported from A lands on the same ground in B and in the next zone',
  async ({ projects, app, win, dataRoot }) => {
    expect(projects).toBeUndefined();
    test.setTimeout(300_000);
    await openByName(win, A.name, A.id);

    // 1. export the bundle from A (the folder the save dialog would give)
    const folder = join(dataRoot.base, 'export');
    const r = (await win.evaluate(
      ([projectId, f]) =>
        (window as unknown as Probe).aio.invoke('model:exportEngineering', {
          projectId,
          modelId: 'stack',
          folder: f,
          detail: 'fast',
        }),
      [A.id, folder] as const,
    )) as { ok: boolean; files?: string[]; error?: string };
    expect(r.error).toBeUndefined();
    expect(r.files?.map((f) => f.slice(join(folder, 'stack').length + 1)).sort()).toEqual([
      'stack.components.json',
      'stack.georeference.json',
      'stack.glb',
      'stack.procmodel.json',
    ]);
    const glbFile = join(folder, 'stack', 'stack.glb');
    const probes = probesOf(new Uint8Array(await readFile(glbFile)));

    // 2. into B: same zone, another origin
    await openByName(win, B.name, B.id);
    const inB = await importFile(app, win, glbFile);
    expect(inB.layer.placement).toBe('placed');
    expect(inB.layer.georef?.crs).toEqual({ epsg: 32639 });
    expect(inB.message).toContain('Placed from the georeference in the file.');
    expect(inB.message).toContain('vertical datum is unknown');
    const projB = { crs: { epsg: B.epsg }, origin: B.origin };
    for (const p of probes)
      expectClose(
        worldOfModelPoint(inB.layer.transform, projB, p.model),
        truth(p.model),
        0.001,
        p.node,
      );
    // and where the scene draws it
    let drawn: V3[] | null = null;
    await expect
      .poll(async () => (drawn = await drawnWorld(win, inB.layer.id, B.origin, probes)) !== null, {
        timeout: 60_000,
      })
      .toBe(true);
    probes.forEach((p, i) => {
      const w = (drawn ?? [])[i];
      if (!w) throw new Error('not drawn');
      expectClose(w, truth(p.model), 0.001, `drawn ${p.node}`);
    });
    // heading 30 and scale 1 in B: model +X 10 m out
    const o = worldOfModelPoint(inB.layer.transform, projB, [0, 0, 0]);
    const x = worldOfModelPoint(inB.layer.transform, projB, [10, 0, 0]);
    expect(Math.abs(((Math.atan2(x[0] - o[0], x[1] - o[1]) / rad + 360) % 360) - 120)).toBeLessThan(
      0.01,
    );
    expect(Math.abs(Math.hypot(x[0] - o[0], x[1] - o[1], x[2] - o[2]) / 10 - 1)).toBeLessThan(1e-6);

    // a plain GLB keeps the identity and no placement
    const plain = join(dataRoot.base, 'plain.glb');
    await writeFile(plain, tinyGlb());
    const inPlain = await importFile(app, win, plain);
    expect(inPlain.layer.transform).toEqual(IDENTITY);
    expect(inPlain.layer.placement).toBeUndefined();
    expect(inPlain.layer.georef).toBeUndefined();
    expect(inPlain.message).toContain('Place it with Align, Georeference model.');

    // a coordinate system the app cannot read: placement needed, never claimed placed
    const g = readGlb(new Uint8Array(await readFile(glbFile))).json.asset as {
      extras: { aioGeoref: Georef };
    };
    const local = await readFile(glbFile);
    const unknownCrs = join(dataRoot.base, 'local-frame.glb');
    await writeFile(
      unknownCrs,
      withGeoref(new Uint8Array(local), {
        ...g.extras.aioGeoref,
        crs: { wkt: 'LOCAL_CS["synthetic site grid"]' },
      }),
    );
    const inUnknown = await importFile(app, win, unknownCrs);
    expect(inUnknown.layer.placement).toBe('needed');
    expect(inUnknown.layer.transform).toEqual(IDENTITY);
    expect(inUnknown.message).toContain('Place it with Place model.');
    expect(inUnknown.message).not.toContain('Placed from');

    // 3. into C: the next zone east
    await openByName(win, C.name, C.id);
    const inC = await importFile(app, win, glbFile);
    expect(inC.layer.placement).toBe('placed');
    const projC = { crs: { epsg: C.epsg }, origin: C.origin };
    for (const p of probes) {
      const w = worldOfModelPoint(inC.layer.transform, projC, p.model);
      // back to zone 39N through WGS84 directly
      expectClose(fromWgs84(toWgs84(w, 32640), 32639), truth(p.model), 0.001, `C ${p.node}`);
    }
    // The new-zone placement must reach the rendered model too, not only its manifest.
    let drawnC: V3[] | null = null;
    await expect
      .poll(async () => (drawnC = await drawnWorld(win, inC.layer.id, C.origin, probes)) !== null, {
        timeout: 60_000,
      })
      .toBe(true);
    probes.forEach((p, i) => {
      const w = (drawnC ?? [])[i];
      if (!w) throw new Error('not drawn in the new zone');
      expectClose(fromWgs84(toWgs84(w, 32640), 32639), truth(p.model), 0.001, `drawn C ${p.node}`);
    });
  },
);

/** The GLB with `aioGeoref` replaced in its asset extras (BIN chunk byte for byte). */
function withGeoref(glb: Uint8Array, georef: Georef): Uint8Array {
  const { json, bin } = readGlb(glb);
  const asset = (json.asset ?? {}) as Record<string, unknown>;
  const extras = (asset.extras ?? {}) as Record<string, unknown>;
  const text = new TextEncoder().encode(
    JSON.stringify({ ...json, asset: { ...asset, extras: { ...extras, aioGeoref: georef } } }),
  );
  const jsonLen = text.length + ((4 - (text.length % 4)) % 4);
  const total = 20 + jsonLen + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  dv.setUint32(20 + jsonLen, bin.byteLength, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(bin, 28 + jsonLen);
  return out;
}

const pkgTest = test.extend<{ placedProject: Georef }>({
  placedProject: async ({ dataRoot }, use) => {
    // D: the model placed from its georeference, as an import leaves it
    const georef: Georef = {
      schema: 'aio.georef/1',
      crs: { epsg: 32639 },
      anchor: [500012.5, 3200040, 3],
      axes: 'x-east,y-up,z-south',
      units: 'm',
      modelToCrs: [c30, -s30, 0, 0, 0, 0, 1, 0, -s30, -c30, 0, 0, 500012.5, 3200040, 3, 1],
      heading: { deg: 30, status: 'measured' },
      scale: { factor: 1, status: 'measured' },
      horizontal: { status: 'surveyed' },
      vertical: { datum: 'unknown', status: 'unknown' },
      provenance: { by: 'engineer', runId: 'run-1' },
    };
    const placed = georefToLayerTransform(georef, { crs: { epsg: D.epsg }, origin: D.origin });
    if (placed.kind !== 'placed') throw new Error('not placed');
    const dir = await writeProject(dataRoot, D, [
      {
        kind: 'mesh',
        id: 'stack',
        name: 'Synthetic chimney',
        src: { path: 'models/stack.glb' },
        transform: placed.transform,
        georef,
        placement: 'placed',
      },
    ]);
    const { glb } = buildEngineeringGlb(model(), {
      detail: 'fast',
      drafts: false,
      generator: 'e2e',
    });
    await writeFile(join(dir, 'models', 'stack.glb'), withGeoref(glb, georef));
    await use(georef);
  },
});

pkgTest(
  'a .aio package of a placed model opens with its placement',
  async ({ placedProject, app, win, dataRoot }) => {
    test.setTimeout(300_000);
    await openByName(win, D.name, D.id);
    const before = await win.evaluate(
      () =>
        (window as unknown as Probe).__stratlas.workspace
          .getState()
          .project?.manifest.layers.find((l) => l.id === 'stack') ?? null,
    );
    if (before?.kind !== 'mesh') throw new Error('no model layer');

    const file = join(dataRoot.base, 'placed.aio');
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

    // opened as a customer would: read only, its own data folder
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
      await expect
        .poll(
          () =>
            cw.evaluate(
              () =>
                (window as unknown as Probe).__stratlas.workspace
                  .getState()
                  .project?.manifest.layers.find((l) => l.id === 'stack') ?? null,
            ),
          { timeout: 60_000 },
        )
        .toMatchObject({ placement: 'placed', georef: placedProject, transform: before.transform });
      expect(await network.outbound()).toEqual([]);
    } finally {
      await c.close();
    }
  },
);
