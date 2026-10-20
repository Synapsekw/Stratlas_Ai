// Volumetric parity W3: old stockpile kit piles open as volume measurements with their figures.
import {
  MeasurementsFile,
  type ComparisonResult,
  type ProjectManifest,
  type SurveyMeasurement,
  type VolumesFile,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertAfterJob,
  forgetMeasureWrites,
  isDirty,
  loadMeasurements,
  measureStore,
  patchMeasurement,
  replaceWithStandard,
  setSeries,
} from './measureStore';

const io = vi.hoisted(() => {
  const saved: MeasurementsFile = { schema: 'aio.measurements/1', measurements: [] };
  return { saved, writes: 0, readOnly: false, volumes: null as VolumesFile | null };
});

function answer(channel: string, payload: { file?: unknown }): unknown {
  if (channel === 'survey:writeMeasurements') {
    io.saved = MeasurementsFile.parse(JSON.parse(JSON.stringify(payload.file)) as unknown);
    io.writes++;
    return { ok: true, value: { ok: true } };
  }
  if (channel === 'survey:readMeasurements')
    return { ok: true, value: { ok: true, file: io.saved, readOnly: io.readOnly } };
  if (channel === 'project:readVolumes')
    return { ok: true, value: { ok: true, volumes: io.volumes, edits: null } };
  return { ok: false, error: 'Not configured' };
}

vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, payload: { file?: unknown }) =>
      Promise.resolve(answer(channel, payload)),
  },
  jobs: { getState: () => ({}) },
}));

const manifest = (type?: ProjectManifest['type']): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Yard',
  crs: { epsg: 32640 },
  origin: [1000, 2000, 50],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
  ...(type ? { type } : {}),
});

const fc = (net: number, cut = 2) => ({ fill: net + cut, cut, net });
const v4 = (net: number) => ({
  tin: fc(net),
  plane: fc(net + 10),
  avg: fc(net + 20),
  low: fc(net + 30),
});
const ring: [number, number][] = [
  [0, 0],
  [4, 0],
  [4, 3],
];
const ep = (captureId: string, net: number) => ({
  captureId,
  areaM2: 100,
  topM: 60,
  heightM: 5,
  ring,
  volumes: v4(net),
});
const pile = (id: string, epochs: Record<string, ReturnType<typeof ep>>) => ({
  id,
  name: `Pile ${id}`,
  zoneRing: ring,
  change: fc(0),
  epochs,
});

function volumes(piles = [pile('P01', { e1: ep('c1', 100), e2: ep('c2', 50) })]): VolumesFile {
  return {
    schema: 'aio.volumes/1',
    densityTPerM3: 1.6,
    deadbandM: 0.1,
    defaultBase: 'plane',
    bases: [{ id: 'plane', label: 'Best-fit toe plane' }],
    captures: [
      { epoch: 'e1', captureId: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
      { epoch: 'e2', captureId: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
    ],
    piles,
    totals: {},
    pileChange: fc(0),
    siteChange: fc(0),
  };
}

const drawn: SurveyMeasurement = {
  id: 'mine',
  family: 'line',
  tool: 'distance',
  label: 'Mine',
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [3, 4, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function open(file: MeasurementsFile, type?: ProjectManifest['type']): Promise<void> {
  io.saved = file;
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest: manifest(type) });
  measureStore.setState({ projectId: null });
  await loadMeasurements('p1');
}

const kitMeasurements = () =>
  measureStore.getState().file.measurements.filter((m) => m.origin?.kind === 'kit-pile');

beforeEach(() => {
  io.saved = { schema: 'aio.measurements/1', measurements: [] };
  io.writes = 0;
  io.readOnly = false;
  io.volumes = null;
  forgetMeasureWrites();
  measureStore.setState({ autosave: false });
});

describe('kit piles on load', () => {
  it('an old project converts with carried figures and saves once', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    const s = measureStore.getState();
    expect(s.status).toBe('ready');
    const [m] = kitMeasurements();
    expect(m?.label).toBe('Pile P01');
    // the kit's figure, unchanged: plane base on the last date
    expect(m?.results[0]?.netM3).toBe(60);
    expect(m?.results[0]?.carried).toMatchObject({ from: 'kit', base: 'plane', pile: 'P01' });
    expect(m?.series).toHaveLength(2);
    // localToEN(origin, [x, z]) with Z 0
    expect(m?.points[1]).toEqual([1004, 2000, 0]);
    expect(s.file.kitPilesConverted).toEqual(['P01']);
    // a conversion, not an edit: written once, nothing shown as unsaved
    expect(io.writes).toBe(1);
    expect(isDirty(s)).toBe(false);
    expect(io.saved.kitPilesConverted).toEqual(['P01']);
    expect(io.saved.measurements.map((x) => x.id)).toContain(m?.id);
    expect(io.saved.measurements.map((x) => x.id)).toContain('mine');
  });

  it('a read-only project converts in memory and writes nothing', async () => {
    io.volumes = volumes();
    io.readOnly = true;
    await open({ schema: 'aio.measurements/1', measurements: [] });
    expect(kitMeasurements()).toHaveLength(1);
    expect(kitMeasurements()[0]?.results[0]?.netM3).toBe(60);
    expect(io.writes).toBe(0);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('reopening converts nothing new', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    expect(io.writes).toBe(1);
    const first = io.saved;
    await open(first);
    expect(io.writes).toBe(1);
    expect(kitMeasurements()).toHaveLength(1);
    expect(measureStore.getState().file).toEqual(first);
  });

  it('a project without kit figures loads as it is', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    expect(io.writes).toBe(0);
    expect(measureStore.getState().file.kitPilesConverted).toBeUndefined();
  });

  it('a new volumetric project before its build is never treated as an old one', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [] }, 'volumetric');
    expect(io.saved.kitPilesConverted).toEqual([]);
    expect(io.writes).toBe(1);
    // the build finishes while the project is closed: the next open carries nothing
    io.volumes = volumes();
    await open(io.saved, 'volumetric');
    const [m] = kitMeasurements();
    expect(m?.results).toEqual([]);
    expect(m?.series).toBeUndefined();
  });
});

