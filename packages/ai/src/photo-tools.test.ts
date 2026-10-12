import type { AccuracyReport, GcpFile, PhotoRun, PhotoRunSummary } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureManifest, fixtureWorkspace } from './test-fixtures';

const photos = (id: string, name: string) => ({
  kind: 'photos' as const,
  id,
  name,
  visible: true,
  items: [],
});

function withLayers(layers: ReturnType<typeof photos>[]) {
  const ws = fixtureWorkspace();
  const m = fixtureManifest();
  ws.getState().openProject(
    { id: 'p1', root: 'E:/p1', manifest: { ...m, layers: [...m.layers, ...layers] } },
    [],
  );
  return ws;
}

function ctx(
  over: Partial<RendererToolContext> = {},
  ws = fixtureWorkspace(),
): RendererToolContext {
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-12T12:00:00Z'),
    ...over,
  };
}

const started = { run: '20261012-1200', estimate: 'About 5 to 10 min', surveyDate: '2026-03-14' };

describe('process_photos', () => {
  it('starts the only photos layer with the dialog defaults', async () => {
    const processPhotos = vi.fn(() => Promise.resolve(started));
    const r = await runRendererTool(
      'process_photos',
      {},
      ctx({ app: { processPhotos } }, withLayers([photos('ph', 'Flight')])),
    );
    expect(processPhotos).toHaveBeenCalledWith({
      layerId: 'ph',
      preset: 'standard',
      gnss: 'auto',
      products: ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'],
      groundControlFirst: false,
    });
    expect(r.summary).toBe('Run 20261012-1200 started');
    expect(r.result).toMatchObject({
      run: '20261012-1200',
      layer: 'ph',
      estimate: 'About 5 to 10 min',
    });
  });

  it('uses the fast products for the fast preset and keeps the products given', async () => {
    const processPhotos = vi.fn(() => Promise.resolve(started));
    const c = ctx({ app: { processPhotos } }, withLayers([photos('ph', 'Flight')]));
    await runRendererTool('process_photos', { preset: 'fast' }, c);
    expect(processPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: ['ortho', 'dsm'] }),
    );
    await runRendererTool('process_photos', { products: ['cloud'] }, c);
    expect(processPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: ['cloud'] }),
    );
  });

  it('finds a layer by name, case-insensitive', async () => {
    const processPhotos = vi.fn(() => Promise.resolve(started));
    const c = ctx(
      { app: { processPhotos } },
      withLayers([photos('a', 'North flight'), photos('b', 'South flight')]),
    );
    await runRendererTool('process_photos', { layer: 'south FLIGHT' }, c);
    expect(processPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ layerId: 'b' }));
  });

  it('asks which layer when there are several', async () => {
    const c = ctx(
      { app: { processPhotos: vi.fn() } },
      withLayers([photos('a', 'North flight'), photos('b', 'South flight')]),
    );
    await expect(runRendererTool('process_photos', {}, c)).rejects.toThrow(
      'This project has 2 photos layers. Say which one: a (North flight), b (South flight).',
    );
  });

  it('says what is missing: a photos layer, the named layer, the desktop app', async () => {
    const app = { processPhotos: vi.fn() };
    await expect(
      runRendererTool('process_photos', {}, ctx({ app }, withLayers([]))),
    ).rejects.toThrow('This project has no photos layer.');
    await expect(
      runRendererTool(
        'process_photos',
        { layer: 'x' },
        ctx({ app }, withLayers([photos('a', 'North flight')])),
      ),
    ).rejects.toThrow('No photos layer "x". The photos layers: a (North flight).');
    await expect(
      runRendererTool('process_photos', {}, ctx({}, withLayers([photos('a', 'A')]))),
    ).rejects.toThrow('Processing photos is only in the desktop app.');
  });
});

const summary = (
  id: string,
  status: PhotoRunSummary['status'],
  withAccuracy: boolean,
): PhotoRunSummary => ({
  id,
  createdAt: '2026-10-12T10:00:00Z',
  status,
  preset: 'standard',
  photos: 12,
  products: [],
  ...(withAccuracy ? { accuracy: { meanReprojPx: 0.7 } } : {}),
});

const report: AccuracyReport = {
  schema: 'aio.photo-accuracy/1',
  run: 'r1',
  createdAt: '2026-10-12T10:30:00Z',
  crs: { epsg: 32639 },
  gsdCm: 2.1,
  images: { total: 12, registered: 12 },
  meanReprojPx: 0.71234,
  points: [
    {
      id: 'G1',
      role: 'control',
      dxM: 0.01,
      dyM: 0.02,
      dzM: -0.03,
      reprojPx: 0.5,
      marks: 4,
      usedInAdjustment: true,
    },
    {
      id: 'C1',
      role: 'check',
      dxM: 0.03,
      dyM: 0.04,
      dzM: 0.05,
      reprojPx: 0.6,
      marks: 3,
      usedInAdjustment: false,
    },
  ],
  rmse: {
    control: { n: 1, horizontalM: 0.02236, verticalM: 0.03 },
    check: { n: 1, horizontalM: 0.05, verticalM: 0.05 },
  },
  checkpointsInAdjustment: false,
  warnings: [{ code: 'few-marks', message: 'C1 has 3 marks.', point: 'C1' }],
};

const gcpPoint = (id: string, role: 'control' | 'check', marks: number, disabled = false) => ({
  id,
  role,
  xyz: [1, 2, 3] as [number, number, number],
  accuracy: { horizontalM: 0.02, verticalM: 0.03 },
  ...(disabled ? { disabled: true } : {}),
  marks: Array.from({ length: marks }, (_, i) => ({
    photo: `p${String(i)}`,
    px: [1, 2] as [number, number],
  })),
});

