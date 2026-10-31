import { defaultSurveySettings, type SurveyMeasurement } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { registerAppHooks } from './tool-kit';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';
import { resolveCapture, resolveLayer } from './survey-tools';
import { allToolSpecs, approvalFor, fitsProject, riskOf, toolsForWindow } from './tools';

const result = (item: string, toCapture: string, netM3: number) => ({
  item,
  status: 'ok',
  cutM3: 1,
  fillM3: netM3 + 1,
  netM3,
  totalM3: netM3 + 2,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 100,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'base',
  toLabel: toCapture,
  toCapture,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: `sha256:${item}-${toCapture}`,
  computedAt: '2021-01-11T00:00:00Z',
  peakM: 4.25,
});

const pile = (id: string, label: string, c1: number, c2: number, material?: string) =>
  ({
    id,
    family: 'polygon',
    tool: 'volume',
    label,
    scope: { kind: 'survey', capture: 'c2' },
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ],
    items: [{ id: 'it', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [result('it', 'c2', c2)],
    series: [result('it', 'c1', c1)],
    ...(material ? { material } : {}),
    createdAt: '2021-01-11T00:00:00Z',
  }) as unknown as SurveyMeasurement;

const line = {
  id: 'd1',
  family: 'line',
  tool: 'distance',
  label: 'Fence',
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [3, 4, 0],
  ],
  items: [],
  results: [],
  createdAt: '2021-01-11T00:00:00Z',
} as unknown as SurveyMeasurement;

function surveyCtx(): RendererToolContext {
  const ws = fixtureWorkspace();
  ws.getState().openProject(
    {
      id: 'p1',
      root: 'E:/x',
      manifest: {
        ...fixtureManifest(),
        captures: [
          { id: 'c2', label: 'Second', date: '2021-01-10' },
          { id: 'c1', label: 'First', date: '2020-12-31' },
        ],
      },
    },
    [
      fixtureIssue({ id: 'a', code: 'D01', severity: 4 }),
      fixtureIssue({ id: 'b', code: 'D02', severity: 2 }),
      fixtureIssue({
        id: 'c',
        code: 'D03',
        severity: 3,
        sightings: [
          { on: 'mesh', layer: 'm1', geom: { type: 'spoint', p: [100, 0, 100], n: [0, 1, 0] } },
        ],
      }),
      fixtureIssue({ id: 'd', code: 'D04', severity: 5, status: 'closed' }),
    ],
  );
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-04T12:00:00Z'),
  };
}

let off: (() => void) | null = null;
function withMeasurements(ms: SurveyMeasurement[]) {
  const settings = {
    ...defaultSurveySettings(),
    materials: [{ id: 'sand', name: 'Washed sand', densityTPerM3: 1.5 }],
  };
  off = registerAppHooks({
    surveyMeasurements: () => ({ measurements: ms, settings }),
    volumeStale: () => false,
  });
}
afterEach(() => {
  off?.();
  off = null;
});

describe('list_measurements', () => {
  it('lists the store measurements with kind, date, length and the stored volume', async () => {
    withMeasurements([pile('sp1', 'Stockpile SP1', 100, 120), line]);
    const r = await runRendererTool('list_measurements', {}, surveyCtx());
    const out = r.result as { total: number; measurements: Record<string, unknown>[] };
    expect(out.total).toBe(2);
    expect(out.measurements[0]).toMatchObject({
      id: 'sp1',
      kind: 'volume',
      date: '2021-01-10',
      netM3: 120,
      areaM2: 100,
    });
    expect(out.measurements[1]).toMatchObject({ id: 'd1', kind: 'distance', lengthM: 5 });
    const vol = await runRendererTool('list_measurements', { tool: 'volume' }, surveyCtx());
    expect((vol.result as { total: number }).total).toBe(1);
  });

  it('says so when the store has not opened the measurements', async () => {
    await expect(runRendererTool('list_measurements', {}, surveyCtx())).rejects.toThrow(
      /not open yet/,
    );
  });
});

