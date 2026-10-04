import { describe, expect, it } from 'vitest';
import {
  ipc,
  ipcEvents,
  MapPackInfo,
  needsApproval,
  PackJob,
  Settings,
  parseManifest,
  Issue,
  ToolMeta,
  validateIssueAgainstModel,
  type ProjectManifest,
  type SeverityModel,
} from './index';

const severity: SeverityModel = {
  id: 'hcl-lining',
  name: 'HCl lining 1 to 5',
  levels: [
    { value: 1, label: 'Observation', color: '#8a94a6', criteria: 'No action' },
    { value: 3, label: 'Moderate', color: '#e8c547', criteria: 'Monitor' },
    { value: 5, label: 'Critical', color: '#e5484d', criteria: 'Repair now' },
  ],
};

function manifest(): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'alzour',
    name: 'Al-Zour LNG Terminal',
    customer: 'KIPIC',
    crs: { epsg: 32639 },
    origin: [245884.9, 3179597.1, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2023-02-21' }],
    layers: [
      {
        kind: 'mesh',
        id: 'plant',
        name: 'Plant model',
        visible: true,
        src: { path: 'assets/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'video',
        id: 'dji0789',
        name: 'DJI_0789',
        visible: true,
        src: { path: 'assets/DJI_0789.mp4' },
        flight: { src: { path: 'assets/DJI_0789.json' }, startUtcMs: 1676970000000 },
        lens: { model: 'pinhole', hfovDeg: 82, aspect: 16 / 9 },
        offsetMs: 0,
      },
    ],
    severityModels: [severity],
    classCatalogues: [],
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'F01',
    classId: 'coating',
    severityModelId: 'hcl-lining',
    severity: 3,
    status: 'draft',
    title: 'Coating breakdown',
    note: '',
    author: 'reviewer',
    createdAt: '2026-10-03T10:00:00+03:00',
    updatedAt: '2026-10-03T10:00:00+03:00',
    sightings: [
      { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    ],
    source: 'human',
    ...overrides,
  };
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const r = parseManifest(manifest());
    expect(r.ok).toBe(true);
  });

  it('rejects a manifest from a newer app version with a clear message', () => {
    const r = parseManifest({ ...manifest(), schema: 'aio.project/2' });
    expect(r).toEqual({
      ok: false,
      error:
        'Project was saved by a newer Stratlas (schema aio.project/2). Update the app to open it.',
    });
  });

  it('rejects duplicate layer ids', () => {
    const m = manifest();
    const first = m.layers[0];
    if (!first) throw new Error('fixture');
    m.layers.push({ ...first });
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Duplicate id "plant" in layers');
  });

  it('rejects non-objects', () => {
    expect(parseManifest('nope').ok).toBe(false);
  });
});

describe('issues', () => {
  it('rejects a severity outside the model, naming the issue code', () => {
    const r = validateIssueAgainstModel(issue({ severity: 4 }), severity);
    expect(r).toEqual({
      ok: false,
      error: 'Issue F01: severity 4 is not in model "HCl lining 1 to 5"',
    });
  });

  it('rejects uncertain when the model has no uncertain level', () => {
    const r = validateIssueAgainstModel(issue({ severity: 'uncertain' }), severity);
    expect(r.ok).toBe(false);
  });

  it('accepts a severity in the model', () => {
    expect(validateIssueAgainstModel(issue(), severity).ok).toBe(true);
  });

  it('rejects a video track that is not in time order', () => {
    const bad = issue({
      sightings: [
        {
          on: 'video',
          layer: 'v1',
          track: [
            { t: 2000, geom: { type: 'box', x: 0, y: 0, w: 1, h: 1 } },
            { t: 1000, geom: { type: 'box', x: 0, y: 0, w: 1, h: 1 } },
          ],
        },
      ],
    });
    const r = Issue.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      'Video track keyframes must be in time order',
    );
  });
});

describe('agent tools', () => {
  it('validates tool names', () => {
    expect(
      ToolMeta.safeParse({
        name: 'fly_to',
        description: 'Fly the camera to an asset',
        scope: 'window',
        risk: 'navigate',
      }).success,
    ).toBe(true);
    expect(
      ToolMeta.safeParse({
        name: 'Fly To',
        description: 'Fly the camera to an asset',
        scope: 'window',
        risk: 'navigate',
      }).success,
    ).toBe(false);
  });

  it('requires approval only for write and send', () => {
    expect(needsApproval('read')).toBe(false);
    expect(needsApproval('navigate')).toBe(false);
    expect(needsApproval('write')).toBe(true);
    expect(needsApproval('send')).toBe(true);
  });
});

