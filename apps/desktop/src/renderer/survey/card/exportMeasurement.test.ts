// @vitest-environment jsdom
import { emptyMeasurements, type ProjectManifest, type SitePoint } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as { channel: string; req: Record<string, unknown> }[]);
vi.mock('../../shell', () => ({
  bridge: {
    call: (channel: string, req: Record<string, unknown>) => {
      calls.push({ channel, req });
      if (channel === 'dialog:saveFile')
        return Promise.resolve({ ok: true, value: { path: `C:/out/${String(req.defaultName)}` } });
      if (channel === 'dialog:savePath')
        return Promise.resolve({ ok: true, value: { path: 'C:/out/line.dxf' } });
      if (channel === 'jobs:start')
        return Promise.resolve({ ok: true, value: { ok: true, job: { id: 'j1' } } });
      return Promise.resolve({ ok: false, error: 'Not configured' });
    },
  },
}));
vi.mock('../sectionStore', () => ({ waitForJob: () => Promise.resolve({ ok: true }) }));
const png = vi.hoisted(() => ({
  chartPng: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
  savePng: vi.fn((_b: Uint8Array, name: string) => Promise.resolve(`C:/out/${name}`)),
}));
vi.mock('../../charts/exportChart', () => png);

const { exportMeasurement, measurementHasChart, exportFormats } =
  await import('./exportMeasurement');
const { measureStore } = await import('../measureStore');

const manifest = {
  captures: [],
  layers: [],
  crs: { kind: 'local' },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;
const m = (id: string, tool: 'distance' | 'area' | 'azimuth' | 'volume' | 'elevation') => ({
  id,
  family:
    tool === 'area' || tool === 'volume'
      ? ('polygon' as const)
      : tool === 'elevation'
        ? ('point' as const)
        : ('line' as const),
  tool,
  label: `Name ${id}`,
  scope: { kind: 'site' as const },
  items: [],
  results: [],
  points: [
    [0, 0, 0],
    [3, 4, 0],
    [3, 0, 0],
  ] as SitePoint[],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  calls.length = 0;
  png.chartPng.mockClear();
  png.savePng.mockClear();
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 404 })));
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  measureStore.setState({
    file: {
      ...emptyMeasurements(),
      measurements: [m('line', 'distance'), m('pad', 'area')],
    },
    focus: 'line',
  });
});
afterEach(() => {
  workspace.getState().closeProject();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('export one measurement', () => {
  it('export csv writes one measurement', async () => {
    const path = await exportMeasurement('pad', 'csv');
    const save = calls.find((c) => c.channel === 'dialog:saveFile');
    expect(save?.req.defaultName).toBe('Name-pad.csv');
    expect(path).toBe('C:/out/Name-pad.csv');
    const csv = String(save?.req.data);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toMatch(/^ref,measurement_id,label/);
    expect(rows.length).toBeGreaterThan(1);
    // only that measurement, under the reference it has in the project
    for (const row of rows.slice(1)) expect(row.startsWith('M2,pad,')).toBe(true);
    expect(csv).not.toContain(',line,');
  });

  it('exports DXF through the survey export, for that measurement alone', async () => {
    expect(await exportMeasurement('line', 'dxf')).toBe('C:/out/line.dxf');
    const start = calls.find((c) => c.channel === 'jobs:start');
    expect(start?.req).toMatchObject({
      pipeline: 'survey.export',
      project: '/p1',
      params: {
        what: 'measurements',
        format: 'dxf',
        measurements: ['line'],
        out: 'C:/out/line.dxf',
      },
    });
  });

  it('png export only when the tool has a chart', async () => {
    expect(measurementHasChart(m('a', 'distance'))).toBe(true);
    expect(measurementHasChart(m('a', 'volume'))).toBe(true);
    expect(measurementHasChart(m('a', 'elevation'))).toBe(true);
    expect(measurementHasChart(m('a', 'area'))).toBe(false);
    expect(measurementHasChart(m('a', 'azimuth'))).toBe(false);
    expect(exportFormats('line')).toEqual(['csv', 'dxf', 'png']);
    expect(exportFormats('pad')).toEqual(['csv', 'dxf']);
    await expect(exportMeasurement('pad', 'png')).rejects.toThrow();
    expect(png.chartPng).not.toHaveBeenCalled();
    // the card shown for the measurement draws its chart: that picture is saved
    document.body.innerHTML =
      '<section class="mc" data-variant="detail"><div class="pc"><svg class="pc-svg"></svg></div>' +
      '<div data-testid="card-actions" data-has-chart="true"></div></section>';
    expect(await exportMeasurement('line', 'png')).toBe('C:/out/Name-line.png');
    expect(png.chartPng).toHaveBeenCalledTimes(1);
  });

  it('png export without the chart on screen says so', async () => {
    await expect(exportMeasurement('line', 'png')).rejects.toThrow();
    expect(png.savePng).not.toHaveBeenCalled();
  });
});
