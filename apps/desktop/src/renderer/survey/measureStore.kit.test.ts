// Volumetric parity W3: old stockpile kit piles open as volume measurements with their figures.
import {
  MeasurementsFile,
  type ComparisonResult,
  type HeightTiles,
  type ProjectManifest,
  type SurveyMeasurement,
  type VolumesFile,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { pileMaterial } from '@aio/survey';
import { pileFigures } from '../workspace/pileFigures';
import type * as DateSurfaces from './dateSurfaces';
import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptKitQuietly,
  convertAfterJob,
  deleteMeasurements,
  forgetKitDsms,
  forgetMeasureWrites,
  measureInputsKey,
  replaceMeasurements,
  undoMeasureChange,
  isDirty,
  loadMeasurements,
  markBeforeBuild,
  markForStockpileBuild,
  measureStore,
  patchMeasurement,
  repairKitHeightsNow,
  replaceWithStandard,
  saveMeasurements,
  setSeries,
} from './measureStore';

const io = vi.hoisted(() => {
  const saved: MeasurementsFile = { schema: 'aio.measurements/1', measurements: [] };
  return {
    saved,
    writes: 0,
    readOnly: false,
    volumes: null as VolumesFile | null,
    /** While set, a write waits for it. */
    gate: null as Promise<void> | null,
    /** While set, a write is refused. */
    writeFails: false,
    /** The kit DSMs on disk: one height (m) per epoch. */
    dsm: new Map<string, number>(),
    /** The folder the kit DSMs are in. */
    dsmDir: 'legacy/data',
    /** The prepared surface's height under every point (null: no surface). */
    ground: null as number | null,
  };
});

vi.mock('./dateSurfaces', async (importOriginal) => ({
  ...(await importOriginal<typeof DateSurfaces>()),
  groundAt: (_capture: string, drawn: readonly unknown[]) =>
    Promise.resolve(new Float64Array(drawn.length).fill(io.ground ?? Number.NaN)),
}));

/** A kit `data/dsm_<epoch>.js` of one height (m) over E 990..1020, N 1980..2010 at 1 m. */
function dsmScript(epoch: string, heightM: number): string {
  const w = 30;
  const h = 30;
  // row-wise deltas: the first cell of each row holds the value, the rest 0
  const d = new Int16Array(w * h);
  for (let y = 0; y < h; y++) d[y * w] = Math.round((heightM - 50) * 100);
  const b64 = (u: Uint8Array) => deflateSync(Buffer.from(u.buffer)).toString('base64');
  return `window.VS_DSM=window.VS_DSM||{};window.VS_DSM["${epoch}"]=${JSON.stringify({
    res: 1,
    w,
    h,
    x0: 990,
    y1: 2010,
    zoff: 50,
    z: b64(new Uint8Array(d.buffer)),
    valid: b64(new Uint8Array(Math.ceil((w * h) / 8)).fill(255)),
  })};`;
}

const DSM_URL = /^aio:\/\/project\/p1\/(.+)\/dsm_(\w+)\.js$/;
const dsmFetch = vi.fn((url: string) => {
  const [, dir, epoch = ''] = DSM_URL.exec(url) ?? [];
  const height = dir === io.dsmDir ? io.dsm.get(epoch) : undefined;
  return Promise.resolve(
    height === undefined
      ? new Response(null, { status: 404 })
      : new Response(dsmScript(epoch, height)),
  );
});