describe('ipc contracts', () => {
  it('rejects extra keys on requests', () => {
    expect(ipc['project:open'].request.safeParse({ path: 'x', evil: 1 }).success).toBe(false);
    expect(ipc['project:open'].request.safeParse({ path: 'x' }).success).toBe(true);
  });

  it('rejects short API keys', () => {
    expect(ipc['ai:setKey'].request.safeParse({ provider: 'anthropic', key: 'abc' }).success).toBe(
      false,
    );
  });

  it('saves a file by name with text or bytes, never a path', () => {
    const req = ipc['dialog:saveFile'].request;
    expect(req.safeParse({ defaultName: 'register.csv', data: 'a,b' }).success).toBe(true);
    expect(
      req.safeParse({ defaultName: 'model.glb', data: new Uint8Array([1, 2]), title: 'Save' })
        .success,
    ).toBe(true);
    expect(req.safeParse({ defaultName: '', data: 'x' }).success).toBe(false);
    expect(req.safeParse({ defaultName: 'x.csv', data: 3 }).success).toBe(false);
    expect(req.safeParse({ defaultName: 'x.csv', data: 'x', path: 'C:/x' }).success).toBe(false);
    const res = ipc['dialog:saveFile'].response;
    expect(res.safeParse({ path: null }).success).toBe(true);
    expect(res.safeParse({ path: 'C:/Users/x/register.csv' }).success).toBe(true);
    expect(res.safeParse({ path: null, error: 'Disk full' }).success).toBe(true);
  });

  it('keeps old settings files valid and accepts the platform settings', () => {
    const old = {
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'E:/Data',
      routes: [],
    };
    expect(Settings.safeParse(old).success).toBe(true);
    const next = {
      ...old,
      theme: 'system',
      direction: 'rtl',
      offlineOnly: true,
      updateCheck: false,
      updateUrl: 'https://updates.example.com/stratlas/',
    };
    expect(Settings.safeParse(next).success).toBe(true);
    expect(Settings.safeParse({ ...old, direction: 'up' }).success).toBe(false);
    expect(Settings.safeParse({ ...old, updateUrl: 'ftp://x' }).success).toBe(false);
    expect(Settings.safeParse({ ...old, updateUrl: '' }).success).toBe(true);
  });

  it('describes map packs with an optional build date and source', () => {
    const pack = { id: 'kuwait', label: 'Kuwait', bbox: [46.5, 28.5, 48.5, 30.1], maxZoom: 15 };
    expect(MapPackInfo.safeParse({ ...pack, sizeBytes: 1 }).success).toBe(true);
    expect(
      MapPackInfo.safeParse({
        ...pack,
        sizeBytes: 1,
        builtAt: '2026-10-03T00:00:00.000Z',
        source: 'download',
        build: '20261003',
      }).success,
    ).toBe(true);
    expect(MapPackInfo.safeParse({ ...pack, sizeBytes: 1, source: 'web' }).success).toBe(false);
  });

  it('starts a pack download only for a sane region', () => {
    const req = ipc['packs:download'].request;
    const ok = { id: 'qatar', label: 'Qatar', bbox: [50.7, 24.4, 51.7, 26.2], maxZoom: 14 };
    expect(req.safeParse(ok).success).toBe(true);
    expect(req.safeParse({ ...ok, maxZoom: 16 }).success).toBe(false);
    expect(req.safeParse({ ...ok, id: 'Bad Id' }).success).toBe(false);
    expect(req.safeParse({ ...ok, bbox: [52, 24, 51, 26] }).success).toBe(false);
    expect(req.safeParse({ ...ok, bbox: [50, -91, 51, 26] }).success).toBe(false);
  });

  it('reports pack jobs with progress', () => {
    const job = {
      id: 'qatar',
      label: 'Qatar',
      bbox: [50.7, 24.4, 51.7, 26.2],
      maxZoom: 14,
      state: 'running',
      progress: 0.4,
      bytes: 1200,
      startedAt: '2026-10-04T08:00:00.000Z',
    };
    expect(PackJob.safeParse(job).success).toBe(true);
    expect(PackJob.safeParse({ ...job, progress: 2 }).success).toBe(false);
    expect(ipcEvents['packs:job'].safeParse(job).success).toBe(true);
  });

  it('installs updates only from an installer path', () => {
    const req = ipc['update:verifyFile'].request;
    expect(req.safeParse({ path: 'C:/Downloads/Setup.exe' }).success).toBe(true);
    expect(req.safeParse({ path: '' }).success).toBe(false);
    const res = ipc['update:verifyFile'].response;
    expect(
      res.safeParse({ ok: true, version: '0.2.0', current: '0.1.0', signer: 'CN=Synapse' }).success,
    ).toBe(true);
    expect(res.safeParse({ ok: false, error: 'Not signed' }).success).toBe(true);
  });
});