describe('get_volume', () => {
  it('gives each pile per date as its card shows it, with tonnes from its material', async () => {
    withMeasurements([pile('sp1', 'Stockpile SP1', 100, 120), pile('sp2', 'SP2', 80, 60, 'sand')]);
    const r = await runRendererTool('get_volume', { measurement: 'sp2' }, surveyCtx());
    const out = r.result as { piles: { name: string; dates: Record<string, unknown>[] }[] };
    expect(out.piles.map((p) => p.name)).toEqual(['SP2']);
    expect(out.piles[0]?.dates).toEqual([
      expect.objectContaining({ date: '2020-12-31', netM3: 80, tonnes: 120 }),
      expect.objectContaining({ date: '2021-01-10', netM3: 60, tonnes: 90, peakM: 4.25 }),
    ]);
  });

  it('finds a pile by a word of its name and filters by date', async () => {
    withMeasurements([pile('sp1', 'Stockpile SP1', 100, 120), pile('sp2', 'SP2', 80, 60)]);
    const r = await runRendererTool(
      'get_volume',
      { measurement: 'SP1', date: 'First' },
      surveyCtx(),
    );
    const out = r.result as { piles: { id: string; dates: { netM3: number }[] }[] };
    expect(out.piles).toHaveLength(1);
    expect(out.piles[0]?.dates.map((d) => d.netM3)).toEqual([100]);
  });

  it('names the piles when the asked one does not exist', async () => {
    withMeasurements([pile('sp1', 'Stockpile SP1', 100, 120)]);
    await expect(
      runRendererTool('get_volume', { measurement: 'SP9' }, surveyCtx()),
    ).rejects.toThrow(/No volume measurement "SP9".*Stockpile SP1/);
  });
});

describe('rank_locations', () => {
  it('ranks open findings by position, worst first, each with a point for fly_to', async () => {
    const r = await runRendererTool('rank_locations', {}, surveyCtx());
    const out = r.result as {
      findings: number;
      locations: { findings: number; worst: string[]; target: { p: number[] } }[];
    };
    expect(out.findings).toBe(3);
    expect(out.locations[0]).toMatchObject({ findings: 2, worst: ['D01', 'D02'] });
    expect(out.locations[0]?.target.p).toEqual([0, 70, 0]);
    expect(out.locations[1]).toMatchObject({ findings: 1, worst: ['D03'] });
  });

  it('groups by zone on request', async () => {
    const r = await runRendererTool('rank_locations', { by: 'zone', status: 'all' }, surveyCtx());
    const out = r.result as { findings: number; locations: unknown[] };
    expect(out.findings).toBe(4);
    expect(out.locations.length).toBeGreaterThan(0);
  });
});

describe('A2 tools in the catalogue', () => {
  const names = allToolSpecs().map((s) => s.meta.name);
  it('registers every read tool and the two action tools', () => {
    for (const n of [
      'list_surveys',
      'set_survey_date',
      'list_measurements',
      'get_volume',
      'rank_locations',
      'list_detections',
      'review_detections',
      'list_jobs',
      'thermal_summary',
      'list_walks',
      'list_actions',
      'run_action',
    ])
      expect(names).toContain(n);
  });

  it('asks before a review and lets reads run', () => {
    expect(approvalFor('review_detections')).toBe(true);
    expect(riskOf('get_volume')).toBe('read');
    expect(riskOf('set_survey_date')).toBe('navigate');
  });

  it('offers a data tool only when the project may have that data', () => {
    const base = { captures: 0, photos: false, clips: false, pointClouds: false };
    expect(fitsProject('list_surveys', { facts: base })).toBe(false);
    expect(fitsProject('list_surveys', { facts: { ...base, captures: 1 } })).toBe(true);
    expect(fitsProject('get_volume', { facts: { ...base, volumes: false } })).toBe(false);
    expect(fitsProject('get_volume', { facts: base })).toBe(true);
    expect(fitsProject('list_walks', { facts: { ...base, walks: false } })).toBe(false);
    expect(fitsProject('review_detections', { facts: { ...base, detections: false } })).toBe(false);
    expect(fitsProject('thermal_summary', { facts: { ...base, thermal: true } })).toBe(true);
    expect(fitsProject('list_jobs', { facts: base })).toBe(true);
  });

  it('keeps the compact profile short: only the date, volume and action tools join it', () => {
    const compact = toolsForWindow('scene3d', 'compact').map((s) => s.meta.name);
    expect(compact).toEqual(expect.arrayContaining(['list_surveys', 'get_volume', 'run_action']));
    expect(compact).not.toContain('list_actions');
    expect(compact).not.toContain('thermal_summary');
    expect(compact).not.toContain('list_detections');
  });
});

