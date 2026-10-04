import { describe, expect, it } from 'vitest';
import {
  AiProvider,
  Conversation,
  EXPORT_FORMATS,
  EXPORT_FORMAT_KIND,
  exportKindForFile,
  ipc,
  ipcEvents,
  LocalModelSettings,
  needsApproval,
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

  it('runs an export by format for an open project', () => {
    const req = ipc['export:run'].request;
    const job = { jobId: 'j1', projectId: 'hcl', format: 'csv' };
    expect(req.safeParse(job).success).toBe(true);
    for (const format of EXPORT_FORMATS) {
      expect(req.safeParse({ ...job, format }).success).toBe(true);
    }
    expect(req.safeParse({ ...job, format: 'xlsx' }).success).toBe(false);
    expect(req.safeParse({ ...job, path: 'C:/x.csv' }).success).toBe(false);
    expect(req.safeParse({ ...job, issueIds: ['F01'] }).success).toBe(true);
    const res = ipc['export:run'].response;
    expect(res.safeParse({ ok: true, path: null }).success).toBe(true);
    expect(res.safeParse({ ok: true, path: 'C:/x.csv', count: 3, bytes: 120 }).success).toBe(true);
    expect(res.safeParse({ ok: false, error: 'Disk full' }).success).toBe(true);
    expect(ipc['export:cancel'].request.safeParse({ jobId: 'j1' }).success).toBe(true);
  });

  it('maps every export format to the package export kind of its file', () => {
    const ext = {
      csv: 'csv',
      geojson: 'geojson',
      coco: 'json',
      'kit-json': 'json',
      'masks-zip': 'zip',
      'report-pdf': 'pdf',
    } as const;
    for (const format of EXPORT_FORMATS) {
      expect(EXPORT_FORMAT_KIND[format]).toBe(exportKindForFile(`x.${ext[format]}`));
    }
  });

  it('lists report files and reports export progress', () => {
    expect(ipc['report:list'].request.safeParse({ projectId: 'hcl' }).success).toBe(true);
    expect(
      ipc['report:list'].response.safeParse({
        files: [{ path: 'report/a.pdf', name: 'a.pdf', sizeBytes: 10 }],
      }).success,
    ).toBe(true);
    const ev = ipcEvents['export:progress'];
    expect(ev.safeParse({ jobId: 'j1', phase: 'Writing', done: 1, total: 4 }).success).toBe(true);
    expect(ev.safeParse({ jobId: 'j1', phase: 'Writing', done: -1, total: 4 }).success).toBe(false);
  });
});

describe('agent history and usage contracts', () => {
  const conversation = {
    schema: 'aio.conversation/1',
    id: 'c-1',
    title: 'Fly to the worst issue',
    window: 'scene3d',
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:01:00.000Z',
    turns: [
      { kind: 'user', id: 'u1', text: 'Draft an issue', chips: [], frame: false },
      {
        kind: 'assistant',
        id: 'a1',
        runId: 'r1',
        parts: [
          { type: 'text', text: 'Drafting.' },
          { type: 'step', callId: 'k1' },
        ],
        status: 'done',
      },
    ],
    steps: {
      k1: {
        callId: 'k1',
        name: 'create_issue_draft',
        input: { title: 'Rust', severity: 3 },
        risk: 'write',
        status: 'awaiting',
        canUndo: false,
      },
    },
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
  };

  it('accepts a saved conversation and keeps pending approvals', () => {
    const r = Conversation.safeParse(conversation);
    expect(r.success).toBe(true);
    expect(r.data?.steps.k1?.status).toBe('awaiting');
  });

  it('refuses conversation ids that could leave the folder', () => {
    expect(Conversation.safeParse({ ...conversation, id: '../x' }).success).toBe(false);
    const load = ipc['ai:loadConversation'].request;
    expect(load.safeParse({ projectId: 'p', id: 'c-1' }).success).toBe(true);
    expect(load.safeParse({ projectId: 'p', id: '..\\x' }).success).toBe(false);
  });

  it('knows the local provider and an optional local model in settings', () => {
    expect(AiProvider.safeParse('local').success).toBe(true);
    expect(
      Settings.safeParse({
        cloudAi: false,
        theme: 'dark',
        sidebarCollapsed: false,
        dataRoot: 'E:/d',
        routes: [{ task: 'chat', provider: 'local', model: 'llama3.2' }],
        localModel: { enabled: true, baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
      }).success,
    ).toBe(true);
    expect(
      LocalModelSettings.safeParse({ enabled: true, baseUrl: 'ftp://x', model: 'm' }).success,
    ).toBe(false);
  });

  it('tags usage events with provider and model and sends with a project id', () => {
    const e = ipcEvents['ai:event'].safeParse({
      type: 'usage',
      runId: 'r',
      inputTokens: 1,
      outputTokens: 2,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
    expect(e.success).toBe(true);
    expect(
      ipc['ai:send'].request.safeParse({
        runId: 'r',
        projectId: 'p',
        window: 'map',
        context: {},
        messages: [{ role: 'user', content: 'hi' }],
      }).success,
    ).toBe(true);
  });

  it('reports usage per project and provider', () => {
    const provider = {
      provider: 'anthropic',
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.1,
      costKnown: true,
    };
    expect(
      ipc['ai:usage'].response.safeParse({
        projects: [
          { key: 'e:/p', name: 'P', updatedAt: '2026-10-04T10:00:00.000Z', providers: [provider] },
        ],
      }).success,
    ).toBe(true);
  });
});
