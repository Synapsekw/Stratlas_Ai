/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures are edited at known indexes */
import {
  DEFAULT_RF_STUDY,
  RF_CATALOGUE_SCHEMA,
  RF_RUN_SCHEMA,
  RF_SECTORS_SCHEMA,
  type RfCatalogueEntry,
  type RfRun,
  type RfSectorsFile,
} from '@aio/schema';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRf, rfBuiltinDir, type RfDeps } from './rf';
import { readGridTiff, writeGridTiff, type GridGeo } from './rf/export';

const antenna: RfCatalogueEntry = {
  kind: 'antenna',
  id: 'generic-65-18',
  vendor: 'Generic',
  model: 'Generic 65 degree, 18 dBi',
  source: 'user',
  verified: false,
  ports: [
    {
      id: 'p1',
      bandRangeMhz: [1710, 2690],
      gainDbi: 18,
      hBeamwidthDeg: 65,
      vBeamwidthDeg: 7,
      frontToBackDb: 28,
      etilt: { minDeg: 0, maxDeg: 10, stepDeg: 1 },
      patterns: [{ frequencyMhz: 1800, etiltDeg: 2, file: 'patterns/generic-65-18-1800-2.msi' }],
    },
  ],
};
const radio: RfCatalogueEntry = {
  kind: 'radio',
  id: 'generic-rru-2t2r',
  vendor: 'Generic',
  model: 'Generic 2T2R RRU',
  source: 'user',
  verified: false,
  bandRangeMhz: [1710, 1880],
  txPorts: 2,
  rxPorts: 2,
  maxPowerDbmPerPort: 46,
  maxBandwidthMhz: 20,
  mounting: 'tower',
};
const aau: RfCatalogueEntry = {
  kind: 'aau',
  id: 'generic-aau-64t',
  vendor: 'Generic',
  model: 'Generic 64T64R AAU',
  source: 'user',
  verified: false,
  bandRangeMhz: [3300, 3800],
  ports: 64,
  totalPowerDbm: 53,
  ssbGainDbi: 17,
  ssbHBeamwidthDeg: 65,
  ssbVBeamwidthDeg: 12,
  etilt: { minDeg: 0, maxDeg: 12, stepDeg: 1 },
};

const catalogueFile = (...entries: RfCatalogueEntry[]) => ({
  schema: RF_CATALOGUE_SCHEMA,
  entries,
});

const sectors = (): RfSectorsFile => ({
  schema: RF_SECTORS_SCHEMA,
  sectors: [
    { id: 'sec-1', name: 'S1', antennaIds: ['ant-a'] },
    { id: 'sec-2', name: 'S2', antennaIds: ['ant-c'] },
  ],
  antennas: [
    {
      antennaId: 'ant-a',
      equipment: { kind: 'separate', antenna: 'generic-65-18', radio: 'generic-rru-2t2r' },
      etiltDeg: 4,
      active: true,
      carriers: [
        {
          id: 'c1',
          radioUnit: 'generic-rru-2t2r',
          port: 'p1',
          tech: 'lte',
          band: 'B3',
          bandwidthMhz: 20,
          feederLossDb: 0.5,
        },
      ],
    },
    {
      antennaId: 'ant-c',
      equipment: { kind: 'aau', aau: 'generic-aau-64t' },
      etiltDeg: 6,
      active: true,
      carriers: [
        { id: 'c1', tech: 'nr', band: 'n78', bandwidthMhz: 100, scsKhz: 30, feederLossDb: 0 },
      ],
    },
  ],
  study: DEFAULT_RF_STUDY,
});

