import { readGlb } from '@aio/modelling';
import { readManifestFile, updateManifestFile, writeManifestFile } from '@aio/project/builder';
import { ProcModel, type ProjectManifest } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerModelBuilderIpc, type ModelProjects } from './modelBuilder';
import { collectHandlers } from './notYet';

const NOW = new Date('2026-10-06T10:00:00Z');

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'site',
  name: 'Synthetic site',
  crs: { epsg: 32640 },
  origin: [400000, 2800000, 0],
  captures: [{ id: 'c1', label: 'First', date: '2026-01-10' }],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const model = ProcModel.parse({
  schema: 'aio.procmodel/2',
  materials: [],
  assemblies: [],
  id: 'plant',
  name: 'Plant',
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:00Z',
  capture: 'c1',
  parts: [
    {
      kind: 'cylinder',
      id: 'p1',
      tag: 'T-101',
      class: 'tank',
      status: 'accepted',
      origin: { by: 'drawing', layer: 'TANKS' },
      base: [0, 0, 0],
      radius: 6,
      height: 12,
    },
    {
      kind: 'box',
      id: 'p2',
      name: 'Skid A',
      class: 'skid',
      status: 'draft',
      origin: { by: 'manual' },
      base: [20, 0, 0],
      size: [6, 2, 3],
    },
  ],
});

let dir = '';
let root = '';

