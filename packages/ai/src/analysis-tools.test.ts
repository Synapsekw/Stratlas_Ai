import type { GlobeSite } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { dateShiftOf } from '@aio/workspace';
import { issuesCsv } from './exporting';
import { getRendererTool, runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';
import { allToolSpecs, toolInputs } from './tools';

const fc = (net: number) => ({ fill: net, cut: 0, net });
/** A pile on one kit epoch: its volume on each base (tin and low given, the others between). */
const kitEpoch = (captureId: string, tin: number, low: number) => ({
  captureId,
  areaM2: 100,
  topM: 10,
  heightM: 5,
  ring: [
    [0, 0],
    [10, 0],
    [10, -10],
  ],
  volumes: { tin: fc(tin), plane: fc(tin), avg: fc(tin), low: fc(low) },
});

/** A two-date stockpile survey of an older project, in the kit's volumes.json (aio.volumes/1). */
const volumes = {
  schema: 'aio.volumes/1',
  densityTPerM3: 1.6,
  deadbandM: 0.05,
  defaultBase: 'tin',
  bases: [
    { id: 'tin', label: 'Triangulated toe' },
    { id: 'low', label: 'Lowest point' },
  ],
  captures: [
    { epoch: 'e1', captureId: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
    { epoch: 'e2', captureId: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
  ],
  piles: [
    {
      id: 'P01',
      name: 'Pile 01',
      zoneRing: [],
      epochs: { e1: kitEpoch('c1', 1000, 1200), e2: kitEpoch('c2', 800, 900) },
      change: { fill: 10, cut: 210, net: -200 },
    },
    {
      id: 'P02',
      name: 'Pile 02',
      zoneRing: [],
      epochs: { e1: kitEpoch('c1', 500, 600), e2: kitEpoch('c2', 550, 640) },
      change: { fill: 60, cut: 10, net: 50 },
    },
  ],
  totals: { e1: { tin: 1500, low: 1800 }, e2: { tin: 1350, low: 1540 } },
  pileChange: fc(-150),
  siteChange: { fill: 70, cut: 220, net: -150 },
};

/** An engine result of a volume measurement's item on a date. */
const result = (item: string, toCapture: string, netM3: number, extra = {}) => ({
  item,
  status: 'ok',
  cutM3: 0,
  fillM3: netM3,
  netM3,
  totalM3: netM3,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 100,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Triangulated toe',
  toLabel: toCapture,
  toCapture,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: `sha256:${item}-${toCapture}`,
  computedAt: '2021-01-11T00:00:00Z',
  ...extra,
});

/** A saved project's volume measurement: its stored result on the 10 Jan survey, a series row on 31 Dec. */
const measurements = {
  schema: 'aio.measurements/1',
  kitPilesConverted: [],
  measurements: [
    {
      id: 'm-1',
      family: 'polygon',
      tool: 'volume',
      label: 'East pile',
      scope: { kind: 'site' },
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
      items: [{ id: 'it', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      // the stored result stands for its own date: the series row of that date is not the card's
      results: [result('it', 'c2', 720.25)],
      series: [result('it', 'c1', 610), result('it', 'c2', 999)],
      createdAt: '2021-01-11T00:00:00Z',
    },
  ],
};
function ctx(
  over: Partial<RendererToolContext> = {},
  ws = fixtureWorkspace(),
): RendererToolContext {
  return {
    workspace: ws,
    window: 'issues',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-04T12:00:00Z'),
    ...over,
  };
}

function surveyWorkspace() {
  const ws = fixtureWorkspace();
  const manifest = {
    ...fixtureManifest(),
    captures: [
      { id: 'c1', label: 'Survey 1', date: '2020-12-31' },
      { id: 'c2', label: 'Survey 2', date: '2021-01-10' },
    ],
  };
  ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest }, [
    fixtureIssue({ id: 'a', code: 'D01', createdAt: '2020-12-31T09:00:00Z', severity: 2 }),
    fixtureIssue({ id: 'b', code: 'D02', createdAt: '2021-01-05T09:00:00Z', severity: 4 }),
    fixtureIssue({ id: 'c', code: 'D03', createdAt: '2021-01-10T09:00:00Z', severity: 5 }),
  ]);
  return ws;
}

describe('compare_captures', () => {
  /** Project files by path: the kit's figures, a measurements file, or both. */
  const files =
    (by: Record<string, unknown>) =>
    (url: string): Promise<unknown> => {
      const hit = Object.entries(by).find(([path]) => url.endsWith(`/${path}`));
      return hit ? Promise.resolve(hit[1]) : Promise.reject(new Error('404'));
    };

  it('assistant compare_captures returns engine figures, the same as the card', async () => {
    const fetchJson = vi.fn(
      files({ 'volumes.json': volumes, 'survey/measurements.json': measurements }),
    );
    const r = await runRendererTool('compare_captures', {}, ctx({ fetchJson }, surveyWorkspace()));
    expect(fetchJson).toHaveBeenCalledWith('aio://project/p1/survey/measurements.json');
    // one figure per pile per date: the stored result for its own date, the series for the other
    expect(r.result).toMatchObject({
      kind: 'volumes',
      unit: 'm3',
      from: { captureId: 'c1', date: '2020-12-31', total: 610 },
      to: { captureId: 'c2', date: '2021-01-10', total: 720.3 },
      total: { from: 610, to: 720.3, change: 110.3, piles: 1, of: 1 },
      piles: [{ id: 'm-1', name: 'East pile', base: 'smart', from: 610, to: 720.3, change: 110.3 }],
    });
    // the kit's figures are not read once the project's piles were converted
    expect(JSON.stringify(r.result)).not.toContain('P01');
    expect(r.summary).toBe('+110.3 m³');
  });

  it("carries an older project's kit figures over, as the app opens them", async () => {
    const fetchJson = vi.fn(files({ 'volumes.json': volumes }));
    const r = await runRendererTool('compare_captures', {}, ctx({ fetchJson }, surveyWorkspace()));
    expect(fetchJson).toHaveBeenCalledWith('aio://project/p1/volumes.json');
    expect(r.result).toMatchObject({
      kind: 'volumes',
      from: { captureId: 'c1', date: '2020-12-31' },
      to: { captureId: 'c2', date: '2021-01-10' },
      total: { from: 1500, to: 1350, change: -150 },
      piles: [
        { name: 'Pile 01', base: 'kit tin', carried: true, from: 1000, to: 800, change: -200 },
        { name: 'Pile 02', base: 'kit tin', carried: true, from: 500, to: 550, change: 50 },
      ],
    });
    expect(r.summary).toBe('-150.0 m³');
  });

  it('uses another kit base and accepts dates for the captures', async () => {
    const fetchJson = files({ 'volumes.json': volumes });
    const r = await runRendererTool(
      'compare_captures',
      { from: '2020-12-31', to: 'Survey 2', base: 'low' },
      ctx({ fetchJson }, surveyWorkspace()),
    );
    expect(r.result).toMatchObject({ total: { from: 1800, to: 1540, change: -260 } });
  });

  it('falls back to issue counts by date without survey volumes', async () => {
    const r = await runRendererTool('compare_captures', {}, ctx({}, surveyWorkspace()));
    expect(r.result).toMatchObject({
      kind: 'issues',
      from: { date: '2020-12-31', total: 1 },
      to: { date: '2021-01-10', total: 3 },
      addedBetween: { total: 2, bySeverity: { '4': 1, '5': 1 } },
    });
  });

  it('explains when the project has fewer than two dates', async () => {
    await expect(runRendererTool('compare_captures', {}, ctx())).rejects.toThrow(
      'two capture dates',
    );
  });
});

describe('measure_distance', () => {
  it('gives straight, horizontal and height difference between points and issues', async () => {
    const r = await runRendererTool(
      'measure_distance',
      { from: { kind: 'point', p: [0, 0, 0] }, to: { kind: 'issue', id: 'D01' } },
      ctx(),
    );
    expect(r.result).toMatchObject({ distanceM: 70, horizontalM: 0, heightDifferenceM: 70 });
    expect(r.summary).toBe('70.00 m');
  });
});

describe('find_issues_near', () => {
  it('lists issues within the radius, closest first, and counts the ones without a place', async () => {
    const ws = fixtureWorkspace();
    ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [
      fixtureIssue({ id: 'far', code: 'D09' }),
      fixtureIssue({
        id: 'near',
        code: 'D02',
        sightings: [
          { on: 'mesh', layer: 'm1', geom: { type: 'spoint', p: [3, 0, 4], n: [0, 1, 0] } },
        ],
      }),
      fixtureIssue({
        id: 'img',
        code: 'D03',
        sightings: [{ on: 'image', layer: 'ph', photo: 'p1', geom: { type: 'point', x: 1, y: 1 } }],
      }),
    ]);
    const r = await runRendererTool(
      'find_issues_near',
      { target: { kind: 'point', p: [0, 0, 0] }, radiusM: 10 },
      ctx({}, ws),
    );
    expect(r.result).toMatchObject({
      total: 1,
      withoutLocation: 1,
      issues: [{ code: 'D02', distanceM: 5 }],
    });
  });
});

describe('issues of a lined-up date', () => {
  const lined = () => {
    const m = fixtureManifest();
    return {
      ...m,
      captures: [
        {
          id: 'd2',
          label: 'Second',
          date: '2026-02-10',
          lineUp: { eastM: 2, northM: 1, with: 'd1', at: '2026-10-16T08:00:00Z' },
        },
      ],
      layers: m.layers.map((l) => (l.id === 'm1' ? { ...l, capture: 'd2' } : l)),
    };
  };
  const at = (p: [number, number, number]) =>
    fixtureIssue({
      id: 'near',
      code: 'D02',
      sightings: [{ on: 'mesh', layer: 'm1', geom: { type: 'spoint', p, n: [0, 1, 0] } }],
    });

  it('find_issues_near measures from where the pin is drawn', async () => {
    const ws = fixtureWorkspace();
    // stored at the origin; drawn 2 m east and 1 m north
    ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest: lined() }, [at([0, 0, 0])]);
    const r = await runRendererTool(
      'find_issues_near',
      { target: { kind: 'point', p: [2, 0, -1] }, radiusM: 0.5 },
      ctx({}, ws),
    );
    expect(r.result).toMatchObject({ total: 1, issues: [{ code: 'D02', distanceM: 0 }] });
  });

  it('exports the CSV x y z where the pin is drawn', () => {
    const m = lined();
    const csv = issuesCsv([at([10, 5, -20])], new Map(), (id) => dateShiftOf(m, id));
    expect(csv.split('\r\n')[1]).toContain('12.000,5.000,-21.000');
  });
});

