import { volumetricModel, type VolumetricInput, type VolumetricModel } from '@aio/project/export';
import type { ReportViewsFrame, SurveyMeasurement } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { picturesFingerprint, volumetricView } from './editorView';
import { captureRequest, exportRun, exportVolumetric, takePicturesNow } from './exportRun';

const { call, opened } = vi.hoisted(() => ({
  call: vi.fn(),
  opened: { pkg: null as { header: { exports: string[] } } | null },
}));
vi.mock('../../shell', () => ({
  bridge: { call },
  shell: { getState: () => ({ pkg: opened.pkg }) },
}));
vi.mock('@aio/workspace', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  workspace: { getState: () => ({ project: { id: 'p1' } }) },
}));
vi.mock('../../reportPage/volumetric/chrome', () => ({ dateText: (d: string) => `on ${d}` }));
const { takeReportPictures } = vi.hoisted(() => ({ takeReportPictures: vi.fn() }));
vi.mock('./liveStage', () => ({ takeReportPictures }));
const { exportIssues, toast } = vi.hoisted(() => ({
  exportIssues: vi.fn(),
  toast: { start: vi.fn(), progress: vi.fn(), finish: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('../../exports/exports', () => ({
  exportIssues,
  toasts: { getState: () => toast },
}));
const { showPictureProgress, hide } = vi.hoisted(() => {
  const hide = vi.fn();
  return { hide, showPictureProgress: vi.fn(() => hide) };
});
vi.mock('./PictureProgress', () => ({ showPictureProgress }));

const ring = (dx: number): [number, number][] => [
  [dx, 0],
  [dx + 10, 0],
  [dx + 10, 10],
];
const pileDate = (capture: string, volumeM3: number, dx: number) => ({
  capture,
  volumeM3,
  densityTPerM3: 1.6,
  areaM2: 100,
  peakM: 4,
  plusMinusM3: null,
  outline: ring(dx),
});
const input = (frame: ReportViewsFrame | null): VolumetricInput => ({
  captures: [
    { id: 'c1', label: 'June', date: '2026-06-01' },
    { id: 'c2', label: 'July', date: '2026-07-01' },
  ],
  piles: [
    {
      id: 'small',
      label: 'Small pile',
      material: null,
      base: 'Lowest point',
      dates: [pileDate('c1', 100, 0), pileDate('c2', 120, 0)],
    },
    {
      id: 'large',
      label: 'Large pile',
      material: null,
      base: 'Lowest point',
      dates: [pileDate('c1', 1000, 40), pileDate('c2', 1200, 40)],
    },
  ],
  project: { name: 'Demo yard', customer: null, site: null, crs: 'EPSG:32639' },
  method: { cellM: 0.1, gsdCm: 3, siteDensityTPerM3: null },
  frame,
});

const pile = (id: string, dx: number) =>
  ({
    id,
    tool: 'volume',
    family: 'polygon',
    label: id,
    points: ring(dx).map(([e, n]) => [e, n, 0]),
    items: [],
    results: [],
  }) as unknown as SurveyMeasurement;
const measurements = [pile('small', 0), pile('large', 40)];
const dates = ['c1', 'c2'];
const pair = { from: 'c1', to: 'c2' };
const current = picturesFingerprint(measurements, dates, pair);
const frameOf = (fingerprint: string): ReportViewsFrame => ({
  schema: 'aio.report-views/1',
  extent: [0, 0, 10, 10],
  widthPx: 100,
  heightPx: 100,
  mPerPx: 0.1,
  views: [],
  markers3d: {},
  fingerprint,
});
const modelWith = (frame: ReportViewsFrame | null): VolumetricModel =>
  volumetricModel(input(frame));

/** The order things happened in. */
let log: string[] = [];

beforeEach(() => {
  log = [];
  opened.pkg = null;
  call.mockReset();
  takeReportPictures.mockReset();
  takeReportPictures.mockImplementation(() => {
    log.push(`pictures:${exportRun.getState().phase}`);
    return Promise.resolve({ ok: true, frame: frameOf(current), unpictured: [] });
  });
  exportIssues.mockReset();
  exportIssues.mockImplementation((format: string) => {
    log.push(`export:${format}:${exportRun.getState().phase}`);
    return Promise.resolve('done');
  });
  showPictureProgress.mockClear();
  hide.mockReset();
  hide.mockImplementation(() => {
    log.push('card hidden');
  });
  for (const f of Object.values(toast)) f.mockReset();
});
afterEach(() => {
  exportRun.setState({ phase: 'idle', format: null, error: null });
  volumetricView.setState({ openFor: null, taken: {} });
});

describe('captureRequest', () => {
  it('names the piles in the report order, the dates and the fingerprint', () => {
    const plan = captureRequest('p1', modelWith(null), measurements);
    expect(plan.current).toBe(false);
    expect(plan.req).toMatchObject({ projectId: 'p1', dates, pair, fingerprint: current });
    // largest first, as the report lists them, each with its name for the progress card
    expect(plan.req.piles.map((p) => [p.id, p.label])).toEqual([
      ['large', 'Large pile'],
      ['small', 'Small pile'],
    ]);
    expect(plan.req.dateLabels).toEqual({ c1: 'on 2026-06-01', c2: 'on 2026-07-01' });
  });

  it('tells current pictures from stale ones', () => {
    expect(captureRequest('p1', modelWith(frameOf(current)), measurements).current).toBe(true);
    expect(captureRequest('p1', modelWith(frameOf('v1-old')), measurements).current).toBe(false);
  });
});

describe('exportVolumetric', () => {
  const given = (frame: ReportViewsFrame | null) => ({ model: modelWith(frame), measurements });

  it('takes no pictures when they are current, and writes the file with no card', async () => {
    const end = await exportVolumetric('volumetric-pdf', given(frameOf(current)));
    expect(takeReportPictures).not.toHaveBeenCalled();
    expect(showPictureProgress).not.toHaveBeenCalled();
    expect(log).toEqual(['export:volumetric-pdf:writing']);
    expect(end).toBe('done');
    expect(exportRun.getState()).toMatchObject({ phase: 'done', error: null });
  });

  it('takes the pictures first when there are none, under the card, then writes', async () => {
    const end = await exportVolumetric('volumetric-html', given(null));
    expect(log).toEqual(['pictures:pictures', 'export:volumetric-html:writing', 'card hidden']);
    expect(showPictureProgress).toHaveBeenCalledTimes(1);
    expect(takeReportPictures.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p1',
      fingerprint: current,
    });
    expect(volumetricView.getState().taken).toEqual({ p1: 1 });
    expect(end).toBe('done');
  });

  it('takes them again when they are stale', async () => {
    await exportVolumetric('volumetric-pdf', given(frameOf('v1-old')));
    expect(log).toEqual(['pictures:pictures', 'export:volumetric-pdf:writing', 'card hidden']);
  });

  it('names the format while it writes, for the card', async () => {
    exportIssues.mockImplementation(() => {
      expect(exportRun.getState()).toMatchObject({ phase: 'writing', format: 'volumetric-html' });
      return Promise.resolve('done');
    });
    await exportVolumetric('volumetric-html', given(null));
    expect(exportIssues).toHaveBeenCalledTimes(1);
  });

  it('does not export after Stop, and says it was stopped', async () => {
    takeReportPictures.mockResolvedValue({ ok: false, error: 'Taking them was stopped.' });
    const end = await exportVolumetric('volumetric-pdf', given(null));
    expect(exportIssues).not.toHaveBeenCalled();
    expect(end).toBe('stopped');
    expect(hide).toHaveBeenCalledTimes(1);
    expect(toast.finish).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'Taking them was stopped.',
    );
    expect(volumetricView.getState().taken).toEqual({});
  });

  it('does not export after a failed capture, and says why', async () => {
    takeReportPictures.mockResolvedValue({ ok: false, error: 'The 3D view is not available.' });
    const end = await exportVolumetric('volumetric-pdf', given(null));
    expect(exportIssues).not.toHaveBeenCalled();
    expect(end).toBe('failed');
    expect(exportRun.getState().error).toBe('The 3D view is not available.');
    expect(toast.finish).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'The pictures were not taken: The 3D view is not available.',
    );
  });

  it('says so when the capture throws, and takes the card down', async () => {
    takeReportPictures.mockRejectedValue(new Error('lost'));
    const end = await exportVolumetric('volumetric-pdf', given(null));
    expect(end).toBe('failed');
    expect(hide).toHaveBeenCalledTimes(1);
    expect(exportIssues).not.toHaveBeenCalled();
  });

  it('exports a package with the pictures it carries, stale or not', async () => {
    // a package cannot save new pictures
    opened.pkg = { header: { exports: ['report-pdf'] } };
    const end = await exportVolumetric('volumetric-pdf', given(frameOf('v1-old')));
    expect(takeReportPictures).not.toHaveBeenCalled();
    expect(end).toBe('done');
  });

  it('writes pending text before anything else', async () => {
    const flush = vi.fn(() => {
      log.push('flush');
      return Promise.resolve();
    });
    await exportVolumetric('volumetric-pdf', { ...given(null), flush });
    expect(log[0]).toBe('flush');
    expect(log[1]).toBe('pictures:pictures');
  });

  it('reports a failed export', async () => {
    exportIssues.mockResolvedValue('error');
    expect(await exportVolumetric('volumetric-pdf', given(frameOf(current)))).toBe('failed');
  });

  it('ends quietly when the save dialog is cancelled', async () => {
    exportIssues.mockResolvedValue('cancelled');
    expect(await exportVolumetric('volumetric-pdf', given(null))).toBe('idle');
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('refuses a second run while one is going', async () => {
    let release: (v: string) => void = () => undefined;
    exportIssues.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const first = exportVolumetric('volumetric-pdf', given(frameOf(current)));
    await Promise.resolve();
    await Promise.resolve();
    expect(await exportVolumetric('volumetric-html', given(frameOf(current)))).toBe('idle');
    release('done');
    await first;
    expect(exportIssues).toHaveBeenCalledTimes(1);
  });

  it('reads the saved text, the measurements and the model itself outside the editor', async () => {
    call.mockImplementation((channel: string, req: Record<string, unknown>) => {
      log.push(channel);
      if (channel === 'report:readText')
        return Promise.resolve({
          ok: true,
          value: { ok: true, file: { compareWith: 'c1' }, readOnly: false },
        });
      if (channel === 'survey:readMeasurements')
        return Promise.resolve({ ok: true, value: { ok: true, file: { measurements } } });
      if (channel === 'report:volumetricModel') {
        expect(req).toEqual({ projectId: 'p1', compareWith: 'c1' });
        return Promise.resolve({ ok: true, value: { ok: true, model: modelWith(null) } });
      }
      return Promise.resolve({ ok: false, error: `unexpected ${channel}` });
    });
    const end = await exportVolumetric('volumetric-pdf');
    expect(end).toBe('done');
    expect(log).toContain('report:volumetricModel');
    expect(log.slice(-3)).toEqual([
      'pictures:pictures',
      'export:volumetric-pdf:writing',
      'card hidden',
    ]);
    // the wait for the figures shows as a running toast, gone once the pictures start
    expect(toast.progress).toHaveBeenCalledWith(
      expect.any(String),
      'Working out the figures...',
      0,
      0,
    );
    expect(toast.dismiss).toHaveBeenCalled();
  });

  it('says why when the model cannot be read', async () => {
    call.mockResolvedValue({ ok: false, error: 'No project is open.' });
    const end = await exportVolumetric('volumetric-pdf');
    expect(end).toBe('failed');
    expect(takeReportPictures).not.toHaveBeenCalled();
    expect(exportIssues).not.toHaveBeenCalled();
    expect(toast.finish).toHaveBeenCalledWith(expect.any(String), 'error', 'No project is open.');
  });
});

describe('takePicturesNow', () => {
  it('takes the pictures and exports nothing', async () => {
    const end = await takePicturesNow({ model: modelWith(null), measurements });
    expect(end).toBe('done');
    expect(log).toEqual(['pictures:pictures', 'card hidden']);
    expect(exportIssues).not.toHaveBeenCalled();
    expect(volumetricView.getState().taken).toEqual({ p1: 1 });
  });
});