let base: string;
let root: string;
let userDir: string;
let builtinDir: string;
let deps: RfDeps;
let saves: string[];
let nextSave: string | null;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-rf-'));
  root = join(base, 'proj');
  userDir = join(base, 'userData', 'rf-catalogue');
  builtinDir = join(base, 'builtin');
  await mkdir(root, { recursive: true });
  await mkdir(join(builtinDir, 'patterns'), { recursive: true });
  await writeFile(
    join(builtinDir, 'core.json'),
    JSON.stringify(catalogueFile(antenna, radio, aau)),
  );
  await writeFile(join(builtinDir, 'patterns', 'generic-65-18-1800-2.msi'), 'MSI');
  saves = [];
  nextSave = join(base, 'out', 'export');
  deps = {
    userDir,
    builtinDir,
    projects: {
      root: (id) => (id === 'p' ? root : undefined),
      package: () => undefined,
    },
    choose: (name) => {
      saves.push(name);
      return Promise.resolve(nextSave === null ? null : `${nextSave}-${name}`);
    },
  };
  await mkdir(join(base, 'out'), { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const sectorsPath = () => join(root, 'rf', 'sectors.json');

describe('rf:readSectors and rf:writeSectors', () => {
  it('writes then reads the same file, keeping a .bak of the previous one', async () => {
    const rf = createRf(deps);
    expect(await rf.readSectors({ projectId: 'p' })).toEqual({
      ok: true,
      file: null,
      readOnly: false,
      orphans: [],
    });
    expect(await rf.writeSectors({ projectId: 'p', file: sectors() })).toEqual({ ok: true });
    const first = await rf.readSectors({ projectId: 'p' });
    expect(first).toMatchObject({ ok: true, readOnly: false, file: sectors() });
    const next = sectors();
    next.sectors[0]!.name = 'North';
    expect(await rf.writeSectors({ projectId: 'p', file: next })).toEqual({ ok: true });
    const bak = JSON.parse(await readFile(`${sectorsPath()}.bak`, 'utf8')) as RfSectorsFile;
    expect(bak.sectors[0]?.name).toBe('S1');
    const disk = JSON.parse(await readFile(sectorsPath(), 'utf8')) as RfSectorsFile;
    expect(disk.sectors[0]?.name).toBe('North');
    expect((await readdir(join(root, 'rf'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a file saved by a newer version, on read and on write, and leaves it alone', async () => {
    const rf = createRf(deps);
    await mkdir(join(root, 'rf'), { recursive: true });
    const family = 'aio.rf-sectors';
    const newer = JSON.stringify({ schema: `${family}/${String(2)}`, sectors: [], antennas: [] });
    await writeFile(sectorsPath(), newer);
    const read = await rf.readSectors({ projectId: 'p' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/newer|update/i);
    const write = await rf.writeSectors({ projectId: 'p', file: sectors() });
    expect(write.ok).toBe(false);
    expect(await readFile(sectorsPath(), 'utf8')).toBe(newer);
  });

  it('refuses a package, and reads one in place as read only', async () => {
    const members = new Map<string, Buffer>([
      ['rf/sectors.json', Buffer.from(JSON.stringify(sectors()))],
    ]);
    const pkg = {
      archive: {
        entries: new Map([...members.keys()].map((k) => [k, {}])),
        read: (n: string) => Promise.resolve(members.get(n) ?? Buffer.alloc(0)),
      },
    };
    const rf = createRf({ ...deps, projects: { root: () => undefined, package: () => pkg } });
    const w = await rf.writeSectors({ projectId: 'p', file: sectors() });
    expect(w).toMatchObject({ ok: false, code: 'read-only' });
    const r = await rf.readSectors({ projectId: 'p' });
    expect(r).toMatchObject({ ok: true, readOnly: true, file: sectors() });
  });

  it('refuses an e-tilt that is outside the catalogue range, and says why', async () => {
    const rf = createRf(deps);
    const bad = sectors();
    bad.antennas[0]!.etiltDeg = 15;
    const w = await rf.writeSectors({ projectId: 'p', file: bad });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatch(/E-tilt 15/);
    await expect(readFile(sectorsPath(), 'utf8')).rejects.toThrow();
  });

  it('refuses an AAU carrier that names a radio', async () => {
    const rf = createRf(deps);
    const bad = sectors();
    bad.antennas[1]!.carriers[0]!.radioUnit = 'generic-rru-2t2r';
    const w = await rf.writeSectors({ projectId: 'p', file: bad });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatch(/AAU/);
  });

  it('refuses equipment that is in no catalogue', async () => {
    const rf = createRf(deps);
    const bad = sectors();
    bad.antennas[0]!.equipment = { kind: 'separate', antenna: 'no-such-panel' };
    const w = await rf.writeSectors({ projectId: 'p', file: bad });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatch(/no-such-panel/);
  });

  it('copies the catalogue entries it uses, and their pattern files, into the project', async () => {
    const rf = createRf(deps);
    await rf.writeSectors({ projectId: 'p', file: sectors() });
    const cat = JSON.parse(await readFile(join(root, 'rf', 'catalogue.json'), 'utf8')) as {
      schema: string;
      entries: { id: string }[];
    };
    expect(cat.schema).toBe(RF_CATALOGUE_SCHEMA);
    expect(cat.entries.map((e) => e.id).sort()).toEqual([
      'generic-65-18',
      'generic-aau-64t',
      'generic-rru-2t2r',
    ]);
    expect(await readFile(join(root, 'rf', 'patterns', 'generic-65-18-1800-2.msi'), 'utf8')).toBe(
      'MSI',
    );
  });

  it('keeps the project copy of an entry when the catalogue later changes', async () => {
    const rf = createRf(deps);
    await rf.writeSectors({ projectId: 'p', file: sectors() });
    const changed = { ...radio, maxPowerDbmPerPort: 30 } as RfCatalogueEntry;
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'user.json'), JSON.stringify(catalogueFile(changed)));
    await rf.writeSectors({ projectId: 'p', file: sectors() });
    const cat = JSON.parse(await readFile(join(root, 'rf', 'catalogue.json'), 'utf8')) as {
      entries: { id: string; maxPowerDbmPerPort?: number }[];
    };
    expect(cat.entries.find((e) => e.id === 'generic-rru-2t2r')?.maxPowerDbmPerPort).toBe(46);
  });

  it('flags orphans on read and never deletes their settings on write (D9)', async () => {
    const rf = createRf(deps);
    await rf.writeSectors({ projectId: 'p', file: sectors() });
    await mkdir(join(root, 'telecom'), { recursive: true });
    await writeFile(
      join(root, 'telecom', 'antennas.json'),
      JSON.stringify({
        schema: ['aio.antennas', '1'].join('/'),
        units: [
          { id: 'ant-a', status: 'accepted' },
          { id: 'ant-c', status: 'rejected' },
        ],
      }),
    );
    const read = await rf.readSectors({ projectId: 'p' });
    expect(read).toMatchObject({ ok: true, orphans: ['ant-c'] });
    // a unit detection no longer finds, and one that is gone altogether
    await writeFile(
      join(root, 'telecom', 'antennas.json'),
      JSON.stringify({ units: [{ id: 'ant-a', status: 'draft', notFoundInLatest: true }] }),
    );
    const again = await rf.readSectors({ projectId: 'p' });
    expect(again).toMatchObject({ ok: true, orphans: ['ant-a', 'ant-c'] });
    await rf.writeSectors({ projectId: 'p', file: sectors() });
    const disk = JSON.parse(await readFile(sectorsPath(), 'utf8')) as RfSectorsFile;
    expect(disk.antennas.map((a) => a.antennaId)).toEqual(['ant-a', 'ant-c']);
  });
});

describe('rf:writeSectors with a project catalogue it cannot read', () => {
  const catalogueText = {
    newer: JSON.stringify({ schema: 'aio.rf.catalogue/2', entries: [], future: true }),
    invalid: '{ "schema": "aio.rf.catalogue/1", "entries": 7 }',
    garbled: '{ nope',
  };

  for (const [name, text] of Object.entries(catalogueText)) {
    it(`refuses the save and leaves a ${name} rf/catalogue.json byte identical`, async () => {
      const rf = createRf(deps);
      await mkdir(join(root, 'rf'), { recursive: true });
      const path = join(root, 'rf', 'catalogue.json');
      await writeFile(path, text);
      const before = await readFile(path);
      const w = await rf.writeSectors({ projectId: 'p', file: sectors() });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.error).toContain('rf/catalogue.json');
      expect((await readFile(path)).equals(before)).toBe(true);
      expect(await readdir(join(root, 'rf'))).toEqual(['catalogue.json']);
    });
  }
});

describe('rf:listCatalogue', () => {
  it('lists built in, own and project entries with their origin', async () => {
    const rf = createRf(deps);
    await mkdir(userDir, { recursive: true });
    const mine = { ...radio, id: 'my-rru', model: 'Mine' } as RfCatalogueEntry;
    await writeFile(join(userDir, 'user.json'), JSON.stringify(catalogueFile(mine)));
    await mkdir(join(root, 'rf'), { recursive: true });
    const inProject = { ...radio, id: 'proj-rru' } as RfCatalogueEntry;
    await writeFile(join(root, 'rf', 'catalogue.json'), JSON.stringify(catalogueFile(inProject)));
    const r = await rf.listCatalogue({ projectId: 'p' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byOrigin = (o: string) => r.entries.filter((e) => e.origin === o).map((e) => e.entry.id);
    expect(byOrigin('builtin').sort()).toEqual([
      'generic-65-18',
      'generic-aau-64t',
      'generic-rru-2t2r',
    ]);
    expect(byOrigin('user')).toEqual(['my-rru']);
    expect(byOrigin('project')).toEqual(['proj-rru']);
    expect(r.warnings).toEqual([]);
  });

  it('lists without a project, and warns about a file it cannot read but lists the rest', async () => {
    const rf = createRf(deps);
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'broken.json'), '{ nope');
    const r = await rf.listCatalogue({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toHaveLength(3);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/broken\.json/);
  });
});

const msi = (o: { tilt?: string; frequency?: string; vertical?: boolean } = {}): string => {
  const cut = (n: number) => Array.from({ length: n }, (_, i) => `${String(i)} 1.5`).join('\n');
  return [
    'NAME Test panel',
    `FREQUENCY ${o.frequency ?? '2600'}`,
    'GAIN 17.8 dBi',
    `TILT ${o.tilt ?? '4'}`,
    'HORIZONTAL 360',
    cut(360),
    ...(o.vertical === false ? [] : ['VERTICAL 360', cut(360)]),
  ].join('\n');
};

describe('rf:importCatalogue', () => {
  it('attaches an MSI file to a port of an antenna, in the own catalogue', async () => {
    const rf = createRf(deps);
    const file = join(base, 'panel.msi');
    await writeFile(file, msi());
    const r = await rf.importCatalogue({
      path: file,
      format: 'msi',
      attach: { entryId: 'generic-65-18', portId: 'p1' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = r.entries[0];
    expect(entry?.kind).toBe('antenna');
    const refs = entry?.kind === 'antenna' ? entry.ports[0]?.patterns : [];
    expect(refs).toContainEqual({
      frequencyMhz: 2600,
      etiltDeg: 4,
      file: expect.stringMatching(/^patterns\/.+\.msi$/) as string,
    });
    // the file is copied next to the own catalogue and the entry is saved there
    const saved = JSON.parse(await readFile(join(userDir, 'user.json'), 'utf8')) as {
      entries: { id: string }[];
    };
    expect(saved.entries.map((e) => e.id)).toEqual(['generic-65-18']);
    const copied = refs?.find((p) => p.frequencyMhz === 2600)?.file ?? '';
    expect(await readFile(join(userDir, copied), 'utf8')).toBe(msi());
    // the built in entry is untouched
    const list = await rf.listCatalogue({});
    expect(list.ok && list.entries.filter((e) => e.origin === 'builtin')).toHaveLength(3);
  });

  it('replaces a pattern of the same frequency and tilt instead of adding a second', async () => {
    const rf = createRf(deps);
    const file = join(base, 'panel.msi');
    await writeFile(file, msi());
    const attach = { entryId: 'generic-65-18', portId: 'p1' };
    await rf.importCatalogue({ path: file, format: 'msi', attach });
    const r = await rf.importCatalogue({ path: file, format: 'msi', attach });
    expect(r.ok).toBe(true);
    const entry = r.ok ? r.entries[0] : undefined;
    const refs = entry?.kind === 'antenna' ? entry.ports[0]?.patterns : [];
    expect(refs?.filter((p) => p.frequencyMhz === 2600 && p.etiltDeg === 4)).toHaveLength(1);
  });

  it('refuses a file that is missing a cut, or has no target', async () => {
    const rf = createRf(deps);
    const file = join(base, 'panel.msi');
    await writeFile(file, msi({ vertical: false }));
    const attach = { entryId: 'generic-65-18', portId: 'p1' };
    const bad = await rf.importCatalogue({ path: file, format: 'msi', attach });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/VERTICAL/);
    await writeFile(file, msi());
    expect((await rf.importCatalogue({ path: file, format: 'msi' })).ok).toBe(false);
    expect(
      (
        await rf.importCatalogue({
          path: file,
          format: 'msi',
          attach: { entryId: 'generic-65-18', portId: 'nope' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await rf.importCatalogue({
          path: file,
          format: 'msi',
          attach: { entryId: 'generic-rru-2t2r', portId: 'p1' },
        })
      ).ok,
    ).toBe(false);
  });

  it('imports a catalogue file into the own catalogue, replacing entries of the same id', async () => {
    const rf = createRf(deps);
    const dir = join(base, 'incoming');
    await mkdir(join(dir, 'patterns'), { recursive: true });
    const withPattern = JSON.parse(JSON.stringify(antenna)) as RfCatalogueEntry;
    withPattern.id = 'imported-panel';
    await writeFile(join(dir, 'patterns', 'generic-65-18-1800-2.msi'), 'FROM-FILE');
    const file = join(dir, 'cat.json');
    await writeFile(file, JSON.stringify(catalogueFile(withPattern, { ...radio, id: 'imp-rru' })));
    const r = await rf.importCatalogue({ path: file, format: 'catalogue' });
    expect(r.ok && r.entries.map((e) => e.id)).toEqual(['imported-panel', 'imp-rru']);
    expect(await readFile(join(userDir, 'patterns', 'generic-65-18-1800-2.msi'), 'utf8')).toBe(
      'FROM-FILE',
    );
    const again = await rf.importCatalogue({ path: file, format: 'catalogue' });
    expect(again.ok && again.warnings.join(' ')).toMatch(/replaced/i);
    const list = await rf.listCatalogue({});
    expect(list.ok && list.entries.filter((e) => e.origin === 'user')).toHaveLength(2);
  });

  it('refuses a catalogue file from a newer version', async () => {
    const rf = createRf(deps);
    const file = join(base, 'new.json');
    const family = 'aio.rf-catalogue';
    await writeFile(file, JSON.stringify({ schema: `${family}/${String(9)}`, entries: [] }));
    const r = await rf.importCatalogue({ path: file, format: 'catalogue' });
    expect(r.ok).toBe(false);
  });
});

const GEO: GridGeo = {
  crs: 'EPSG:32640',
  resolutionM: 10,
  origin: [500_000, 2_700_000],
  width: 3,
  height: 2,
  nodata: -9999,
};
const RSRP = Float32Array.from([-70, -90, -100, -110, -130, -9999]);
const BEST = Float32Array.from([0, 0, 1, 1, 1, -1]);

function run(id: string, createdAt: string, over: Partial<RfRun> = {}): RfRun {
  return {
    schema: RF_RUN_SCHEMA,
    runId: id,
    createdAt,
    status: 'done',
    inputs: { sectors: sectors(), antennas: [] },
    catalogue: [],
    model: { model: 'tr38901', environment: 'uma' },
    grid: {
      crs: GEO.crs,
      resolutionM: GEO.resolutionM,
      radiusM: 100,
      origin: [...GEO.origin],
      width: GEO.width,
      height: GEO.height,
      nodata: GEO.nodata,
    },
    timings: { totalMs: 5 },
    warnings: [],
    usedUnreviewed: false,
    patterns: [],
    outputs: { rsrp: 'rsrp.tif', bestServer: 'best.tif', overlap: 'overlap.tif' },
    ...over,
  };
}

async function putRun(id: string, createdAt: string, over: Partial<RfRun> = {}): Promise<void> {
  const dir = join(root, 'rf', 'runs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), JSON.stringify(run(id, createdAt, over)));
  await writeFile(join(dir, 'rsrp.tif'), writeGridTiff(RSRP, GEO));
  await writeFile(join(dir, 'best.tif'), writeGridTiff(BEST, GEO));
  await writeFile(join(dir, 'overlap.tif'), writeGridTiff(new Float32Array(6).fill(1), GEO));
}

describe('rf:listRuns and rf:readRun', () => {
  it('lists runs newest first and skips a run it cannot read', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    await putRun('rf-b', '2026-10-05T10:00:00.000Z');
    await mkdir(join(root, 'rf', 'runs', 'rf-bad'), { recursive: true });
    await writeFile(join(root, 'rf', 'runs', 'rf-bad', 'run.json'), '{}');
    const r = await rf.listRuns({ projectId: 'p' });
    expect(r.ok && r.runs.map((x) => x.runId)).toEqual(['rf-b', 'rf-a']);
    const one = await rf.readRun({ projectId: 'p', runId: 'rf-a' });
    expect(one.ok && one.run.runId).toBe('rf-a');
    expect((await rf.readRun({ projectId: 'p', runId: 'rf-zz' })).ok).toBe(false);
  });

  it('answers an empty list for a project with no runs', async () => {
    const rf = createRf(deps);
    expect(await rf.listRuns({ projectId: 'p' })).toEqual({ ok: true, runs: [] });
  });
});

describe('rf:export', () => {
  it('writes a GeoTIFF of the RSRP grid that reads back with the same values and CRS', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    const r = await rf.export({ projectId: 'p', runId: 'rf-a', format: 'geotiff' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.path === null) throw new Error('no path');
    expect(saves).toEqual(['rf-a-rsrp.tif']);
    const back = readGridTiff(await readFile(r.path));
    expect([...back.data]).toEqual([...RSRP]);
    expect(back.epsg).toBe(32640);
    expect(back.nodata).toBe(-9999);
    expect(back.origin).toEqual([500_000, 2_700_000]);
  });

  it('writes the best server grid as a GeoTIFF too', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    const r = await rf.export({
      projectId: 'p',
      runId: 'rf-a',
      format: 'geotiff',
      view: 'bestServer',
    });
    expect(r.ok && r.path).toBeTruthy();
    expect(saves).toEqual(['rf-a-bestServer.tif']);
  });

  it('writes GeoJSON polygons per threshold', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    const r = await rf.export({ projectId: 'p', runId: 'rf-a', format: 'geojson' });
    if (!r.ok || r.path === null) throw new Error('no path');
    const fc = JSON.parse(await readFile(r.path, 'utf8')) as {
      type: string;
      features: { properties: { class: string } }[];
    };
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.map((f) => f.properties.class)).toEqual([
      'poor',
      'fair',
      'good',
      'excellent',
    ]);
    const bad = await rf.export({
      projectId: 'p',
      runId: 'rf-a',
      format: 'geojson',
      view: 'overlap',
    });
    expect(bad.ok).toBe(false);
  });

  it('writes the CSV of class areas per sector', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    const r = await rf.export({ projectId: 'p', runId: 'rf-a', format: 'csv' });
    if (!r.ok || r.path === null) throw new Error('no path');
    const lines = (await readFile(r.path, 'utf8')).trim().split('\r\n');
    expect(lines[1]).toBe('sec-1,S1,100,100,0,0,0,200');
    expect(lines[2]).toBe('sec-2,S2,0,0,100,100,100,200');
  });

  it('answers a null path when the person cancels, and writes nothing', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    nextSave = null;
    expect(await rf.export({ projectId: 'p', runId: 'rf-a', format: 'csv' })).toEqual({
      ok: true,
      path: null,
    });
    expect(await readdir(join(base, 'out'))).toEqual([]);
  });

  it('refuses a failed run, a grid that does not match the run, and a package that bars the format', async () => {
    const rf = createRf(deps);
    await putRun('rf-f', '2026-10-01T10:00:00.000Z', { status: 'failed' });
    expect((await rf.export({ projectId: 'p', runId: 'rf-f', format: 'csv' })).ok).toBe(false);
    await putRun('rf-m', '2026-10-02T10:00:00.000Z');
    await writeFile(
      join(root, 'rf', 'runs', 'rf-m', 'rsrp.tif'),
      writeGridTiff(new Float32Array(4), { ...GEO, width: 2, height: 2 }),
    );
    const mismatch = await rf.export({ projectId: 'p', runId: 'rf-m', format: 'geotiff' });
    expect(mismatch.ok).toBe(false);
    await putRun('rf-a', '2026-10-03T10:00:00.000Z');
    const barred = createRf({
      ...deps,
      refuse: () => 'This package does not allow saving GeoTIFF files.',
    });
    const r = await barred.export({ projectId: 'p', runId: 'rf-a', format: 'geotiff' });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not allow/) as string,
    });
    expect(saves).toEqual([]);
  });

  it('exports from a package, reading the grids in place', async () => {
    const dir = join(root, 'rf', 'runs', 'rf-a');
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    const members = new Map<string, Buffer>();
    for (const f of ['run.json', 'rsrp.tif', 'best.tif', 'overlap.tif'])
      members.set(`rf/runs/rf-a/${f}`, await readFile(join(dir, f)));
    const pkg = {
      archive: {
        entries: new Map([...members.keys()].map((k) => [k, {}])),
        read: (n: string) => Promise.resolve(members.get(n) ?? Buffer.alloc(0)),
      },
    };
    const rf = createRf({ ...deps, projects: { root: () => undefined, package: () => pkg } });
    const list = await rf.listRuns({ projectId: 'p' });
    expect(list.ok && list.runs.map((x) => x.runId)).toEqual(['rf-a']);
    const r = await rf.export({ projectId: 'p', runId: 'rf-a', format: 'geotiff' });
    expect(r.ok && r.path).toBeTruthy();
  });
});

describe('fix round 1', () => {
  it('leaves a pattern that could not be copied out of the project catalogue and warns', async () => {
    const rf = createRf(deps);
    await rm(join(builtinDir, 'patterns', 'generic-65-18-1800-2.msi'));
    const r = await rf.writeSectors({ projectId: 'p', file: sectors() });
    expect(r).toMatchObject({
      ok: true,
      warnings: [expect.stringMatching(/generic-65-18/) as string],
    });
    const cat = JSON.parse(await readFile(join(root, 'rf', 'catalogue.json'), 'utf8')) as {
      entries: { id: string; ports?: { patterns: unknown[] }[] }[];
    };
    const ant = cat.entries.find((e) => e.id === 'generic-65-18');
    expect(ant?.ports?.[0]?.patterns).toEqual([]);
  });

  it('refuses a run whose run.json names another run than its folder', async () => {
    const rf = createRf(deps);
    await putRun('rf-a', '2026-10-01T10:00:00.000Z');
    await mkdir(join(root, 'rf', 'runs', 'rf-b'), { recursive: true });
    await writeFile(
      join(root, 'rf', 'runs', 'rf-b', 'run.json'),
      JSON.stringify(run('rf-a', '2026-10-02T10:00:00.000Z')),
    );
    expect((await rf.readRun({ projectId: 'p', runId: 'rf-b' })).ok).toBe(false);
    const list = await rf.listRuns({ projectId: 'p' });
    expect(list.ok && list.runs.map((x) => x.runId)).toEqual(['rf-a']);
  });

  it('refuses an MSI file with no GAIN', async () => {
    const rf = createRf(deps);
    const file = join(base, 'nogain.msi');
    await writeFile(file, msi().replace('GAIN 17.8 dBi\n', ''));
    const attach = { entryId: 'generic-65-18', portId: 'p1' };
    const r = await rf.importCatalogue({ path: file, format: 'msi', attach });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/GAIN/);
  });
});

describe('rfBuiltinDir', () => {
  const base = { packaged: false, resourcesPath: '/app/resources' };
  it('takes the resources folder once packaged', () => {
    expect(rfBuiltinDir({ ...base, packaged: true, dirname: '/a' })).toBe(
      join('/app/resources', 'rf-catalogue'),
    );
  });
  it('finds packages/rf/catalogue from the built main folder (electron . and electron out/main/index.js)', () => {
    const outMain = resolve(import.meta.dirname, '..', '..', 'out', 'main');
    const dir = rfBuiltinDir({ ...base, dirname: outMain });
    expect(resolve(dir)).toBe(resolve(import.meta.dirname, '../../../../packages/rf/catalogue'));
    expect(existsSync(join(dir, 'vendor.json'))).toBe(true);
  });
});