function answer(channel: string, payload: { file?: unknown }): unknown {
  if (channel === 'survey:writeMeasurements') {
    if (io.writeFails) return { ok: true, value: { ok: false, error: 'Disk full' } };
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
    call: async (channel: string, payload: { file?: unknown }) => {
      if (channel === 'survey:writeMeasurements' && io.gate) await io.gate;
      return answer(channel, payload);
    },
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
  io.gate = null;
  io.writeFails = false;
  io.dsm = new Map();
  io.dsmDir = 'legacy/data';
  io.ground = null;
  dsmFetch.mockClear();
  vi.stubGlobal('fetch', dsmFetch);
  forgetMeasureWrites();
  forgetKitDsms();
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
    // the pile names no material and the site has none: the kit's density stays, so the card,
    // the Volumes view and its CSV still show tonnes
    // worked out at read time: no material id is stored, the site's materials are untouched
    expect(m?.material).toBeUndefined();
    expect(s.settings.materials).toEqual([]);
    expect(s.kitDensity?.densityTPerM3).toBe(1.6);
    expect(pileMaterial(m ?? drawn, s.settings.materials, s.kitDensity)?.densityTPerM3).toBe(1.6);
    const figures = pileFigures(io.volumes, s.file.measurements, s.settings, []);
    expect(figures.P01?.e2?.tonnes).toContain('96');
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

  it('opening a project without kit data writes nothing; the mark goes with the first save', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    const s = measureStore.getState();
    // marked in memory only, and not an edit
    expect(s.file.kitPilesConverted).toEqual([]);
    expect(isDirty(s)).toBe(false);
    expect(io.writes).toBe(0);
    expect(io.saved.kitPilesConverted).toBeUndefined();
    expect(await saveMeasurements()).toBe(true);
    expect(io.saved.kitPilesConverted).toEqual([]);
    expect(io.saved.measurements.map((m) => m.id)).toEqual(['mine']);
  });

  it('a read-only project without kit figures writes nothing', async () => {
    io.readOnly = true;
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    expect(io.writes).toBe(0);
    expect(measureStore.getState().file.kitPilesConverted).toBeUndefined();
  });

  for (const type of ['volumetric', 'inspection', undefined] as const)
    it(`a new ${type ?? 'untyped'} project is marked when its stockpile build starts`, async () => {
      await open({ schema: 'aio.measurements/1', measurements: [] }, type);
      expect(io.writes).toBe(0);
      await markForStockpileBuild('p1');
      expect(io.saved.kitPilesConverted).toEqual([]);
      expect(io.writes).toBe(1);
      expect(isDirty(measureStore.getState())).toBe(false);
      // the build finishes while the project is closed: the next open carries nothing
      io.volumes = volumes();
      await open(io.saved, type);
      const [m] = kitMeasurements();
      expect(m?.results).toEqual([]);
      expect(m?.series).toBeUndefined();
    });

  it('a build started for a project the store has not loaded marks its file on disk', async () => {
    io.saved = { schema: 'aio.measurements/1', measurements: [drawn] };
    measureStore.setState({ projectId: null, status: 'idle' });
    await markForStockpileBuild('p1');
    expect(io.writes).toBe(1);
    expect(io.saved.kitPilesConverted).toEqual([]);
    expect(io.saved.measurements.map((m) => m.id)).toEqual(['mine']);
    // marked already: nothing more
    await markForStockpileBuild('p1');
    expect(io.writes).toBe(1);
  });

  it('only a stockpile build of the open project marks it, by its folder', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [] });
    await markBeforeBuild('survey.prepare', 'E:/p1');
    await markBeforeBuild('volumetric.build', 'E:/other');
    expect(io.writes).toBe(0);
    await markBeforeBuild('volumetric.build', 'e:\\p1\\');
    expect(io.writes).toBe(1);
    expect(io.saved.kitPilesConverted).toEqual([]);
  });

  it('a build started where kit data or a mark is already on disk writes nothing', async () => {
    io.volumes = volumes();
    measureStore.setState({ projectId: null, status: 'idle' });
    await markForStockpileBuild('p1');
    expect(io.writes).toBe(0);
    io.volumes = null;
    await open({ schema: 'aio.measurements/1', measurements: [], kitPilesConverted: ['P01'] });
    await markForStockpileBuild('p1');
    expect(io.writes).toBe(0);
  });

  it('a deleted converted measurement stays gone after a reopen, and comes back after a build', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const id = kitMeasurements()[0]?.id ?? '';
    deleteMeasurements([id]);
    expect(await saveMeasurements()).toBe(true);
    await open(io.saved);
    expect(kitMeasurements()).toHaveLength(0);
    // Detect piles found it again with no measurement over it: the lesser evil is to add it
    // back (a number alone never stands for a pile, KNOWN-LIMITS)
    await convertAfterJob('p1');
    expect(kitMeasurements().map((m) => m.origin?.pile)).toEqual(['P01']);
    expect(kitMeasurements()[0]?.results).toEqual([]);
    expect(io.saved.measurements).toHaveLength(1);
    expect(io.saved.kitPilesConverted).toEqual(['P01']);
  });
});