function ipc(projects: Partial<ModelProjects> = {}) {
  return collectHandlers((handle) => {
    registerModelBuilderIpc({
      handle,
      projects: {
        root: (id) => (id === 'site' ? root : undefined),
        package: () => undefined,
        ...projects,
      },
      now: () => NOW,
    });
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quadrion-models-'));
  root = join(dir, 'site');
  await mkdir(root);
  await writeManifestFile(root, manifest);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('model builder IPC', () => {
  it('registers every model channel and the cloud drawings policy', () => {
    expect(ipc().channels()).toEqual([
      'ai:setCloudDrawings',
      'model:build',
      'model:list',
      'model:read',
      'model:write',
    ]);
  });

  it('writes a model with a backup, lists and reads it back', async () => {
    const r = ipc();
    expect(await r.call('model:list', { projectId: 'site' })).toEqual({
      ok: true,
      models: [],
      readOnly: false,
    });
    expect(await r.call('model:write', { projectId: 'site', model })).toEqual({ ok: true });
    const file = join(root, 'models', 'plant.procmodel.json');
    expect(existsSync(file)).toBe(true);
    await r.call('model:write', { projectId: 'site', model: { ...model, name: 'Plant 2' } });
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toMatchObject({ name: 'Plant' });
    expect(await r.call('model:list', { projectId: 'site' })).toEqual({
      ok: true,
      models: [
        {
          id: 'plant',
          name: 'Plant 2',
          parts: 2,
          accepted: 1,
          updatedAt: '2026-10-06T08:00:00Z',
        },
      ],
      readOnly: false,
    });
    const read = await r.call('model:read', { projectId: 'site', id: 'plant' });
    expect(read).toMatchObject({ ok: true, readOnly: false, model: { name: 'Plant 2' } });
  });

  it('says what is wrong with a model file it cannot read', async () => {
    await mkdir(join(root, 'models'));
    await writeFile(join(root, 'models', 'bad.procmodel.json'), '{"schema":"aio.procmodel/1"}');
    const read = await ipc().call('model:read', { projectId: 'site', id: 'bad' });
    expect(read).toMatchObject({ ok: false });
    expect(!read.ok && read.error).toMatch(/bad\.procmodel\.json.*not valid/);
    expect(await ipc().call('model:read', { projectId: 'site', id: 'none' })).toMatchObject({
      ok: false,
      error: 'There is no model "none" in this project.',
    });
    // an invalid file is left out of the list, not fatal
    expect(await ipc().call('model:list', { projectId: 'site' })).toMatchObject({ models: [] });
  });

  it('builds the accepted parts into a GLB and a tagged, derived mesh layer', async () => {
    const r = ipc();
    await r.call('model:write', { projectId: 'site', model });
    const built = await r.call('model:build', { projectId: 'site', id: 'plant' });
    expect(built).toEqual({ ok: true, layer: 'model-plant', glb: 'models/plant.glb' });
    const glb = new Uint8Array(await readFile(join(root, 'models', 'plant.glb')));
    expect((readGlb(glb).json.nodes as { name: string }[]).map((n) => n.name)).toEqual([
      'T-101',
      'plant',
    ]);
    const m = await readManifestFile(root);
    expect(m.layers).toEqual([
      {
        kind: 'mesh',
        id: 'model-plant',
        name: 'Plant',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        tags: [{ node: 'T-101', tag: 'T-101', area: 'tank' }],
        capture: 'c1',
        derived: { kind: 'model', source: ['plant'], runId: 'build-20261006T100000Z' },
      },
    ]);
    expect(existsSync(join(root, 'manifest.json.bak'))).toBe(true);
    // the list names the built layer
    expect(await r.call('model:list', { projectId: 'site' })).toMatchObject({
      models: [{ id: 'plant', layer: 'model-plant' }],
    });
  });

  it('builds a draft preview of every part as a draft layer, and a real build replaces it', async () => {
    const r = ipc();
    await r.call('model:write', { projectId: 'site', model });
    expect(await r.call('model:build', { projectId: 'site', id: 'plant', draft: true })).toEqual({
      ok: true,
      layer: 'model-draft-plant',
      glb: 'models/draft-plant.glb',
    });
    let m = await readManifestFile(root);
    expect(m.layers[0]).toMatchObject({
      id: 'model-draft-plant',
      name: 'Plant (draft)',
      derived: { kind: 'model', source: ['plant'], draft: true },
    });
    const glb = new Uint8Array(await readFile(join(root, 'models', 'draft-plant.glb')));
    expect((readGlb(glb).json.nodes as unknown[]).length).toBe(3);
    // building again keeps one layer
    await r.call('model:build', { projectId: 'site', id: 'plant', draft: true });
    m = await readManifestFile(root);
    expect(m.layers.map((l) => l.id)).toEqual(['model-draft-plant']);
    await r.call('model:build', { projectId: 'site', id: 'plant' });
    m = await readManifestFile(root);
    expect(m.layers.map((l) => l.id)).toEqual(['model-plant']);
  });

  it('refuses to build nothing, and names a model problem', async () => {
    const r = ipc();
    const none = { ...model, parts: model.parts.map((p) => ({ ...p, status: 'draft' as const })) };
    await r.call('model:write', { projectId: 'site', model: none });
    expect(await r.call('model:build', { projectId: 'site', id: 'plant' })).toEqual({
      ok: false,
      error: 'Accept at least one part, then build the model.',
    });
    const crossed = ProcModel.parse({
      ...model,
      parts: [
        {
          kind: 'extrusion',
          id: 'bow',
          status: 'accepted',
          origin: { by: 'manual' },
          footprint: [
            [0, 0],
            [4, 4],
            [4, 0],
            [0, 4],
          ],
          baseY: 0,
          height: 3,
        },
      ],
    });
    await r.call('model:write', { projectId: 'site', model: crossed });
    expect(await r.call('model:build', { projectId: 'site', id: 'plant' })).toEqual({
      ok: false,
      error: 'Part "bow": the footprint crosses itself.',
    });
  });

  it('upgrades a /1 file on save and keeps parts', async () => {
    const v1: Record<string, unknown> = { ...model, schema: 'aio.procmodel/1' };
    delete v1.materials;
    delete v1.assemblies;
    const v1Text = `${JSON.stringify(v1, null, 2)}\n`;
    await mkdir(join(root, 'models'));
    const file = join(root, 'models', 'plant.procmodel.json');
    await writeFile(file, v1Text);
    const r = ipc();
    expect(await r.call('model:list', { projectId: 'site' })).toMatchObject({
      models: [{ id: 'plant', parts: 2, accepted: 1 }],
    });
    const read = await r.call('model:read', { projectId: 'site', id: 'plant' });
    if (!read.ok) throw new Error(read.error);
    expect(read.model.schema).toBe('aio.procmodel/2');
    expect(read.model.parts).toEqual(model.parts);
    // the file itself is not touched by reading
    expect(await readFile(file, 'utf8')).toBe(v1Text);
    expect(await r.call('model:write', { projectId: 'site', model: read.model })).toEqual({
      ok: true,
    });
    const saved = ProcModel.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(saved.schema).toBe('aio.procmodel/2');
    expect(saved.parts.map((p) => [p.id, p.status])).toEqual([
      ['p1', 'accepted'],
      ['p2', 'draft'],
    ]);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(v1Text);
    // a /1 file builds as before
    await writeFile(file, v1Text);
    expect(await r.call('model:build', { projectId: 'site', id: 'plant' })).toEqual({
      ok: true,
      layer: 'model-plant',
      glb: 'models/plant.glb',
    });
  });

  it('refuses to save over a file a newer build saved', async () => {
    const text = JSON.stringify({ ...model, schema: 'aio.procmodel/3' });
    await mkdir(join(root, 'models'));
    const file = join(root, 'models', 'plant.procmodel.json');
    await writeFile(file, text);
    const written = await ipc().call('model:write', { projectId: 'site', model });
    expect(!written.ok && written.error).toMatch(/was saved by a newer version of Quadrion AI/);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('refuses a /3 file with the newer-version message', async () => {
    const text = JSON.stringify({ ...model, schema: 'aio.procmodel/3' });
    await mkdir(join(root, 'models'));
    const file = join(root, 'models', 'plant.procmodel.json');
    await writeFile(file, text);
    const r = ipc();
    const newer =
      /^models\/plant\.procmodel\.json was saved by a newer version of Quadrion AI \(aio\.procmodel\/3\)\. Update the app to open it\./;
    const read = await r.call('model:read', { projectId: 'site', id: 'plant' });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toMatch(newer);
    const built = await r.call('model:build', { projectId: 'site', id: 'plant' });
    expect(!built.ok && built.error).toMatch(newer);
    expect(await r.call('model:list', { projectId: 'site' })).toMatchObject({ models: [] });
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(existsSync(join(root, 'models', 'plant.glb'))).toBe(false);
  });

  it('builds an engineering model to a GLB with one node per accepted assembly', async () => {
    const shaft = (id: string, status: 'draft' | 'accepted' | 'rejected', tag?: string) => ({
      kind: 'shaft',
      id,
      name: id,
      description: '',
      category: 'shaft',
      status,
      origin: { by: 'manual' },
      quality: {},
      sources: [],
      ...(tag ? { tag } : {}),
      params: {
        base: [40 * Number(id.slice(-1)), 0, 0],
        openTop: false,
        profile: [
          { y: 0, r: 3 },
          { y: 30, r: 2 },
        ],
      },
    });
    // a draft part sharing the tank's tag: its node is told apart by name, not by tag
    const twin = {
      kind: 'box',
      id: 'p4',
      tag: 'T-101',
      class: 'skid',
      status: 'draft',
      origin: { by: 'manual' },
      base: [60, 0, 0],
      size: [2, 2, 2],
    };
    const eng = ProcModel.parse({
      ...model,
      parts: [...model.parts, twin],
      assemblies: [
        shaft('shaft-1', 'accepted', 'CH-1'),
        shaft('shaft-2', 'accepted'),
        shaft('shaft-3', 'draft'),
        shaft('shaft-4', 'rejected'),
      ],
    });
    const r = ipc();
    await r.call('model:write', { projectId: 'site', model: eng });
    expect(await r.call('model:build', { projectId: 'site', id: 'plant' })).toEqual({
      ok: true,
      layer: 'model-plant',
      glb: 'models/plant.glb',
    });
    const glb = new Uint8Array(await readFile(join(root, 'models', 'plant.glb')));
    const names = (readGlb(glb).json.nodes as { name: string }[]).map((n) => n.name);
    // the accepted assemblies, then the accepted part, under the model root
    expect(names.filter((n) => n.startsWith('shaft-'))).toEqual(['shaft-1', 'shaft-2']);
    expect(names).toContain('T-101');
    expect(names).toContain('plant');
    const m = await readManifestFile(root);
    expect(m.layers[0]).toMatchObject({
      id: 'model-plant',
      tags: [
        { node: 'shaft-1', tag: 'CH-1', area: 'shaft' },
        { node: 'T-101', tag: 'T-101', area: 'tank' },
      ],
    });
    // the draft preview adds the draft assembly, never the rejected one
    await r.call('model:build', { projectId: 'site', id: 'plant', draft: true });
    const draft = new Uint8Array(await readFile(join(root, 'models', 'draft-plant.glb')));
    const draftNames = (readGlb(draft).json.nodes as { name: string }[]).map((n) => n.name);
    expect(draftNames.filter((n) => n.startsWith('shaft-'))).toEqual([
      'shaft-1',
      'shaft-2',
      'shaft-3',
    ]);
    const layer = (await readManifestFile(root)).layers.find((l) => l.id === 'model-draft-plant');
    expect(layer?.kind === 'mesh' && layer.tags).toEqual([
      { node: 'shaft-1', tag: 'CH-1', area: 'shaft' },
      { node: 'T-101', tag: 'T-101', area: 'tank' },
      { node: 'T-101_p4', tag: 'T-101', area: 'skid' },
    ]);
  });

  it('keeps packages read-only and reads models from them', async () => {
    const entries = new Map<string, unknown>([
      ['models/plant.procmodel.json', {}],
      ['manifest.json', {}],
    ]);
    const r = ipc({
      root: () => undefined,
      package: () => ({
        manifest,
        archive: {
          entries,
          read: (name) =>
            Promise.resolve(
              Buffer.from(name.endsWith('.procmodel.json') ? JSON.stringify(model) : ''),
            ),
        },
      }),
    });
    expect(await r.call('model:list', { projectId: 'site' })).toMatchObject({
      ok: true,
      readOnly: true,
      models: [{ id: 'plant' }],
    });
    expect(await r.call('model:read', { projectId: 'site', id: 'plant' })).toMatchObject({
      ok: true,
      readOnly: true,
    });
    for (const res of [
      await r.call('model:write', { projectId: 'site', model }),
      await r.call('model:build', { projectId: 'site', id: 'plant' }),
      await r.call('ai:setCloudDrawings', { projectId: 'site', allow: true }),
    ]) {
      expect(res).toMatchObject({ ok: false, code: 'read-only' });
    }
  });

  it('answers for a project that is not open', async () => {
    const r = ipc();
    expect(await r.call('model:list', { projectId: 'other' })).toMatchObject({
      ok: false,
      error: 'Project "other" is not open.',
    });
  });

  it('sets the cloud drawings policy in the manifest, off by default', async () => {
    const r = ipc();
    expect((await readManifestFile(root)).aiCloudDrawings).toBeUndefined();
    expect(await r.call('ai:setCloudDrawings', { projectId: 'site', allow: true })).toEqual({
      ok: true,
    });
    expect((await readManifestFile(root)).aiCloudDrawings).toBe(true);
    await r.call('ai:setCloudDrawings', { projectId: 'site', allow: false });
    expect((await readManifestFile(root)).aiCloudDrawings).toBeUndefined();
  });

  it('keeps a built layer, the policy and a save on its way made at the same moment', async () => {
    const r = ipc();
    await r.call('model:write', { projectId: 'site', model });
    // a slow save of the same project has read the manifest when the handlers are called
    const slow = updateManifestFile(root, async (m) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { manifest: { ...m, name: 'Renamed meanwhile' } };
    });
    const [built, policy] = await Promise.all([
      r.call('model:build', { projectId: 'site', id: 'plant' }),
      r.call('ai:setCloudDrawings', { projectId: 'site', allow: true }),
    ]);
    await slow;
    expect(built).toEqual({ ok: true, layer: 'model-plant', glb: 'models/plant.glb' });
    expect(policy).toEqual({ ok: true });
    const m = await readManifestFile(root);
    expect(m.name).toBe('Renamed meanwhile');
    expect(m.aiCloudDrawings).toBe(true);
    expect(m.layers.map((l) => l.id)).toEqual(['model-plant']);
  });
});