describe('after a volumetric job', () => {
  it('after a volumetric job new piles have no carried figure', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    // a rebuild finds a new pile
    io.volumes = volumes([
      pile('P01', { e1: ep('c1', 100), e2: ep('c2', 50) }),
      pile('P03', { e2: ep('c2', 7) }),
    ]);
    await convertAfterJob('p1');
    const added = kitMeasurements().find((m) => m.origin?.pile === 'P03');
    expect(added?.results).toEqual([]);
    expect(added?.series).toBeUndefined();
    expect(added?.items).toHaveLength(1);
    expect(kitMeasurements()).toHaveLength(2);
    expect(measureStore.getState().file.kitPilesConverted).toEqual(['P01', 'P03']);
    expect(io.writes).toBe(2);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it("keeps the person's unsaved edits unsaved and off the disk", async () => {
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    patchMeasurement('mine', { label: 'Renamed' });
    io.volumes = volumes();
    await convertAfterJob('p1');
    expect(io.saved.measurements.find((m) => m.id === 'mine')?.label).toBe('Mine');
    expect(io.saved.kitPilesConverted).toEqual(['P01']);
    const s = measureStore.getState();
    expect(s.file.measurements.find((m) => m.id === 'mine')?.label).toBe('Renamed');
    expect(isDirty(s)).toBe(true);
  });

  it('another project leaves the open one alone', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [] });
    io.volumes = volumes();
    await convertAfterJob('other');
    expect(kitMeasurements()).toHaveLength(0);
  });
});

const result = (over: Partial<ComparisonResult>): ComparisonResult => ({
  item: 'i1',
  status: 'ok',
  cutM3: 1,
  fillM3: 11,
  netM3: 10,
  totalM3: 12,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 0,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Smart',
  toLabel: '10 Jan 2021',
  toCapture: 'c2',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.1,
  engine: 'ts',
  fingerprint: 'f',
  computedAt: '2026-10-20T00:00:00.000Z',
  ...over,
});

describe('recompute with the standard base', () => {
  it('recomputeStandard replaces the figure and keeps was', () => {
    const carried = result({
      netM3: 60,
      totalM3: 64,
      fingerprint: 'kit:P01:e2:plane',
      carried: { from: 'kit', base: 'plane', pile: 'P01', epoch: 'e2' },
    });
    const older = result({
      toCapture: 'c1',
      fingerprint: 'kit:P01:e1:plane',
      carried: { from: 'kit', base: 'plane', pile: 'P01', epoch: 'e1' },
    });
    const engineDate = result({ toCapture: 'c0', fingerprint: 'engine' });
    const m: SurveyMeasurement = {
      ...drawn,
      id: 'k',
      family: 'polygon',
      tool: 'volume',
      items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      results: [carried],
      series: [older, carried, engineDate],
    };
    const fresh = result({ netM3: 58.5, totalM3: 61, computedAt: '2026-10-20T10:00:00.000Z' });
    const next = replaceWithStandard(m, fresh);
    expect(next.results).toEqual([fresh]);
    expect(next.previousResults).toEqual([
      { netM3: 60, totalM3: 64, label: 'kit plane', replacedAt: '2026-10-20T10:00:00.000Z' },
    ]);
    expect(next.series).toEqual([engineDate]);
    // the input is not changed
    expect(m.results).toEqual([carried]);
  });
});

describe('setSeries', () => {
  it('stores per date, replaces the same item and date, and is not an edit', async () => {
    const m: SurveyMeasurement = {
      ...drawn,
      id: 'k',
      family: 'polygon',
      tool: 'volume',
      items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      series: [result({ toCapture: 'c1', netM3: 1 })],
    };
    await open({ schema: 'aio.measurements/1', measurements: [m] });
    setSeries('k', [result({ toCapture: 'c1', netM3: 2 }), result({ toCapture: 'c2', netM3: 3 })]);
    const s = measureStore.getState();
    const series = s.file.measurements[0]?.series ?? [];
    expect(series.map((r) => [r.toCapture, r.netM3])).toEqual([
      ['c1', 2],
      ['c2', 3],
    ]);
    expect(isDirty(s)).toBe(false);
    expect(s.resultsUnwritten).toBe(true);
  });
});