const zs = (m: SurveyMeasurement | undefined) => m?.points.map((p) => p[2]);

describe('kit pile heights', () => {
  it('a writable open converts with real heights and writes once', async () => {
    io.volumes = volumes();
    io.dsm = new Map([
      ['e1', 51],
      ['e2', 52],
    ]);
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const [m] = kitMeasurements();
    // the outline is the e2 toe line, draped on the e2 DSM
    expect(zs(m)).toEqual([52, 52, 52]);
    expect(io.writes).toBe(1);
    expect(zs(io.saved.measurements[0])).toEqual([52, 52, 52]);
    // a conversion with heights is not a repair
    expect(io.saved.kitHeightsRepaired).toBeUndefined();
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('an earlier conversion with Z 0 is repaired once and listed; a reopen writes nothing', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    const [before] = kitMeasurements();
    expect(zs(before)).toEqual([0, 0, 0]);
    expect(io.writes).toBe(1);
    // the build's DSMs are there now
    io.dsm = new Map([
      ['e1', 51],
      ['e2', 52],
    ]);
    await open(io.saved);
    const [after] = kitMeasurements();
    expect(zs(after)).toEqual([52, 52, 52]);
    expect(io.writes).toBe(2);
    expect(io.saved.kitHeightsRepaired).toEqual([before?.id]);
    expect(zs(io.saved.measurements.find((x) => x.id === before?.id))).toEqual([52, 52, 52]);
    // a migration, not an edit: the figures and their dates stay as they were
    expect(after?.results).toEqual(before?.results);
    expect(after?.series).toEqual(before?.series);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(isDirty(measureStore.getState())).toBe(false);
    await open(io.saved);
    expect(io.writes).toBe(2);
  });

  it('a pile a person edited is never re-heighted', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const [m] = kitMeasurements();
    const points = (m?.points ?? []).map((p, i): [number, number, number] =>
      i === 0 ? [p[0], p[1], 49] : p,
    );
    patchMeasurement(m?.id ?? '', { points });
    expect(await saveMeasurements()).toBe(true);
    const writes = io.writes;
    io.dsm = new Map([['e2', 52]]);
    await open(io.saved);
    expect(zs(kitMeasurements()[0])).toEqual([49, 0, 0]);
    expect(io.writes).toBe(writes);
    expect(io.saved.kitHeightsRepaired).toBeUndefined();
  });

  it('a read-only open repairs in memory only', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const writes = io.writes;
    io.readOnly = true;
    io.dsm = new Map([['e2', 52]]);
    await open(io.saved);
    expect(zs(kitMeasurements()[0])).toEqual([52, 52, 52]);
    expect(io.writes).toBe(writes);
    expect(io.saved.kitHeightsRepaired).toBeUndefined();
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('a project without kit data reads no DSM', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    expect(dsmFetch).not.toHaveBeenCalled();
  });

  it('convertAfterJob drapes the new piles', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    io.dsm = new Map([['e2', 52]]);
    const east = ring.map(([x, z]) => [x + 10, z] as [number, number]);
    io.volumes = volumes([
      pile('P01', { e1: ep('c1', 100), e2: ep('c2', 50) }),
      pile('P03', { e2: { ...ep('c2', 7), ring: east } }),
    ]);
    await convertAfterJob('p1');
    const added = kitMeasurements().find((m) => m.origin?.pile === 'P03');
    expect(zs(added)).toEqual([52, 52, 52]);
    expect(zs(io.saved.measurements.find((m) => m.id === added?.id))).toEqual([52, 52, 52]);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('a repair never marks the project unsaved', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    patchMeasurement('mine', { label: 'Renamed' });
    // no kit DSM: the prepared surface of the pile's date, once surfaces exist
    io.ground = 53;
    const id = kitMeasurements()[0]?.id;
    expect(await repairKitHeightsNow('p1')).toEqual([id]);
    const s = measureStore.getState();
    expect(zs(kitMeasurements()[0])).toEqual([53, 53, 53]);
    expect(io.saved.kitHeightsRepaired).toEqual([id]);
    expect(zs(io.saved.measurements.find((m) => m.id === id))).toEqual([53, 53, 53]);
    // the person's edit stays theirs: unsaved, and off the disk
    expect(io.saved.measurements.find((m) => m.id === 'mine')?.label).toBe('Mine');
    expect(s.file.measurements.find((m) => m.id === 'mine')?.label).toBe('Renamed');
    expect(isDirty(s)).toBe(true);
    expect(await saveMeasurements()).toBe(true);
    expect(isDirty(measureStore.getState())).toBe(false);
    // once only
    expect(await repairKitHeightsNow('p1')).toEqual([]);
  });

  it('repairKitHeightsNow in a read-only project repairs in memory only', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const writes = io.writes;
    io.readOnly = true;
    await open(io.saved);
    io.ground = 53;
    expect(await repairKitHeightsNow('p1')).toHaveLength(1);
    expect(zs(kitMeasurements()[0])).toEqual([53, 53, 53]);
    expect(io.writes).toBe(writes);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('an import that names its grids has its DSMs read from there', async () => {
    io.volumes = {
      ...volumes(),
      grids: {
        format: 'vs-kit-js',
        piles: 'volumes/grids/piles/{id}.js',
        dsm: 'volumes/grids/dsm_{epoch}.js',
      },
    };
    io.dsmDir = 'volumes/grids';
    io.dsm = new Map([['e2', 52]]);
    await open({ schema: 'aio.measurements/1', measurements: [] });
    expect(zs(kitMeasurements()[0])).toEqual([52, 52, 52]);
    expect(dsmFetch).toHaveBeenCalledWith('aio://project/p1/volumes/grids/dsm_e2.js');
  });

  it("only the DSMs of the piles' dates are read, and each is decoded once per project", async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    // the outline is e2's: e1's DSM is never asked for
    expect(dsmFetch.mock.calls.map(([u]) => u)).toEqual(['aio://project/p1/legacy/data/dsm_e2.js']);
    io.readOnly = true;
    io.dsm = new Map([
      ['e1', 51],
      ['e2', 52],
    ]);
    dsmFetch.mockClear();
    await open(io.saved);
    expect(zs(kitMeasurements()[0])).toEqual([52, 52, 52]);
    expect(dsmFetch).toHaveBeenCalledTimes(1);
    // opened again (read-only: the repair stays in memory, so it is wanted again): not decoded again
    await open(io.saved);
    expect(zs(kitMeasurements()[0])).toEqual([52, 52, 52]);
    expect(dsmFetch).toHaveBeenCalledTimes(1);
  });

  it('a repair that found nothing is not made again until the prepared surfaces change', async () => {
    const { compareStore } = await import('./compareStore');
    compareStore.setState({ surfaces: [] });
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    dsmFetch.mockClear();
    expect(await repairKitHeightsNow('p1')).toEqual([]);
    expect(dsmFetch).toHaveBeenCalledTimes(1);
    // the surfaces read again, unchanged (each prepare job's end)
    compareStore.setState({ surfaces: [] });
    expect(await repairKitHeightsNow('p1')).toEqual([]);
    expect(dsmFetch).toHaveBeenCalledTimes(1);
    // a date's surface prepared: looked at again
    io.ground = 53;
    compareStore.setState({
      surfaces: [{ capture: 'c2' } as unknown as HeightTiles],
    });
    expect(await repairKitHeightsNow('p1')).toHaveLength(1);
    expect(zs(kitMeasurements()[0])).toEqual([53, 53, 53]);
  });

  it('a repair outlives Undo of an earlier replacement', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    const pile = kitMeasurements()[0];
    if (!pile) throw new Error('no pile');
    const seq = replaceMeasurements([{ ...pile, label: 'Renamed pile' }], { undoable: true });
    expect(seq).not.toBeNull();
    io.ground = 53;
    expect(await repairKitHeightsNow('p1')).toEqual([pile.id]);
    // an edit elsewhere does not let go of the undo
    patchMeasurement('mine', { label: 'Renamed' });
    expect(undoMeasureChange(seq ?? -1)).toBe(true);
    const back = kitMeasurements()[0];
    expect(back?.label).toBe(pile.label);
    expect(zs(back)).toEqual([53, 53, 53]);
  });
});

