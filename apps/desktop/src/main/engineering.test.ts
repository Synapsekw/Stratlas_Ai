import { worldOfModelPoint } from '@aio/geo';
import { DEFAULT_MATERIALS, newProcModel, readGlb } from '@aio/modelling';
import { readManifestFile, writeManifestFile } from '@aio/project/builder';
import {
  Georef,
  type Assembly,
  type EngineerRun,
  type EvidencePack,
  type Mat4,
  type ProcModel,
  type ProjectManifest,
} from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPackage, openPackage } from '@aio/project/package';
import { builderUpdateLayers } from './builder';
import { registerEngineeringIpc, type EngineeringIpcDeps } from './engineering';
import { ProjectRegistry } from './project';
import { registerModelBuilderIpc } from './modelBuilder';
import { collectHandlers } from './notYet';

let dir = '';
let root = '';
let out = '';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'site',
  name: 'Synthetic site',
  crs: { epsg: 32640 },
  origin: [400000, 2800000, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

function flue(id: string, centre: [number, number, number]): Assembly {
  return {
    id,
    kind: 'flue',
    name: id,
    description: `Synthetic flue ${id}`,
    category: 'Flues',
    status: 'accepted',
    origin: { by: 'manual' },
    quality: {},
    sources: [],
    params: { centre, rOuter: 0.9, rInner: 0.8, height: 6 },
  };
}
/** The model's own record (synthetic): 7 m east and 9 m north of the origin, heading 0. */
const MODEL_GEOREF: Georef = {
  schema: 'aio.georef/1',
  crs: { epsg: 32640 },
  anchor: [400007, 2800009, 1],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 400007, 2800009, 1, 1],
  heading: { deg: 0, status: 'measured' },
  scale: { factor: 1, status: 'measured' },
  horizontal: { status: 'from-source' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer', runId: 'run-1' },
};
const model: ProcModel = {
  ...newProcModel({ id: 'stack', name: 'Stack', now: '2026-10-15T00:00:00.000Z' }),
  materials: [...DEFAULT_MATERIALS],
  assemblies: [flue('flue-1', [3, 20, -4]), flue('flue-2', [-6, 40, 5])],
  georef: MODEL_GEOREF,
};

const RUN: EngineerRun = {
  schema: 'aio.engineer-run/1',
  id: 'run-1',
  modelId: 'stack',
  createdAt: '2026-10-15T10:00:00Z',
  setup: {
    sources: { clouds: [{ layer: 'cloud-1' }], meshes: [], photos: [] },
    family: 'auto',
    scope: 'asset',
    detail: 'standard',
    placement: 'unplaced',
  },
  stages: { inspect: { status: 'done' } },
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
};

/** A PNG signature and IHDR naming `w` by `h` (enough for the size check). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

function evidence(images: { id: string; file: string; w?: number; h?: number }[]): EvidencePack {
  return {
    schema: 'aio.evidence/1',
    run: 'run-1',
    crs: { epsg: 32640 },
    units: 'm',
    crop: null,
    bounds: null,
    samples: { read: 0, kept: 0, ground: 0 },
    axis: null,
    base: null,
    height: null,
    slices: [],
    taper: null,
    members: [],
    familyHints: null,
    colours: [],
    photos: [],
    images: images.map((i) => ({
      id: i.id,
      file: i.file,
      kind: 'side',
      view: 'north',
      w: i.w ?? 64,
      h: i.h ?? 32,
      bytes: 33,
      sha1: '0'.repeat(40),
    })),
    reconstruction: 'not-needed',
    warnings: [],
  };
}

const runDir = () => join(root, 'engineering', 'run-1');

function ipc(over: Partial<EngineeringIpcDeps> = {}, pkg = false) {
  return collectHandlers((handle) => {
    registerEngineeringIpc({
      handle,
      projects: {
        root: (id) => (id === 'site' && !pkg ? root : undefined),
        package: (id) =>
          id === 'site' && pkg
            ? {
                manifest,
                archive: {
                  entries: new Map([['models/stack.procmodel.json', {}]]),
                  read: () => Promise.resolve(Buffer.from(JSON.stringify(model))),
                },
              }
            : undefined,
      },
      generator: 'test',
      ...over,
    });
    registerModelBuilderIpc({
      handle,
      projects: { root: (id) => (id === 'site' ? root : undefined), package: () => undefined },
    });
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quadrion-engineering-'));
  root = join(dir, 'site');
  out = join(dir, 'out');
  await mkdir(join(root, 'models'), { recursive: true });
  await writeManifestFile(root, manifest);
  await writeFile(join(root, 'models', 'stack.procmodel.json'), JSON.stringify(model));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('model:exportEngineering', () => {
  it('writes exactly four files into <folder>/<id>/ with the georeference', async () => {
    const r = await ipc().call('model:exportEngineering', {
      projectId: 'site',
      modelId: 'stack',
      folder: out,
      detail: 'fast',
    });
    if (!r.ok) throw new Error(r.error);
    const names = [
      'stack.components.json',
      'stack.georeference.json',
      'stack.glb',
      'stack.procmodel.json',
    ];
    expect(r.files.map((f) => f.slice(join(out, 'stack').length + 1)).sort()).toEqual(names);
    expect((await readdir(join(out, 'stack'))).sort()).toEqual(names);
    expect(await readdir(out)).toEqual(['stack']);
    expect(r.report.failed).toEqual([]);
    expect(r.report.triangles).toBeGreaterThan(100);
    const g = Georef.parse(
      JSON.parse(await readFile(join(out, 'stack', 'stack.georeference.json'), 'utf8')),
    );
    // no built layer: the model's own record goes out as it is
    expect(g).toEqual(MODEL_GEOREF);
    const glb = new Uint8Array(await readFile(join(out, 'stack', 'stack.glb')));
    expect(
      (readGlb(glb).json.asset as { extras?: { aioGeoref?: unknown } }).extras?.aioGeoref,
    ).toEqual(g);
    const rows = JSON.parse(
      await readFile(join(out, 'stack', 'stack.components.json'), 'utf8'),
    ) as { id: string }[];
    expect(rows.map((x) => x.id)).toEqual(['flue-1', 'flue-2']);
  });

  it('places the record where the built layer puts the model', async () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const transform: Mat4 = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 5, 2, -7, 1];
    const m = await readManifestFile(root);
    await writeManifestFile(root, {
      ...m,
      layers: [
        {
          kind: 'mesh',
          id: 'model-stack',
          name: 'Stack',
          visible: true,
          src: { path: 'models/stack.glb' },
          transform,
          derived: { kind: 'model', source: ['stack'] },
        },
      ],
    });
    const r = await ipc().call('model:exportEngineering', {
      projectId: 'site',
      modelId: 'stack',
      folder: out,
      detail: 'fast',
    });
    if (!r.ok) throw new Error(r.error);
    const g = Georef.parse(
      JSON.parse(await readFile(join(out, 'stack', 'stack.georeference.json'), 'utf8')),
    );
    const p: [number, number, number] = [3, 20, -4];
    const want = worldOfModelPoint(transform, { crs: manifest.crs, origin: manifest.origin }, p);
    const at = (i: number) => g.modelToCrs[i] ?? NaN;
    const got = [0, 1, 2].map(
      (k) => at(k) * p[0] + at(4 + k) * p[1] + at(8 + k) * p[2] + at(12 + k),
    );
    for (let k = 0; k < 3; k++)
      expect(Math.abs((got[k] ?? NaN) - (want[k] ?? NaN))).toBeLessThan(1e-6);
    expect(Math.abs(g.heading.deg - 30)).toBeLessThan(0.01);
  });

  it('leaves no partial folder when a write fails half way', async () => {
    let n = 0;
    const r = await ipc({
      writeFile: async (p, d) => {
        if (++n === 3) throw new Error('disk full');
        await writeFile(p, d);
      },
    }).call('model:exportEngineering', {
      projectId: 'site',
      modelId: 'stack',
      folder: out,
      detail: 'fast',
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/disk full/);
    expect(await readdir(out)).toEqual([]);
  });

  it('refuses to overwrite an earlier export unless asked to replace it', async () => {
    const req = { projectId: 'site', modelId: 'stack', folder: out, detail: 'fast' as const };
    expect(await ipc().call('model:exportEngineering', req)).toMatchObject({ ok: true });
    const again = await ipc().call('model:exportEngineering', req);
    expect(!again.ok && again.error).toMatch(/already exists/);
    expect(await ipc().call('model:exportEngineering', { ...req, replace: true })).toMatchObject({
      ok: true,
    });
  });

  it('exports from a read-only package too', async () => {
    const r = await ipc({}, true).call('model:exportEngineering', {
      projectId: 'site',
      modelId: 'stack',
      folder: out,
      detail: 'fast',
    });
    expect(r).toMatchObject({ ok: true });
  });

  it('refuses a model with neither a built layer nor a georeference', async () => {
    const plain: ProcModel = { ...model };
    delete plain.georef;
    await writeFile(join(root, 'models', 'stack.procmodel.json'), JSON.stringify(plain));
    const r = await ipc().call('model:exportEngineering', {
      projectId: 'site',
      modelId: 'stack',
      folder: out,
      detail: 'fast',
    });
    expect(!r.ok && r.error).toMatch(/Build the model first/);
    expect(existsSync(out)).toBe(false);
  });

  it('takes only an absolute export folder', async () => {
    await expect(
      ipc().call('model:exportEngineering', {
        projectId: 'site',
        modelId: 'stack',
        folder: 'relative/out',
        detail: 'fast',
      }),
    ).rejects.toThrow();
  });

  it('says when the model is not there', async () => {
    const r = await ipc().call('model:exportEngineering', {
      projectId: 'site',
      modelId: 'none',
      folder: out,
      detail: 'fast',
    });
    expect(!r.ok && r.error).toMatch(/no model "none"/);
  });
});

describe('model:build report', () => {
  it('answers with the triangles and how the engineering GLB was meshed', async () => {
    const r = await ipc().call('model:build', { projectId: 'site', id: 'stack' });
    if (!r.ok) throw new Error(r.error);
    expect(r.triangles).toBeGreaterThan(100);
    expect(r.report).toMatchObject({ overBudget: false, failed: [], detail: 'standard' });
    expect(r.report?.triangles).toBe(r.triangles);
  });
});

describe('engineer:validate and engineer:accept', () => {
  it('checks the written draft GLB with the Khronos validator in main', async () => {
    const r = ipc();
    expect(
      await r.call('model:build', { projectId: 'site', id: 'stack', draft: true }),
    ).toMatchObject({ ok: true, layer: 'model-draft-stack' });
    const v = await r.call('engineer:validate', {
      projectId: 'site',
      modelId: 'stack',
      draft: true,
      detail: 'standard',
    });
    if (!v.ok) throw new Error(v.error);
    expect(v.report.messages).toEqual([]);
    expect(v.report.validatorErrors).toBe(0);
    expect(v.report.finite && v.report.indicesValid && v.report.withinBudget).toBe(true);
    expect(v.report.triangles).toBeGreaterThan(100);
    // a validator error is reported, not hidden
    const failing = await ipc({
      khronos: () => Promise.resolve({ errors: 2, warnings: 0, messages: ['error X: broken'] }),
    }).call('engineer:validate', {
      projectId: 'site',
      modelId: 'stack',
      draft: true,
      detail: 'fast',
    });
    expect(failing).toMatchObject({ ok: true, report: { validatorErrors: 2 } });
    expect(
      await r.call('engineer:validate', {
        projectId: 'site',
        modelId: 'stack',
        draft: false,
        detail: 'fast',
      }),
    ).toMatchObject({ ok: false });
  });

  it('accepting twice leaves one layer with the placement and writes the sidecars', async () => {
    const r = ipc();
    await r.call('model:build', { projectId: 'site', id: 'stack', draft: true });
    for (let i = 0; i < 2; i++) {
      const a = await r.call('engineer:accept', { projectId: 'site', modelId: 'stack' });
      if (!a.ok) throw new Error(a.error);
      expect(a.layer).toBe('model-stack');
      expect(a.files).toEqual(['models/stack.georeference.json', 'models/stack.components.json']);
    }
    const m = await readManifestFile(root);
    expect(m.layers.map((l) => l.id)).toEqual(['model-stack']);
    const layer = m.layers[0];
    if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
    expect(layer.georef).toEqual(MODEL_GEOREF);
    expect(layer.placement).toBe('placed');
    expect(layer.derived).toMatchObject({ kind: 'model', source: ['stack'] });
    expect(
      Georef.parse(
        JSON.parse(await readFile(join(root, 'models', 'stack.georeference.json'), 'utf8')),
      ),
    ).toEqual(MODEL_GEOREF);
    const rows = JSON.parse(
      await readFile(join(root, 'models', 'stack.components.json'), 'utf8'),
    ) as { id: string }[];
    expect(rows.map((x) => x.id)).toEqual(['flue-1', 'flue-2']);
    expect(existsSync(join(root, 'models', 'draft-stack.glb'))).toBe(false);
    // a rebuild from the Model builder keeps the placement
    await r.call('model:build', { projectId: 'site', id: 'stack' });
    const again = (await readManifestFile(root)).layers[0];
    expect(again?.kind === 'mesh' && again.placement).toBe('placed');
    expect(again?.kind === 'mesh' && again.georef).toEqual(MODEL_GEOREF);
  });

  it('an unplaced model is accepted provisionally, and a package refuses', async () => {
    const unplaced: ProcModel = {
      ...model,
      georef: { ...MODEL_GEOREF, horizontal: { status: 'unplaced' } },
    };
    await writeFile(join(root, 'models', 'stack.procmodel.json'), JSON.stringify(unplaced));
    expect(
      await ipc().call('engineer:accept', { projectId: 'site', modelId: 'stack' }),
    ).toMatchObject({ ok: true });
    const layer = (await readManifestFile(root)).layers[0];
    expect(layer?.kind === 'mesh' && layer.placement).toBe('provisional');
    expect(
      await ipc({}, true).call('engineer:accept', { projectId: 'site', modelId: 'stack' }),
    ).toMatchObject({ ok: false, code: 'read-only' });
  });
});

describe('engineer run files', () => {
  it('writes the proposal beside run.json and reads it back', async () => {
    const proposal = {
      family: { value: 'chimney' as const, reasons: ['tall round shaft'] },
      identity: { sameAsset: true, conflicts: [] },
      components: [],
      unresolved: [],
      notes: '',
    };
    const r = ipc();
    expect(await r.call('engineer:runWrite', { projectId: 'site', run: RUN, proposal })).toEqual({
      ok: true,
    });
    expect(await r.call('engineer:runRead', { projectId: 'site', runId: 'run-1' })).toMatchObject({
      ok: true,
      run: { id: 'run-1' },
      proposal,
    });
  });

  it('reads nulls for a run that is not there', async () => {
    expect(await ipc().call('engineer:runRead', { projectId: 'site', runId: 'run-1' })).toEqual({
      ok: true,
      run: null,
      evidence: null,
      proposal: null,
    });
  });

  it('writes run.json atomically with a backup and reads it back', async () => {
    const r = ipc();
    expect(await r.call('engineer:runWrite', { projectId: 'site', run: RUN })).toEqual({
      ok: true,
    });
    await r.call('engineer:runWrite', { projectId: 'site', run: { ...RUN, modelId: 'stack-2' } });
    expect(JSON.parse(await readFile(join(runDir(), 'run.json.bak'), 'utf8'))).toMatchObject({
      modelId: 'stack',
    });
    expect((await readdir(runDir())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const read = await r.call('engineer:runRead', { projectId: 'site', runId: 'run-1' });
    expect(read).toMatchObject({ ok: true, run: { modelId: 'stack-2' }, evidence: null });
  });

  it('names a run file that is there but not valid', async () => {
    await mkdir(runDir(), { recursive: true });
    await writeFile(join(runDir(), 'evidence.json'), '{"schema":"aio.evidence/1"}');
    const r = await ipc().call('engineer:runRead', { projectId: 'site', runId: 'run-1' });
    expect(!r.ok && r.error).toMatch(/evidence\.json/);
  });

  it('refuses to write into a read-only package, which has no run files', async () => {
    const r = ipc({}, true);
    expect(await r.call('engineer:runWrite', { projectId: 'site', run: RUN })).toMatchObject({
      ok: false,
      code: 'read-only',
    });
    expect(await r.call('engineer:runRead', { projectId: 'site', runId: 'run-1' })).toEqual({
      ok: true,
      run: null,
      evidence: null,
      proposal: null,
    });
  });
});

describe('engineer:evidenceImage', () => {
  async function setup(images: { id: string; file: string; w?: number; h?: number }[]) {
    await mkdir(join(runDir(), 'img'), { recursive: true });
    await writeFile(join(runDir(), 'evidence.json'), JSON.stringify(evidence(images)));
  }

  it('returns an image listed in evidence.json as a data URL', async () => {
    await setup([{ id: 'img-side-n', file: 'img/side-n.png' }]);
    await writeFile(join(runDir(), 'img', 'side-n.png'), png(64, 32));
    const r = await ipc().call('engineer:evidenceImage', {
      projectId: 'site',
      runId: 'run-1',
      imageId: 'img-side-n',
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png(64, 32)).toString('base64')}`);
  });

  it('refuses ids not in evidence.json and files outside the run images', async () => {
    await setup([
      { id: 'img-up', file: '../evidence.json' },
      { id: 'img-out', file: 'img/../../../manifest.json' },
      { id: 'img-side', file: 'renders/side.png' },
      { id: 'img-cloud', file: 'img/cloud.laz' },
      { id: 'img-abs', file: join(root, 'manifest.json') },
    ]);
    await writeFile(join(runDir(), 'img', 'cloud.laz'), new Uint8Array([1, 2, 3]));
    for (const imageId of ['img-none', 'img-up', 'img-out', 'img-side', 'img-cloud', 'img-abs']) {
      const r = await ipc().call('engineer:evidenceImage', {
        projectId: 'site',
        runId: 'run-1',
        imageId,
      });
      expect(r.ok, imageId).toBe(false);
    }
  });

  it('always scales an image whose header gives no size, whatever evidence.json says', async () => {
    await setup([{ id: 'img-w', file: 'img/w.webp', w: 10, h: 10 }]);
    await writeFile(join(runDir(), 'img', 'w.webp'), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    const calls: number[] = [];
    const r = await ipc({
      images: {
        downscale: (_b, maxPx) => {
          calls.push(maxPx);
          return Promise.resolve({ bytes: new Uint8Array([3]), mime: 'image/jpeg' });
        },
      },
    }).call('engineer:evidenceImage', { projectId: 'site', runId: 'run-1', imageId: 'img-w' });
    expect(calls).toEqual([1568]);
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,Aw==' });
  });

  it('scales a larger image down to 1568 px', async () => {
    await setup([{ id: 'img-big', file: 'img/big.png', w: 4000, h: 1000 }]);
    await writeFile(join(runDir(), 'img', 'big.png'), png(4000, 1000));
    const calls: number[] = [];
    const r = await ipc({
      images: {
        downscale: (_bytes, maxPx) => {
          calls.push(maxPx);
          return Promise.resolve({ bytes: new Uint8Array([1, 2]), mime: 'image/jpeg' });
        },
      },
    }).call('engineer:evidenceImage', { projectId: 'site', runId: 'run-1', imageId: 'img-big' });
    expect(calls).toEqual([1568]);
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,AQI=' });
    // without a scaler it is refused rather than sent large
    const plain = await ipc().call('engineer:evidenceImage', {
      projectId: 'site',
      runId: 'run-1',
      imageId: 'img-big',
    });
    expect(plain.ok).toBe(false);
  });
});

describe('an opened .aio package is read only', () => {
  it('refuses Place model (a ground placement), model saves and run writes', async () => {
    const file = join(dir, 'site.aio');
    await exportPackage({
      root,
      out: file,
      manifest,
      exclude: [],
      header: { readOnly: true, aiPolicy: 'forbid', exports: [] },
    });
    const opened = await openPackage(file);
    if (!opened.ok) throw new Error(opened.error);
    const registry = new ProjectRegistry();
    const id = registry.registerPackage({ file, ...opened.value });
    const placed = await builderUpdateLayers(
      { projectId: id, layerIds: ['model-stack'], patch: { placement: 'placed' } },
      registry,
    );
    expect(placed.ok).toBe(false);
    const r = collectHandlers((handle) => {
      registerEngineeringIpc({ handle, projects: registry });
      registerModelBuilderIpc({ handle, projects: registry });
    });
    expect(await r.call('model:write', { projectId: id, model })).toMatchObject({
      ok: false,
      code: 'read-only',
    });
    expect(await r.call('engineer:runWrite', { projectId: id, run: RUN })).toMatchObject({
      ok: false,
      code: 'read-only',
    });
  });
});
