import type { GlobeSite } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { issuesCsv } from './exporting';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';

/** A two-date stockpile survey in the shape of volumes.json (aio.volumes/1). */
const volumes = {
  schema: 'aio.volumes/1',
  defaultBase: 'tin',
  captures: [
    { epoch: 'e1', captureId: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
    { epoch: 'e2', captureId: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
  ],
  piles: [
    {
      id: 'P01',
      name: 'Pile 01',
      epochs: {
        e1: { volumes: { tin: { net: 1000 }, low: { net: 1200 } } },
        e2: { volumes: { tin: { net: 800 }, low: { net: 900 } } },
      },
      change: { fill: 10, cut: 210, net: -200 },
    },
    {
      id: 'P02',
      name: 'Pile 02',
      epochs: {
        e1: { volumes: { tin: { net: 500 }, low: { net: 600 } } },
        e2: { volumes: { tin: { net: 550 }, low: { net: 640 } } },
      },
      change: { fill: 60, cut: 10, net: 50 },
    },
  ],
  totals: { e1: { tin: 1500, low: 1800 }, e2: { tin: 1350, low: 1540 } },
  siteChange: { fill: 70, cut: 220, net: -150 },
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
  it('compares stockpile volumes between two survey dates', async () => {
    const fetchJson = vi.fn((url: string) =>
      url.endsWith('/volumes.json') ? Promise.resolve(volumes) : Promise.reject(new Error('404')),
    );
    const r = await runRendererTool('compare_captures', {}, ctx({ fetchJson }, surveyWorkspace()));
    expect(fetchJson).toHaveBeenCalledWith('aio://project/p1/volumes.json');
    expect(r.result).toMatchObject({
      kind: 'volumes',
      base: 'tin',
      from: { captureId: 'c1', date: '2020-12-31' },
      to: { captureId: 'c2', date: '2021-01-10' },
      total: { from: 1500, to: 1350, change: -150 },
      siteChange: { fill: 70, cut: 220, net: -150 },
      piles: [
        { id: 'P01', from: 1000, to: 800, change: -200 },
        { id: 'P02', from: 500, to: 550, change: 50 },
      ],
    });
    expect(r.summary).toBe('-150 m³ (tin)');
  });

  it('uses another base and accepts dates for the captures', async () => {
    const fetchJson = () => Promise.resolve(volumes);
    const r = await runRendererTool(
      'compare_captures',
      { from: '2020-12-31', to: 'Survey 2', base: 'low' },
      ctx({ fetchJson }, surveyWorkspace()),
    );
    expect(r.result).toMatchObject({ base: 'low', total: { from: 1800, to: 1540, change: -260 } });
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

describe('open_original_review', () => {
  it('opens the legacy layer through the app', async () => {
    const ws = fixtureWorkspace();
    const manifest = fixtureManifest();
    manifest.layers.push({
      kind: 'legacy',
      id: 'legacy',
      name: 'Original review',
      visible: true,
      viewer: 'aik',
      entry: { path: 'legacy/index.html' },
    });
    ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest }, []);
    const openReview = vi.fn();
    const r = await runRendererTool('open_original_review', {}, ctx({ app: { openReview } }, ws));
    expect(openReview).toHaveBeenCalledWith('legacy');
    expect(r.summary).toBe('Original review');
  });

  it('says so when the project has no original review', async () => {
    await expect(
      runRendererTool('open_original_review', {}, ctx({ app: { openReview: vi.fn() } })),
    ).rejects.toThrow('no original review');
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