describe('summaries', () => {
  it('summarize_by_class counts per class with severity', async () => {
    const r = await runRendererTool('summarize_by_class', {}, ctx());
    expect(r.result).toMatchObject({
      classes: [
        { classId: 'corrosion', label: 'Corrosion', total: 2, bySeverity: { '4': 1, '2': 1 } },
        { classId: 'coating', label: 'Coating damage', total: 1 },
      ],
    });
  });

  it('summarize_by_zone reads the zone from notes, chainage or the layer', async () => {
    const ws = fixtureWorkspace();
    ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [
      fixtureIssue({
        id: '1',
        code: 'F01',
        note: 'Rust.\nLocation: 77.0 m above datum, NE side, Flare head.\nKit finding F01.',
      }),
      fixtureIssue({
        id: '2',
        code: 'F02',
        severity: 5,
        note: 'Location: 70 m above datum, N side, Flare head.',
      }),
      fixtureIssue({ id: '3', code: 'D03', title: 'Bleeding at km 7.452', note: '' }),
      fixtureIssue({ id: '4', code: 'D04', title: 'Pothole at km 7.9', note: '' }),
      fixtureIssue({ id: '5', code: 'D05', title: 'Paint', note: '' }),
    ]);
    const r = await runRendererTool('summarize_by_zone', {}, ctx({}, ws));
    expect(r.result).toMatchObject({
      zones: [
        { zone: 'Flare head', total: 2, worst: ['F02', 'F01'] },
        { zone: 'km 7 to 8', total: 2 },
        { zone: 'Plant mesh', total: 1 },
      ],
    });
  });
});