const gcp = {
  schema: 'aio.gcp/1',
  crs: { epsg: 32639 },
  points: [
    gcpPoint('G1', 'control', 4),
    gcpPoint('C1', 'check', 3),
    gcpPoint('G2', 'control', 0, true),
  ],
} as GcpFile;

const runOf = (id: string, status: PhotoRunSummary['status']) =>
  ({
    schema: 'aio.photo-run/1',
    id,
    createdAt: '2026-10-12T10:00:00Z',
    status,
    preset: 'standard',
    photos: { count: 12, registered: 12 },
  }) as unknown as PhotoRun;

function runsHooks(
  list: PhotoRunSummary[],
  read: { accuracy: AccuracyReport | null; gcp: GcpFile | null },
) {
  return {
    list: vi.fn(() => Promise.resolve(list)),
    read: vi.fn((id: string) =>
      Promise.resolve({
        run: runOf(id, list.find((r) => r.id === id)?.status ?? 'done'),
        ...read,
      }),
    ),
  };
}

const accCtx = (photoRuns: ReturnType<typeof runsHooks>) =>
  ctx({ app: { photoRuns } }, withLayers([photos('ph', 'Flight')]));

describe('accuracy_summary', () => {
  it('reads the newest run with a report by default', async () => {
    const photoRuns = runsHooks(
      [summary('r2', 'aligning', false), summary('r1', 'adjusted', true)],
      { accuracy: report, gcp },
    );
    const r = await runRendererTool('accuracy_summary', {}, accCtx(photoRuns));
    expect(photoRuns.read).toHaveBeenCalledWith('r1');
    expect(photoRuns.list).toHaveBeenCalledTimes(1);
    const res = r.result as {
      accuracy: { check: unknown; basis: string; meanReprojPx: number };
      gcp: { points: { id: string; horizontalM: number }[] } & Record<string, unknown>;
      otherRuns: unknown;
    };
    expect(res.accuracy.check).toEqual({ n: 1, horizontalM: 0.05, verticalM: 0.05 });
    expect(res.accuracy.basis).toBe('ground control');
    expect(res.accuracy.meanReprojPx).toBe(0.71);
    expect(res.gcp).toMatchObject({ control: 2, check: 1, disabled: 1, marked: 2 });
    expect(res.gcp.points[0]).toMatchObject({ id: 'C1', horizontalM: 0.05 });
    expect(res.otherRuns).toEqual([
      { id: 'r2', status: 'aligning', createdAt: '2026-10-12T10:00:00Z' },
    ]);
    expect(r.summary).toBe('Check RMSE 0.050 m horizontal, 0.050 m vertical (1 point)');
  });

  it('says GNSS only without control points', async () => {
    const photoRuns = runsHooks([summary('r1', 'adjusted', true)], {
      accuracy: { ...report, rmse: {}, points: [] },
      gcp: null,
    });
    const r = await runRendererTool('accuracy_summary', {}, accCtx(photoRuns));
    expect(r.result).toMatchObject({ accuracy: { basis: 'GNSS only' } });
    expect(r.summary).toBe('GNSS only');
  });

  it('answers about a run without a report', async () => {
    const photoRuns = runsHooks([summary('r2', 'aligning', false)], { accuracy: null, gcp: null });
    const r = await runRendererTool('accuracy_summary', {}, accCtx(photoRuns));
    expect(r.result).toMatchObject({
      accuracy: null,
      note: 'Run r2 is aligning: it has no accuracy report yet.',
    });
    expect(r.summary).toBe('r2: aligning, no accuracy report yet');
  });

  it('reads the run asked for, and lists the ids of a wrong one', async () => {
    const photoRuns = runsHooks(
      [summary('r2', 'aligning', false), summary('r1', 'adjusted', true)],
      { accuracy: null, gcp: null },
    );
    await runRendererTool('accuracy_summary', { run: 'r2' }, accCtx(photoRuns));
    expect(photoRuns.read).toHaveBeenLastCalledWith('r2');
    await expect(
      runRendererTool('accuracy_summary', { run: 'nope' }, accCtx(photoRuns)),
    ).rejects.toThrow('No photo run "nope". The runs: r2, r1.');
  });

  it('says when there are no runs, or no desktop app', async () => {
    await expect(
      runRendererTool('accuracy_summary', {}, accCtx(runsHooks([], { accuracy: null, gcp: null }))),
    ).rejects.toThrow('No photo runs in this project yet. Use process_photos to start one.');
    await expect(runRendererTool('accuracy_summary', {}, ctx({}, withLayers([])))).rejects.toThrow(
      'Photo runs are only read in the desktop app.',
    );
  });

  it('caps the points at 30 and the warnings at 10', async () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      id: `P${String(i)}`,
      role: 'check' as const,
      dxM: 0.01 * i,
      dyM: 0,
      dzM: 0,
      reprojPx: 0.5,
      marks: 3,
    }));
    const warnings = Array.from({ length: 15 }, (_, i) => ({
      code: 'other' as const,
      message: `w${String(i)}`,
    }));
    const photoRuns = runsHooks([summary('r1', 'adjusted', true)], {
      accuracy: { ...report, points, warnings },
      gcp,
    });
    const r = await runRendererTool('accuracy_summary', {}, accCtx(photoRuns));
    const res = r.result as { gcp: { points: unknown[] }; warnings: unknown[] };
    expect(res.gcp.points).toHaveLength(30);
    expect(res.warnings).toHaveLength(10);
  });
});