describe('one resolver for survey dates and layers', () => {
  const caps = [
    { id: 'c1', label: 'March', date: '2024-03-02' },
    { id: 'c2', label: 'March retake', date: '2024-03-20' },
    { id: 'c3', label: 'April', date: '2024-04-13' },
  ];
  it('takes exact ids, exact dates and names, and earliest or latest', () => {
    expect(resolveCapture(caps, 'c2').id).toBe('c2');
    expect(resolveCapture(caps, '2024-04-13').id).toBe('c3');
    expect(resolveCapture(caps, 'earliest').id).toBe('c1');
    expect(resolveCapture(caps, 'Latest').id).toBe('c3');
    expect(resolveCapture(caps, 'april').id).toBe('c3');
    expect(resolveCapture(caps, 'march').id).toBe('c1');
  });

  it('refuses a name or prefix that fits several, naming each with its id and date', () => {
    expect(() => resolveCapture(caps, '2024-03')).toThrow(
      /"2024-03" fits several survey dates: c1 \(2024-03-02, March\), c2 \(2024-03-20, March retake\)/,
    );
    expect(() => resolveCapture(caps, 'mar')).toThrow(/fits several survey dates/);
    expect(() => resolveCapture(caps, 'June')).toThrow(/No survey date "June"/);
  });

  it('takes a layer by id or exact name, and refuses a name two layers share', () => {
    const m = {
      captures: caps,
      layers: [
        { id: 'a', name: 'Cloud', capture: 'c1' },
        { id: 'b', name: 'Cloud', capture: 'c3' },
        { id: 'c', name: 'Outline' },
      ],
    } as unknown as Parameters<typeof resolveLayer>[0];
    expect(resolveLayer(m, 'b').id).toBe('b');
    expect(resolveLayer(m, 'outline').id).toBe('c');
    expect(() => resolveLayer(m, 'cloud')).toThrow(
      /"cloud" fits several layers: a \(Cloud, 2024-03-02\), b \(Cloud, 2024-04-13\)/,
    );
    expect(() => resolveLayer(m, 'nope')).toThrow(/No layer "nope"/);
  });
});

describe('rank_locations on lined-up dates', () => {
  it('places each finding where the view draws it, with its date line-up', async () => {
    const c = surveyCtx();
    const p = c.workspace.getState().project;
    if (!p) throw new Error('no project');
    c.workspace.setState({
      project: {
        ...p,
        manifest: {
          ...p.manifest,
          captures: [
            { id: 'c1', label: 'First', date: '2020-12-31', lineUp: { eastM: 1000, northM: 0 } },
            { id: 'c2', label: 'Second', date: '2021-01-10' },
          ],
          layers: p.manifest.layers.map((l) => (l.id === 'm1' ? { ...l, capture: 'c1' } : l)),
        },
      },
    } as never);
    const r = await runRendererTool('rank_locations', {}, c);
    const out = r.result as { locations: { target: { p: number[] } }[] };
    expect(out.locations[0]?.target.p[0]).toBeCloseTo(1000, 0);
  });
});