describe('export_issues', () => {
  it('writes a CSV through the save dialog', async () => {
    const saveFile = vi.fn(() => Promise.resolve({ path: 'C:/out/tank-farm-issues.csv' }));
    const r = await runRendererTool('export_issues', { status: 'reviewed' }, ctx({ saveFile }));
    expect(saveFile).toHaveBeenCalledWith('Tank farm issues.csv', expect.stringContaining('D01'));
    expect(r.result).toEqual({ path: 'C:/out/tank-farm-issues.csv', rows: 1, format: 'csv' });
  });

  it('prefers the app exporter when one is registered', async () => {
    const exportIssues = vi.fn(() => Promise.resolve({ path: 'C:/out/x.csv' }));
    const r = await runRendererTool('export_issues', {}, ctx({ app: { exportIssues } }));
    expect(exportIssues).toHaveBeenCalledWith(expect.arrayContaining([]), 'csv');
    expect(r.result).toMatchObject({ rows: 3 });
  });

  it('reports a cancelled save without failing', async () => {
    const saveFile = () => Promise.resolve({ path: null });
    const r = await runRendererTool('export_issues', {}, ctx({ saveFile }));
    expect(r.result).toEqual({ path: null, rows: 3, format: 'csv', cancelled: true });
    expect(r.summary).toBe('Cancelled');
  });

  it('escapes CSV fields', () => {
    const csv = issuesCsv(
      [fixtureIssue({ title: 'Rust, "heavy"', note: 'line 1\nline 2' })],
      new Map([['corrosion', 'Corrosion']]),
    );
    expect(csv.split('\r\n')[0]).toBe(
      'code,title,class,severity,status,source,author,created,updated,x,y,z,note',
    );
    expect(csv).toContain('"Rust, ""heavy"""');
    expect(csv).toContain('"line 1\nline 2"');
  });
});

