import { describe, expect, it } from 'vitest';
import {
  ImportItem,
  Issue,
  ipc,
  ipcEvents,
  LayerPatch,
  Layer,
  LocalModelSettings,
  parseManifest,
  pipelineParams,
  Settings,
  type ProjectManifestInput,
} from './index';

const mesh = {
  kind: 'mesh',
  id: 'plant-c2',
  name: 'Plant model',
  src: { path: 'assets/plant.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
} as const;

const manifest = (layers: unknown[], extra: object = {}): ProjectManifestInput =>
  ({
    schema: 'aio.project/1',
    id: 'demo',
    name: 'Demo',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [
      { id: 'c1', label: 'First', date: '2026-01-10' },
      { id: 'c2', label: 'Second', date: '2026-06-10' },
    ],
    layers,
    severityModels: [],
    classCatalogues: [],
    ...extra,
  }) as ProjectManifestInput;

describe('M8 layer additions', () => {
  it('keeps M7 layers valid and reads capture, derived and the cloud scalar', () => {
    expect(parseManifest(manifest([mesh])).ok).toBe(true);
    const cloud = {
      kind: 'pointcloud',
      id: 'change-cloud',
      name: 'Change',
      src: { path: 'change/c1-c2-cloud.copc.laz' },
      format: 'copc',
      capture: 'c2',
      derived: {
        kind: 'change',
        from: 'c1',
        to: 'c2',
        changeId: 'c1-c2-cloud',
        source: ['a', 'b'],
      },
      scalar: {
        dim: 'Distance',
        label: 'Distance',
        unit: 'm',
        range: [-0.4, 0.4],
        diverging: true,
      },
    };
    const r = parseManifest(
      manifest([{ ...mesh, capture: 'c2' }, cloud], { aiCloudDrawings: false }),
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('refuses a malformed derived block or scalar range', () => {
    const bad = { ...mesh, derived: { kind: 'guess' } };
    expect(Layer.safeParse(bad).success).toBe(false);
    const cloud = {
      kind: 'pointcloud',
      id: 'x',
      name: 'x',
      src: { path: 'x.laz' },
      format: 'copc',
      scalar: { dim: 'Distance', label: 'D', unit: 'm', range: [1, -1], diverging: true },
    };
    expect(Layer.safeParse(cloud).success).toBe(false);
  });

  it('patches the capture of a layer, or clears it with null', () => {
    expect(LayerPatch.safeParse({ capture: 'c1' }).success).toBe(true);
    expect(LayerPatch.safeParse({ capture: null }).success).toBe(true);
    expect(LayerPatch.safeParse({ capture: 'c1', offsetMs: 3 }).success).toBe(false);
  });

  it('lists a DXF drawing in the import', () => {
    expect(
      ImportItem.safeParse({ file: 'plot.dxf', kind: 'drawing', status: 'queued' }).success,
    ).toBe(true);
  });
});

describe('M8 issue additions', () => {
  it('accepts capture, track and resolvedIn, and stays valid without them', () => {
    const issue = {
      id: 'i1',
      code: 'F01',
      classId: 'coating',
      severityModelId: 's',
      severity: 3,
      status: 'closed',
      title: 'Coating breakdown',
      note: '',
      author: 'reviewer',
      createdAt: '2026-10-03T10:00:00+03:00',
      updatedAt: '2026-10-03T10:00:00+03:00',
      sightings: [
        { on: 'mesh', layer: 'plant', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } },
      ],
      source: 'human',
    };
    expect(Issue.safeParse(issue).success).toBe(true);
    expect(
      Issue.safeParse({ ...issue, capture: 'c1', track: 't1', resolvedIn: 'c2' }).success,
    ).toBe(true);
  });
});

describe('M8 pipeline params', () => {
  it('takes an imagery change between two orthos and refuses unknown keys', () => {
    const p = pipelineParams('change.raster');
    const ok = { from: 'c1', to: 'c2', layerFrom: 'o1', layerTo: 'o2', method: 'gradient' };
    expect(p.safeParse(ok).success).toBe(true);
    expect(
      p.safeParse({
        ...ok,
        maxShiftPx: 2,
        mask: [
          [48, 29],
          [48.1, 29],
          [48.1, 29.1],
        ],
      }).success,
    ).toBe(true);
    expect(p.safeParse({ ...ok, method: 'magic' }).success).toBe(false);
    expect(p.safeParse({ ...ok, out: '../x' }).success).toBe(false);
    expect(p.safeParse({ ...ok, bogus: 1 }).success).toBe(false);
  });

  it('takes surface, cloud and mesh change with optional capture pairs', () => {
    expect(
      pipelineParams('change.surface').safeParse({
        from: { layer: 'dsm1', kind: 'dsm' },
        to: { layer: 'cloud2', kind: 'cloud' },
        captures: { from: 'c1', to: 'c2' },
        minDepthM: 0.1,
      }).success,
    ).toBe(true);
    expect(
      pipelineParams('change.cloud').safeParse({ layerFrom: 'a', layerTo: 'b', signed: true })
        .success,
    ).toBe(true);
    expect(pipelineParams('change.mesh').safeParse({ layerFrom: 'a' }).success).toBe(false);
  });

  it('takes frame pairs, or two dates to pair', () => {
    const p = pipelineParams('change.frames');
    expect(p.safeParse({ from: 'c1', to: 'c2', maxPoseM: 5 }).success).toBe(true);
    expect(
      p.safeParse({ pairs: [{ a: { layer: 'v1', t: 1 }, b: { layer: 'v2', t: 1.2 } }] }).success,
    ).toBe(true);
    expect(p.safeParse({ maxPoseM: 5 }).success).toBe(false);
  });

  it('imports a DXF with control points and fits a cloud', () => {
    const d = pipelineParams('drawing.import');
    const control = [
      { drawing: [0, 0], lonLat: [48.1, 29.0] },
      { drawing: [100, 0], local: [100, 0, 0] },
    ];
    expect(d.safeParse({ src: 'D:/plans/plot.dxf', units: 'm', control }).success).toBe(true);
    expect(d.safeParse({ src: 'D:/plans/plot.dxf', units: 'yards' }).success).toBe(false);
    expect(
      d.safeParse({ src: 'x.dxf', control: [{ drawing: [0, 0] }, { drawing: [1, 1] }] }).success,
    ).toBe(false);
    const f = pipelineParams('model.fit_cloud');
    expect(f.safeParse({ layer: 'scan', kinds: ['cylinder', 'box'], model: 'site' }).success).toBe(
      true,
    );
    expect(f.safeParse({ layer: 'scan', kinds: ['cone'] }).success).toBe(false);
  });
});

describe('M8 settings and IPC', () => {
  const old = {
    cloudAi: false,
    theme: 'dark',
    sidebarCollapsed: false,
    dataRoot: 'D:/Data',
    routes: [],
  };

  it('keeps M7 settings valid and accepts change thresholds and detection settings', () => {
    expect(Settings.safeParse(old).success).toBe(true);
    const s = Settings.parse({ ...old, change: {}, inference: { provider: 'auto' } });
    expect(s.change?.cloud).toEqual({ significantM: 0.05, farM: 0.3 });
    expect(s.change?.registration).toEqual({ maxShiftPx: 2, maxShiftM: 0.05 });
    expect(
      ipc['settings:set'].request.safeParse({ change: { grown: { areaPct: 30 } } }).success,
    ).toBe(true);
  });

  it('describes the local agent server and model', () => {
    const local = { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' };
    expect(LocalModelSettings.safeParse(local).success).toBe(true);
    expect(
      LocalModelSettings.safeParse({
        ...local,
        kind: 'ollama',
        contextTokens: 32768,
        toolProfile: 'compact',
        capabilities: { tools: true, vision: false },
        timeoutMs: 120000,
      }).success,
    ).toBe(true);
    expect(LocalModelSettings.safeParse({ ...local, kind: 'bundled' }).success).toBe(false);
    expect(
      ipc['ai:status'].response.safeParse({ ready: false, reason: 'answer-only', cloud: false })
        .success,
    ).toBe(true);
  });

  it('declares every M8 channel and event', () => {
    for (const c of [
      'change:list',
      'change:read',
      'change:write',
      'change:compute',
      'change:cancel',
      'model:list',
      'model:read',
      'model:write',
      'model:build',
      'ai:setCloudDrawings',
      'inference:models',
      'inference:importModel',
      'inference:removeModel',
      'inference:run',
      'inference:cancel',
      'ai:localModels',
      'ai:localProbe',
    ])
      expect(Object.keys(ipc)).toContain(c);
    expect(Object.keys(ipcEvents)).toEqual(
      expect.arrayContaining(['change:progress', 'inference:progress']),
    );
  });

  it('answers "not implemented" with a code and refuses an unknown code', () => {
    const r = ipc['model:build'].response;
    expect(r.safeParse({ ok: false, error: 'x', code: 'not-implemented' }).success).toBe(true);
    expect(r.safeParse({ ok: false, error: 'x', code: 'nope' }).success).toBe(false);
    expect(r.safeParse({ ok: true, layer: 'model-site', glb: 'models/site.glb' }).success).toBe(
      true,
    );
  });
});
