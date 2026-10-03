import { describe, expect, it } from 'vitest';
import {
  ipc,
  needsApproval,
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
});