describe('the retired delivered viewer', () => {
  it('has no tool: no spec, no input schema and no handler', () => {
    const toolNames = allToolSpecs().map((s) => s.meta.name);
    expect(toolNames).not.toContain('open_original_review');
    expect(Object.keys(toolInputs)).not.toContain('open_original_review');
    expect(getRendererTool('open_original_review')).toBeUndefined();
  });

  it('is not a layer kind the layer listing filters by', () => {
    expect(toolInputs.list_layers.safeParse({ kind: 'mesh' }).success).toBe(true);
    expect(toolInputs.list_layers.safeParse({ kind: 'legacy' }).success).toBe(false);
  });

  it('accepts walk as a layer kind to filter by', () => {
    expect(toolInputs.list_layers.safeParse({ kind: 'walk' }).success).toBe(true);
  });

  it('is not listed among the layers of an older project', async () => {
    const ws = fixtureWorkspace();
    const base = fixtureManifest();
    const manifest = {
      ...base,
      layers: [
        ...base.layers,
        {
          kind: 'legacy' as const,
          id: 'old-viewer',
          name: 'Old viewer',
          visible: true,
          viewer: 'aik' as const,
          entry: { path: 'legacy/index.html' },
        },
      ],
    };
    ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest }, []);
    const r = await runRendererTool('list_layers', {}, ctx({}, ws));
    const listed = (r.result as { layers: { id: string }[] }).layers.map((l) => l.id);
    expect(listed).toEqual(base.layers.map((l) => l.id));
  });
});

describe('list_sites and show_on_globe', () => {
  const site = (projectId: string, name: string, lonLat: [number, number]): GlobeSite => ({
    projectId,
    name,
    lonLat,
    captures: [{ id: 'c1', label: 'Survey 1', date: '2026-06-01' }],
    issues: { open: 2, bySeverity: { '3': 2 } },
    tilesets: [{ id: 't', name: 'Site mesh', kind: 'mesh' }],
  });
  const sites = [
    site('tank-farm', 'North tank farm', [51.123456789, 25.5]),
    site('pier', 'Pier', [50, 26]),
  ];
  const listSites = () => Promise.resolve(sites);

  it('lists the library sites without an open project', async () => {
    const r = await runRendererTool('list_sites', {}, ctx({ app: { listSites } }));
    expect(r.summary).toBe('2 sites');
    expect((r.result as { sites: unknown[] }).sites[0]).toEqual({
      projectId: 'tank-farm',
      name: 'North tank farm',
      lon: 51.123457,
      lat: 25.5,
      surveys: ['2026-06-01'],
      openIssues: 2,
      bySeverity: { '3': 2 },
      tilesets: ['Site mesh'],
    });
  });

  it('flies to a site by id or name, else the open project, else the library', async () => {
    const showOnGlobe = vi.fn();
    const app = { listSites, showOnGlobe };
    expect((await runRendererTool('show_on_globe', { site: 'pier' }, ctx({ app }))).summary).toBe(
      'Pier',
    );
    expect(showOnGlobe).toHaveBeenLastCalledWith('pier');
    await runRendererTool('show_on_globe', { site: 'NORTH TANK FARM' }, ctx({ app }));
    expect(showOnGlobe).toHaveBeenLastCalledWith('tank-farm');
    const ws = fixtureWorkspace();
    ws.getState().openProject({ id: 'tank-farm', root: 'E:/x', manifest: fixtureManifest() }, []);
    await runRendererTool('show_on_globe', {}, ctx({ app }, ws));
    expect(showOnGlobe).toHaveBeenLastCalledWith('tank-farm');
    const r = await runRendererTool('show_on_globe', {}, ctx({ app }));
    expect(showOnGlobe).toHaveBeenLastCalledWith(null);
    expect(r.result).toEqual({ shown: 'library', sites: 2 });
    await expect(
      runRendererTool('show_on_globe', { site: 'nowhere' }, ctx({ app })),
    ).rejects.toThrow(
      'No site "nowhere" on the Globe. Choose a project id from list_sites: tank-farm, pier.',
    );
  });

  it('says the Globe is in the desktop app when the hooks are missing', async () => {
    await expect(runRendererTool('list_sites', {}, ctx())).rejects.toThrow('desktop app');
    await expect(runRendererTool('show_on_globe', {}, ctx())).rejects.toThrow('desktop app');
  });
});