describe('the app accepting a converted pile on its own', () => {
  /** The pile accepted: its carried figure replaced by a standard one. */
  const acceptedOf = (m: SurveyMeasurement): SurveyMeasurement => ({
    ...m,
    results: m.results.map((r) => {
      const next = { ...r, netM3: 99, fingerprint: 'engine' };
      delete next.carried;
      return next;
    }),
  });

  it('a vertex moved and not saved: the figures for it go on the file only', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const pile = kitMeasurements()[0];
    if (!pile) throw new Error('no pile');
    const writes = io.writes;
    const points = pile.points.map((p, i): [number, number, number] =>
      i === 0 ? [p[0] + 1, p[1], p[2]] : p,
    );
    patchMeasurement(pile.id, { points });
    const moved = kitMeasurements()[0];
    if (!moved) throw new Error('no pile');
    const a = acceptedOf(moved);
    expect(await acceptKitQuietly('p1', [{ m: a, key: measureInputsKey(moved) }])).toEqual([
      pile.id,
    ]);
    expect(kitMeasurements()[0]?.results[0]?.netM3).toBe(99);
    // the baseline is the pile as saved, with its outline: the figures are not its own
    expect(io.writes).toBe(writes);
    expect(io.saved.measurements[0]?.results[0]?.carried).toBeDefined();
  });

  it('a pile edited after its figures were computed takes none of them', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const pile = kitMeasurements()[0];
    if (!pile) throw new Error('no pile');
    const key = measureInputsKey(pile);
    const points = pile.points.map((p, i): [number, number, number] =>
      i === 0 ? [p[0] + 1, p[1], p[2]] : p,
    );
    patchMeasurement(pile.id, { points });
    expect(await acceptKitQuietly('p1', [{ m: acceptedOf(pile), key }])).toEqual([]);
    expect(kitMeasurements()[0]?.results[0]?.carried).toBeDefined();
    // the saved version still has the outline they were computed for
    expect(io.saved.measurements[0]?.results[0]?.carried).toBeUndefined();
    expect(io.saved.measurements[0]?.results[0]?.netM3).toBe(99);
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

  it('a rebuild that renumbers the piles relinks the measurement, never duplicates it', async () => {
    io.volumes = volumes();
    await open({ schema: 'aio.measurements/1', measurements: [] });
    const [kept] = kitMeasurements();
    // the rebuild finds a new pile far to the west first, so the old pile is now P02
    const west = (e: ReturnType<typeof ep>) => ({
      ...e,
      ring: ring.map(([x, z]) => [x - 500, z] as [number, number]),
    });
    io.volumes = volumes([
      pile('P01', { e2: west(ep('c2', 7)) }),
      pile('P02', { e1: ep('c1', 100), e2: ep('c2', 50) }),
    ]);
    await convertAfterJob('p1');
    const after = kitMeasurements();
    expect(after).toHaveLength(2);
    expect(after.find((m) => m.id === kept?.id)?.origin?.pile).toBe('P02');
    expect(after.find((m) => m.id !== kept?.id)?.origin?.pile).toBe('P01');
    expect(io.saved.kitPilesConverted).toEqual(['P01', 'P02']);
    expect(io.saved.measurements.find((m) => m.id === kept?.id)?.origin?.pile).toBe('P02');
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

  it('waits for a save in flight, so the conversion never lands before it', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [drawn] });
    patchMeasurement('mine', { label: 'Renamed' });
    let release = (): void => undefined;
    io.gate = new Promise<void>((r) => {
      release = r;
    });
    const saved = saveMeasurements();
    io.volumes = volumes();
    const job = convertAfterJob('p1');
    // let the job read the volumes while the save is held
    await new Promise((r) => setTimeout(r, 0));
    io.gate = null;
    release();
    expect(await saved).toBe(true);
    await job;
    // the last write holds both the person's save and the conversion
    expect(io.saved.measurements.find((m) => m.id === 'mine')?.label).toBe('Renamed');
    expect(io.saved.kitPilesConverted).toEqual(['P01']);
    expect(io.saved.measurements).toHaveLength(2);
    const s = measureStore.getState();
    expect(isDirty(s)).toBe(false);
    expect(s.saving).toBe(false);
  });

  it('a file never marked converts after a build without carrying', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [] });
    // as an older build left it: no kitPilesConverted
    const bare: MeasurementsFile = { schema: 'aio.measurements/1', measurements: [] };
    measureStore.setState({ file: bare, savedText: JSON.stringify(bare) });
    io.volumes = volumes();
    await convertAfterJob('p1');
    const [m] = kitMeasurements();
    expect(m?.results).toEqual([]);
    expect(m?.series).toBeUndefined();
    expect(io.saved.kitPilesConverted).toEqual(['P01']);
  });

  it('a refused conversion write says so and stays to be written', async () => {
    await open({ schema: 'aio.measurements/1', measurements: [] });
    io.volumes = volumes();
    io.writeFails = true;
    await convertAfterJob('p1');
    const s = measureStore.getState();
    expect(s.message).toBe('Not saved: Disk full');
    expect(s.resultsUnwritten).toBe(true);
    expect(s.saving).toBe(false);
    expect(kitMeasurements()).toHaveLength(1);
    // the next save writes it
    io.writeFails = false;
    expect(await saveMeasurements()).toBe(true);
    expect(io.saved.kitPilesConverted).toEqual(['P01']);
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
      {
        netM3: 60,
        totalM3: 64,
        label: 'kit, Best-fit plane',
        replacedAt: '2026-10-20T10:00:00.000Z',
      },
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

  it('keys an item that runs from current by its from date', async () => {
    const m: SurveyMeasurement = {
      ...drawn,
      id: 'k',
      family: 'polygon',
      tool: 'volume',
      items: [
        {
          id: 'i1',
          from: { kind: 'current' },
          to: { kind: 'smart' },
          useDeadband: false,
        },
      ],
    };
    await open({ schema: 'aio.measurements/1', measurements: [m] });
    const fromDate = (c: string, netM3: number) => {
      const r = result({ fromCapture: c, netM3 });
      delete r.toCapture;
      return r;
    };
    setSeries('k', [fromDate('c1', 1), fromDate('c2', 2)]);
    setSeries('k', [fromDate('c1', 5)]);
    const series = measureStore.getState().file.measurements[0]?.series ?? [];
    expect(series.map((r) => [r.fromCapture, r.netM3])).toEqual([
      ['c1', 5],
      ['c2', 2],
    ]);
  });
});
