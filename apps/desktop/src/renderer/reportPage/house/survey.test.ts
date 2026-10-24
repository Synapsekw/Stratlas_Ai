// @vitest-environment jsdom
// The survey sections (M11 G9) on a small analytic project: flat ground at 100 m on three surveys
// of one 256 m tile at 1 m cells, two box-shaped stockpiles that change by known volumes, a pad
// against a flat design at 101 m, a landfill cell filled by 1 m per survey under a cap at 103 m,
// and a weighbridge log. On aligned cells every volume is the analytic one (section 26: posts are
// read exactly, interior cells have coverage 1) up to the float32 heights of the tiles, so the
// sections, the CSVs and the panel agree to the cubic metre. The polygons carry the results the
// panel stored (an engine result fixture: `compareItem` on the latest survey), as a saved project
// does; the report prints those, and works out the other survey dates in memory as the app does.
import {
  houseReportModel,
  measurementsCsv,
  resolveReportBranding,
  stockpileCsv,
} from '@aio/project/export';
import {
  DesignsFile,
  HeightTiles,
  MeasurementsFile,
  ProjectManifest,
  SurveySettings,
  defaultSurveySettings,
  type ComparisonItem,
  type ComparisonResult,
  type SurveyMeasurement,
  type VolumesFile,
} from '@aio/schema';
import { compareItem, encodeTile, projectResolver } from '@aio/survey';
import { cardModel } from '../../survey/card/cardModel';
import { withSurface } from '../../survey/card/pointHistory';
import { drawnPoints } from '../../survey/measureDates';
import { formatQuantity } from '@aio/geo';
import { Blob as NodeBlob } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { Pager } from './pager';
import { SECTION_LAYOUTS, type HouseContext } from './sections';
import { houseVolumes, measurementPlan, pilePlan } from './survey';
import {
  buildSurveyData,
  readSurveyFiles,
  surveyPlan,
  surveyOrNone,
  surveySectionIds,
  type ReportSurveyData,
  type SurveyFiles,
} from './surveyData';

// jsdom's Blob has no stream(): the engine inflates tiles through Node's, as the app's Chromium does
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true });

const E0 = 500_000;
const N0 = 2_500_000;
const NOW = '2026-10-09T08:00:00Z';
const CAPS = [
  { id: 'c1', label: 'Survey 31 January 2026', date: '2026-01-31' },
  { id: 'c2', label: 'Survey 28 February 2026', date: '2026-02-28' },
  { id: 'c3', label: 'Survey 31 March 2026', date: '2026-03-31' },
];

/** A box of cells [i0, i1) x [j0, j1) raised by `h` on flat ground at 100 m. */
type Box = [number, number, number, number, number];

/** Survey k's heights: the piles grow, the pad comes up towards its design, the cell fills. */
const BOXES: Record<string, Box[]> = {
  c1: [
    [25, 35, 25, 35, 2],
    [65, 75, 65, 75, 1],
    [180, 220, 180, 220, 0],
  ],
  c2: [
    [25, 35, 25, 35, 3],
    [65, 75, 65, 75, 1],
    [100, 140, 100, 140, 0.5],
    [180, 220, 180, 220, 1],
  ],
  c3: [
    [25, 35, 25, 35, 4],
    [65, 75, 65, 75, 2],
    [100, 140, 100, 140, 0.9],
    [100, 110, 100, 140, -0.4],
    [180, 220, 180, 220, 2],
  ],
};

function heights(boxes: readonly Box[]): Float64Array {
  const h = new Float64Array(256 * 256).fill(100);
  for (const [i0, i1, j0, j1, dz] of boxes)
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) h[j * 256 + i] = (h[j * 256 + i] ?? 0) + dz;
  return h;
}

/** An `aio.tin/1` file: a flat square at `z` over local [x0, x1] (two triangles). */
function flatTin(x0: number, x1: number, z: number): Uint8Array {
  const v = [
    [E0 + x0, N0 + x0, z],
    [E0 + x1, N0 + x0, z],
    [E0 + x1, N0 + x1, z],
    [E0 + x0, N0 + x1, z],
  ];
  const head = (at: number) => ({
    schema: 'aio.tin/1',
    crs: { epsg: 32639 },
    bounds: [E0 + x0, N0 + x0, z, E0 + x1, N0 + x1, z],
    vertexCount: 4,
    triangleCount: 2,
    verticesAt: at,
    trianglesAt: at + 4 * 3 * 8,
  });
  let at = 0;
  for (let k = 0; k < 3; k++) {
    const len = new TextEncoder().encode(JSON.stringify(head(at))).length;
    at = Math.ceil((4 + len) / 8) * 8;
  }
  const json = new TextEncoder().encode(JSON.stringify(head(at)));
  const out = new Uint8Array(at + 4 * 3 * 8 + 2 * 3 * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  out.set(json, 4);
  v.flat().forEach((x, i) => {
    view.setFloat64(at + 8 * i, x, true);
  });
  [0, 1, 2, 0, 2, 3].forEach((x, i) => {
    view.setUint32(at + 96 + 4 * i, x, true);
  });
  return out;
}

const ring = (x0: number, x1: number): [number, number, number][] => [
  [E0 + x0, N0 + x0, 100],
  [E0 + x1, N0 + x0, 100],
  [E0 + x1, N0 + x1, 100],
  [E0 + x0, N0 + x1, 100],
];

const vol = (
  id: string,
  label: string,
  points: [number, number, number][],
  items: ComparisonItem[],
  extra: Partial<SurveyMeasurement> = {},
): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label,
  scope: { kind: 'site' },
  points,
  items,
  results: [],
  createdAt: NOW,
  ...extra,
});

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'survey-test',
  name: 'Survey test',
  customer: 'Demo customer (fictional)',
  site: 'Fictional site',
  crs: { epsg: 32639 },
  origin: [E0, N0, 100],
  captures: CAPS,
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

const settings = SurveySettings.parse({
  ...defaultSurveySettings(),
  templateSets: ['construction', 'mining', 'landfill'],
  materials: [
    { id: 'gravel', name: 'Gravel 20 mm', code: 'G20', densityTPerM3: 2 },
    { id: 'sand', name: 'Washed sand', densityTPerM3: 1.5 },
  ],
});

const PAD_ITEM: ComparisonItem = {
  id: 'design',
  label: 'Cut/Fill to design',
  from: { kind: 'current' },
  to: { kind: 'design', design: 'design', layer: 'pad' },
  deadbandM: 0.15,
  useDeadband: false,
};

const drawn = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
  measurements: [
    vol(
      'm-pile',
      'Stockpile A',
      ring(15, 45),
      [{ id: 'pile', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      { material: 'gravel', template: 'mining-stockpile', fields: { product: 'G20 <b>' } },
    ),
    vol(
      'm-pile2',
      'Stockpile B',
      ring(60, 80),
      [{ id: 'pile', from: { kind: 'fit-plane' }, to: { kind: 'current' }, useDeadband: false }],
      { material: 'sand' },
    ),
    vol('m-pad', 'Pad to design', ring(100, 140), [PAD_ITEM]),
    vol(
      'm-cell',
      'Cell 1',
      ring(180, 220),
      [
        { id: 'lift', from: { kind: 'previous' }, to: { kind: 'current' }, useDeadband: false },
        {
          id: 'airspace',
          from: { kind: 'current' },
          to: { kind: 'design', design: 'design', layer: 'cap' },
          useDeadband: false,
        },
      ],
      { template: 'landfill-monthly-cell' },
    ),
    {
      id: 'm-line',
      family: 'line',
      tool: 'distance',
      label: 'Haul length',
      scope: { kind: 'site' },
      points: [
        [E0 + 10, N0 + 200, 100],
        [E0 + 40, N0 + 240, 100],
      ],
      items: [],
      results: [],
      createdAt: NOW,
    },
    {
      id: 'm-sec',
      family: 'line',
      tool: 'section',
      label: 'Section across the pad',
      scope: { kind: 'site' },
      points: [
        [E0 + 95, N0 + 120, 100],
        [E0 + 145, N0 + 120, 100],
      ],
      items: [],
      results: [],
      createdAt: NOW,
    },
  ],
});

const designs = DesignsFile.parse({
  schema: 'aio.designs/1',
  designs: [
    {
      id: 'design',
      name: 'Site design',
      src: 'design.xml',
      sha256: 'a'.repeat(64),
      bytes: 10,
      format: 'landxml',
      units: 'm',
      calibrated: false,
      importedAt: NOW,
      layers: ['pad', 'cap'].map((id) => ({
        id,
        name: id === 'pad' ? 'Pad' : 'Final cap',
        kind: 'surface',
        file: `${id}.tin`,
        counts: { triangles: 2 },
        visible: true,
        archived: false,
        verticalOffsetM: 0,
      })),
    },
  ],
});

const tiles = (c: string): HeightTiles =>
  HeightTiles.parse({
    schema: 'aio.height-tiles/1',
    id: `dsm-${c}`,
    name: `DSM ${c}`,
    source: { kind: 'dsm', layer: `dsm-${c}` },
    capture: c,
    crs: { epsg: 32639 },
    cellM: 1,
    tileSize: 256,
    originE: E0,
    originN: N0,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [E0, N0, 100, E0 + 256, N0 + 256, 104],
    tiles: ['0_0'],
    fingerprint: `fp-${c}`,
    preparedAt: NOW,
  });

const WEIGH =
  'date,lift,tonnes,note\n2026-02-28,2,1440,month\n2026-03-31,3,1000,first half\n2026-03-31,3,520,second half\n';

/** Equal to a millimetre of a cubic metre: tile heights are float32 about a float64 base. */
function near(x: number | null | undefined, want: number): void {
  expect(x).not.toBeNull();
  expect(x ?? Number.NaN).toBeCloseTo(want, 3);
}

const FILES = new Map<string, unknown>();
const BYTES = new Map<string, Uint8Array>();
let files: SurveyFiles;
let data: ReportSurveyData;
/** The measurements as the panel saved them: each polygon item's result on the latest survey. */
let measurements: MeasurementsFile;

const reader = {
  json: (p: string) => Promise.resolve(FILES.get(p) ?? null),
  text: (p: string) => Promise.resolve(p === 'survey/weighbridge.csv' ? WEIGH : null),
  bytes: (p: string) => Promise.resolve(BYTES.get(p) ?? null),
};

/** The panel's resolver: every survey, the latest on screen, no line-up. */
const panel = () =>
  projectResolver({
    surfaces: CAPS.map((c) => tiles(c.id)),
    captures: CAPS.map((c) => c.id),
    designs: designs.designs,
    fetchBytes: reader.bytes,
  });

/** A measurement with the results the panel stores: each item on the latest survey. */
async function stored(m: SurveyMeasurement): Promise<SurveyMeasurement> {
  if (m.family !== 'polygon') return m;
  const resolve = panel();
  const results: ComparisonResult[] = [];
  for (const it of m.items)
    results.push(
      await compareItem(
        m.points.map((q) => [q[0], q[1]]),
        it,
        resolve,
        { site: { verticalDatum: settings.verticalDatum } },
      ),
    );
  return { ...m, results };
}

beforeAll(async () => {
  for (const c of CAPS) {
    BYTES.set(
      `survey/surfaces/dsm-${c.id}/0/0_0.bin`,
      await encodeTile(heights(BOXES[c.id] ?? [])),
    );
    FILES.set(`survey/surfaces/dsm-${c.id}/tiles.json`, tiles(c.id));
  }
  BYTES.set('survey/designs/design/pad.tin', flatTin(90, 150, 101));
  BYTES.set('survey/designs/design/cap.tin', flatTin(170, 230, 103));
  measurements = { ...drawn, measurements: await Promise.all(drawn.measurements.map(stored)) };
  FILES.set('survey/measurements.json', measurements);
  FILES.set('survey/settings.json', settings);
  FILES.set('survey/designs.json', designs);
  const read = await readSurveyFiles(reader, manifest, ['dsm-c1', 'dsm-c2', 'dsm-c3', 'gone']);
  if (!read) throw new Error('no survey files');
  files = read;
  data = await buildSurveyData(files, reader.bytes, { need: 'report' });
});

describe('the survey data', () => {
  it('reads the files and sorts each measurement into its sections', () => {
    expect(files.surfaces.map((s) => s.id)).toEqual(['dsm-c1', 'dsm-c2', 'dsm-c3']);
    expect(files.weighbridge).toEqual([
      { date: '2026-02-28', tonnes: 1440 },
      { date: '2026-03-31', tonnes: 1520 },
    ]);
    const plan = surveyPlan(files);
    // every volume measurement, as the Volumes view lists them (so the totals agree)
    expect(plan.stockpiles.map((m) => m.id)).toEqual(['m-pile', 'm-pile2', 'm-pad', 'm-cell']);
    expect(plan.earthworks.map((m) => m.id)).toEqual(['m-pad']);
    expect(plan.landfill.map((m) => m.id)).toEqual(['m-cell']);
    expect(plan.sections.map((m) => m.id)).toEqual(['m-sec']);
    expect(surveySectionIds(files)).toEqual([
      'measurements',
      'earthworks',
      'stockpiles',
      'landfill',
    ]);
  });

  it('adds volume over time once a volume measurement has figures on two dates', () => {
    expect(surveySectionIds(files)).not.toContain('volume-over-time');
    const pile = measurements.measurements[0];
    const r = pile?.results[0];
    if (!pile || !r) throw new Error('fixture');
    const dated = {
      ...files,
      measurements: [{ ...pile, series: [{ ...r, toCapture: 'c2', netM3: 300 }] }],
    };
    expect(surveySectionIds(dated)).toContain('volume-over-time');
  });

  it('computes the stockpiles on every survey: exact volumes, tonnes, the change', () => {
    const inv = data.stockpiles;
    expect([inv.current?.id, inv.previous?.id]).toEqual(['c3', 'c2']);
    const a = inv.rows.find((r) => r.id === 'm-pile');
    expect(a?.ref).toBe('M1');
    near(a?.currentM3, 400);
    near(a?.previousM3, 300);
    near(a?.changeM3, 100);
    near(a?.tonnes, 800);
    near(a?.changeTonnes, 200);
    const b = inv.rows.find((r) => r.id === 'm-pile2');
    near(b?.currentM3, 200);
    near(b?.previousM3, 100);
    near(b?.tonnes, 300);
    // the pad and the landfill cell are volume measurements too, as in the Volumes view
    expect(inv.total.piles).toBe(4);
    const latest = data.volumes.inventory.at(-1);
    expect(latest?.capture).toBe('c3');
    expect(latest?.notCounted).toEqual([]);
    near(inv.total.currentM3, latest?.totalM3 ?? Number.NaN);
    expect(inv.byMaterial.map((x) => x.name)).toEqual(['Gravel 20 mm', 'Washed sand', '']);
    near(inv.byMaterial[0]?.tonnes, 800);
    near(inv.byMaterial[1]?.currentM3, 200);
  });

  it('works the other dates out in memory and keeps the stored figure for its own date', () => {
    const a = data.volumes.piles.find((p) => p.id === 'm-pile');
    expect(
      a?.rows.map((r) => [r.capture, r.valueM3 === null ? null : Math.round(r.valueM3)]),
    ).toEqual([
      ['c1', 200],
      ['c2', 300],
      ['c3', 400],
    ]);
    expect(a?.rows.map((r) => r.stale)).toEqual([false, false, false]);
    // nothing is written: the saved file still has the stored result only
    expect(measurements.measurements[0]?.series).toBeUndefined();
  });

  it('names a stale stored figure and leaves it out of the total', async () => {
    const stale = {
      ...files,
      measurements: files.measurements.map((m) =>
        m.id === 'm-pile2'
          ? { ...m, results: m.results.map((r) => ({ ...r, fingerprint: 'sha256:before' })) }
          : m,
      ),
    };
    const d = await buildSurveyData(stale, reader.bytes, { need: 'report' });
    const latest = d.volumes.inventory.at(-1);
    expect(latest?.notCounted).toEqual([{ id: 'm-pile2', reason: 'stale' }]);
    near(latest?.totalM3, (data.volumes.inventory.at(-1)?.totalM3 ?? 0) - 200);
    expect(d.measurements.find((m) => m.id === 'm-pile2')?.comparisons[0]?.result?.status).toBe(
      'stale',
    );
  });

  it('gives the same numbers as the panel computes (one engine, one fingerprint)', async () => {
    const m = drawn.measurements[0];
    const item = m?.items[0];
    if (!m || !item) throw new Error('fixture');
    const resolve = projectResolver({
      surfaces: files.surfaces,
      captures: CAPS.map((c) => c.id),
      designs: designs.designs,
      fetchBytes: reader.bytes,
    });
    const panel = await compareItem(
      m.points.map((p) => [p[0], p[1]]),
      item,
      resolve,
      {
        site: { verticalDatum: settings.verticalDatum },
      },
    );
    const listed = data.measurements.find((x) => x.id === 'm-pile')?.comparisons[0]?.result;
    expect(listed?.netM3).toBe(panel.netM3);
    expect(listed?.fingerprint).toBe(panel.fingerprint);
  });

  it('reports cut and fill to design, the in-tolerance share and the progress', () => {
    const [pad] = data.earthworks;
    near(pad?.current?.result.fillM3, 320);
    expect(pad?.current?.result.cutM3).toBe(0);
    expect(pad?.first?.capture.id).toBe('c1');
    near(pad?.first?.result.fillM3, 1600);
    expect(pad?.progress).toBeCloseTo(0.8, 6);
    expect(pad?.tolerance?.share).toBe(0.75);
    expect(pad?.tolerance?.areaM2).toBe(1600);
    expect(pad?.toleranceM).toBe(0.15);
    expect(pad?.design).toBe('Site design, Pad');
    const [sec] = data.sections;
    expect(sec?.lengthM).toBe(50);
    expect(sec?.profiles.map((p) => p.label)).toEqual([
      'Current survey (DSM c3)',
      'DSM c1',
      'Site design, Pad',
    ]);
  });

  it('reports airspace remaining and the compaction of each lift from the weighbridge', () => {
    const [cell] = data.landfill;
    near(cell?.airspace?.remainingM3, 1600);
    expect(cell?.lifts.map((l) => [l.capture.id, l.tonnes])).toEqual([
      ['c1', null],
      ['c2', 1440],
      ['c3', 1520],
    ]);
    expect(cell?.lifts[0]?.volumeM3).toBeNull();
    near(cell?.lifts[1]?.volumeM3, 1600);
    near(cell?.lifts[2]?.volumeM3, 1600);
    expect(cell?.lifts[1]?.densityTPerM3).toBeCloseTo(0.9, 6);
    expect(cell?.lifts[2]?.densityTPerM3).toBeCloseTo(0.95, 6);
    expect(cell?.lifts[0]?.reason).toMatch(/previous survey/);
    near(cell?.usedM3, 3200);
    expect(cell?.tonnes).toBe(2960);
  });

  it('formats the readouts as the panel does and keeps the template fields', () => {
    const line = data.measurements.find((m) => m.id === 'm-line');
    expect(line?.values.find((v) => v.key === 'horizontal')).toMatchObject({
      si: 50,
      display: '50.000 m',
    });
    // flat ground under it: the terrain length is the horizontal one, from the prepared surface
    expect(line?.values.find((v) => v.key === 'terrain-length')?.si).toBeCloseTo(50, 9);
    const pile = data.measurements.find((m) => m.id === 'm-pile');
    expect(pile?.template).toBe('Stockpile (smart base)');
    expect(pile?.fields).toEqual([{ name: 'Product', value: 'G20 <b>' }]);
    expect(pile?.values.find((v) => v.key === 'net')?.display).toBe('400.0 m³');
  });

  it('states what the numbers were computed with', () => {
    expect(data.basis).toMatchObject({
      crs: 'EPSG:32639',
      verticalDatum: 'project',
      geoid: null,
      calibration: null,
      distances: 'grid',
    });
    expect(data.computed).toBe(true);
  });

  it('gives every pile on every survey for the stockpile CSV', async () => {
    const all = await buildSurveyData(files, reader.bytes, { need: 'stockpile-csv' });
    const a = all.stockpiles.rows.find((r) => r.id === 'm-pile');
    expect(a?.volumes.map((v) => v.capture.id)).toEqual(['c1', 'c2', 'c3']);
    a?.volumes.forEach((v, i) => {
      near(v.volumeM3, 200 + 100 * i);
    });
    expect(all.measurements).toEqual([]);
    const csv = stockpileCsv(all);
    expect(csv).toContain('2026-01-31_volume_m3');
    expect(csv).toContain('pile,m-pile,M1,Stockpile A,Gravel 20 mm,G20,2,');
  });

  it('keeps the history of a pile filed under its survey date: a column per prepared survey', async () => {
    const dated: SurveyFiles = {
      ...files,
      measurements: files.measurements.map((m) =>
        m.id === 'm-pile' ? { ...m, scope: { kind: 'survey', capture: 'c3' } } : m,
      ),
    };
    const all = await buildSurveyData(dated, reader.bytes, { need: 'stockpile-csv' });
    const a = all.stockpiles.rows.find((r) => r.id === 'm-pile');
    expect(a?.volumes.map((v) => v.capture.id)).toEqual(['c1', 'c2', 'c3']);
    a?.volumes.forEach((v, i) => {
      near(v.volumeM3, 200 + 100 * i);
    });
    expect(stockpileCsv(all)).toContain('2026-01-31_volume_m3');
    // the report's last two surveys too
    const report = await buildSurveyData(dated, reader.bytes, { need: 'report' });
    const r = report.stockpiles.rows.find((x) => x.id === 'm-pile');
    near(r?.currentM3, 400);
    near(r?.previousM3, 300);
  });

  it('reports the saved results, and says so, when no surface is prepared', async () => {
    const saved = {
      ...files,
      surfaces: [],
      measurements: files.measurements.map((m) => (m.id === 'm-pile2' ? { ...m, results: [] } : m)),
    };
    const d = await buildSurveyData(saved, reader.bytes, { need: 'report' });
    expect(d.computed).toBe(false);
    near(d.stockpiles.rows.find((r) => r.id === 'm-pile')?.currentM3, 400);
    expect(d.stockpiles.rows.find((r) => r.id === 'm-pile2')?.current?.status).toBe('missing');
  });

  it("carries an old project's kit piles over in memory, with their kit figures", async () => {
    const read = await readSurveyFiles(kitReader(), manifest, []);
    const pile = read?.measurements[0];
    expect(read?.measurements).toHaveLength(1);
    expect(pile?.tool).toBe('volume');
    expect(pile?.results[0]?.carried?.base).toBe('tin');
    expect(pile?.series?.map((r) => r.netM3)).toEqual([150, 175]);
  });

  it("an old project's kit piles sit on the kit DSM of their date", async () => {
    const read = await readSurveyFiles(kitReader(kitDsm('e3', 103)), manifest, []);
    expect(read?.measurements[0]?.points.map((p) => p[2])).toEqual([103, 103, 103, 103]);
  });

  it('an import that names its grids (volumes.grids) has its DSMs read from there', async () => {
    const kit: VolumesFile = {
      ...KIT,
      grids: {
        format: 'vs-kit-js',
        piles: 'volumes/grids/piles/{id}.js',
        dsm: 'volumes/grids/dsm_{epoch}.js',
      },
    };
    const reader = kitReader(kitDsm('e3', 103), undefined, kit, 'volumes/grids');
    const read = await readSurveyFiles(reader, manifest, []);
    expect(read?.measurements[0]?.points.map((p) => p[2])).toEqual([103, 103, 103, 103]);
  });

  it('kit piles converted at Z 0 before heights are repaired in memory', async () => {
    const first = await readSurveyFiles(kitReader(), manifest, []);
    const pile = first?.measurements[0];
    if (!pile) throw new Error('no kit pile');
    expect(pile.points.map((p) => p[2])).toEqual([0, 0, 0, 0]);
    const saved: MeasurementsFile = {
      schema: 'aio.measurements/1',
      measurements: [pile],
      kitPilesConverted: ['K1'],
    };
    const read = await readSurveyFiles(kitReader(kitDsm('e3', 103), saved), manifest, []);
    expect(read?.measurements[0]?.points.map((p) => p[2])).toEqual([103, 103, 103, 103]);
    // the figures stay the ones saved
    expect(read?.measurements[0]?.series).toEqual(pile.series);
  });
});

// ---------------------------------------------------------------- an old project

/** A kit survey (aio.volumes/1) of one pile on two dates, with no measurements file. */
const KIT: VolumesFile = {
  schema: 'aio.volumes/1',
  densityTPerM3: 1.6,
  deadbandM: 0.05,
  defaultBase: 'tin',
  bases: [{ id: 'tin', label: 'Triangulated toe' }],
  captures: [
    { epoch: 'e2', captureId: 'c2', date: '2026-02-28', label: 'Survey 28 February 2026' },
    { epoch: 'e3', captureId: 'c3', date: '2026-03-31', label: 'Survey 31 March 2026' },
  ],
  piles: [
    {
      id: 'K1',
      name: 'Kit pile 1',
      zoneRing: [],
      change: { fill: 25, cut: 0, net: 25 },
      epochs: Object.fromEntries(
        (['e2', 'e3'] as const).map((e, i) => {
          const fc = (net: number) => ({ fill: net, cut: 0, net });
          const net = i === 0 ? 150 : 175;
          return [
            e,
            {
              captureId: i === 0 ? 'c2' : 'c3',
              areaM2: 100,
              topM: 104,
              heightM: 4,
              ring: [
                [10, -10],
                [20, -10],
                [20, -20],
                [10, -20],
              ],
              volumes: { tin: fc(net), plane: fc(net + 10), avg: fc(net + 20), low: fc(net + 30) },
            },
          ];
        }),
      ),
    },
  ],
  totals: {},
  pileChange: { fill: 25, cut: 0, net: 25 },
  siteChange: { fill: 25, cut: 0, net: 25 },
};

const kitReader = (
  dsm: { epoch: string; text: string } | null = null,
  file?: MeasurementsFile,
  kit: VolumesFile = KIT,
  dsmDir = 'legacy/data',
) => ({
  json: (path: string) =>
    Promise.resolve(
      path === 'volumes.json'
        ? kit
        : path === 'survey/settings.json'
          ? settings
          : path === 'survey/measurements.json'
            ? (file ?? null)
            : null,
    ),
  text: (path: string) =>
    Promise.resolve(dsm && path === `${dsmDir}/dsm_${dsm.epoch}.js` ? dsm.text : null),
  bytes: () => Promise.resolve(null),
});

/** A kit `data/dsm_<epoch>.js` of one height (m) over the kit pile (E0..E0+30, N0..N0+30, 1 m). */
function kitDsm(epoch: string, heightM: number): { epoch: string; text: string } {
  const w = 30;
  const h = 30;
  // row-wise deltas: the first cell of each row holds the value, the rest 0
  const d = new Int16Array(w * h);
  for (let y = 0; y < h; y++) d[y * w] = Math.round((heightM - 100) * 100);
  const b64 = (u: Uint8Array) => deflateSync(Buffer.from(u.buffer)).toString('base64');
  const grid = {
    res: 1,
    w,
    h,
    x0: E0,
    y1: N0 + 30,
    zoff: 100,
    z: b64(new Uint8Array(d.buffer)),
    valid: b64(new Uint8Array(Math.ceil((w * h) / 8)).fill(255)),
  };
  return {
    epoch,
    text: `window.VS_DSM=window.VS_DSM||{};window.VS_DSM["${epoch}"]=${JSON.stringify(grid)};`,
  };
}

// ---------------------------------------------------------------- the sections

function layout(ids: readonly string[], survey: ReportSurveyData = data): HTMLElement {
  const root = document.createElement('div');
  const pager = new Pager({
    root,
    frame: (section) => {
      const page = document.createElement('section');
      page.dataset.section = section;
      const body = document.createElement('div');
      page.appendChild(body);
      root.appendChild(page);
      return { page, body };
    },
    overflows: () => false,
  });
  const ctx: HouseContext = {
    h: houseReportModel({
      manifest,
      issues: [],
      branding: resolveReportBranding(undefined, 'Quadrion AI'),
      surveySections: surveySectionIds(files),
    }),
    text: { summary: '', method: '', findings: '' },
    images: { overview: [] },
    product: 'Quadrion AI',
    survey,
  };
  ids.forEach((id, i) => {
    const fn = SECTION_LAYOUTS[id as keyof typeof SECTION_LAYOUTS];
    if (!fn) throw new Error(id);
    pager.start(id);
    fn(pager, ctx, String(i + 1).padStart(2, '0'));
  });
  return root;
}

const text = (el: Element) => el.textContent.replace(/\s+/g, ' ');

/** A table row's cells, each one's text. */
const cells = (tr: Element) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());

/** A volume as the site formats it (the report's and the app's `formatQuantity`). */
const formatVolume = (m3: number) =>
  formatQuantity(m3, 'volume', settings.units, settings.precision);

describe('the survey sections', () => {
  it('print in the house report only for a project with survey data', () => {
    const h = houseReportModel({
      manifest,
      issues: [],
      branding: resolveReportBranding(undefined, 'Quadrion AI'),
      surveySections: ['stockpiles'],
    });
    expect(h.sections).toContain('stockpiles');
    expect(h.sections).not.toContain('landfill');
    const none = houseReportModel({
      manifest,
      issues: [],
      branding: resolveReportBranding(undefined, 'Quadrion AI'),
    });
    expect(none.sections.filter((s) => ['measurements', 'stockpiles'].includes(s))).toEqual([]);
  });

  it('lists the measurements with references, a plan and a totals row', () => {
    const root = layout(['measurements']);
    const t = text(root);
    expect(t).toContain('Survey measurements');
    expect(t).toContain('Coordinates in EPSG:32639, grid distances');
    expect(t).toContain('Heights in the project datum');
    expect(t).toContain('No site calibration');
    expect(t).toContain('Units: m, m², m³, t/m³, t, grades in percent');
    expect(root.querySelector('svg.map')?.textContent).toContain('M1');
    const total = root.querySelector('table.sv-vol tr.total');
    // stockpiles 400 + 200, pad fill 320, cell lift 1 600 and airspace 1 600
    expect(text(total ?? root)).toContain('4 120.0 m³');
    // a person's text is escaped
    expect(root.innerHTML).not.toContain('<b>G20');
  });

  it('prints the stockpile inventory, month end, with the materials summary', () => {
    const root = layout(['stockpiles']);
    const t = text(root);
    expect(t).toContain(
      'Month end: the inventory on the survey of 31 Mar 2026, with the change since the survey of 28 Feb 2026.',
    );
    const rows = [...root.querySelectorAll('table.sv-piles tr')].map(text);
    expect(rows.find((r) => r.includes('Stockpile A'))).toMatch(
      /400\.0 m³.*800\.0 t.*300\.0 m³.*100\.0 m³.*200\.0 t/,
    );
    // the total is the Volumes view's: the latest date's current figures
    const latest = data.volumes.inventory.at(-1);
    const total = rows.find((r) => r.includes('Total'));
    expect(total).toContain(formatVolume(latest?.totalM3 ?? 0));
    expect(total).toContain('4 of 4 piles');
    expect(t).toContain('Materials summary');
  });

  it('stockpile section shows the same figure as the card', () => {
    const root = layout(['stockpiles']);
    const pile = measurements.measurements.find((m) => m.id === 'm-pile');
    if (!pile) throw new Error('fixture');
    const card = cardModel(pile, { settings, templates: files.templates, captures: CAPS });
    expect(card.primary?.text).toBe('400.0 m³');
    const row = [...root.querySelectorAll('table.sv-piles tr')]
      .map(text)
      .find((r) => r.includes('Stockpile A'));
    expect(row).toContain(card.primary?.text ?? 'none');
    // and the summary's figures are that total, in the site's units
    const v = houseVolumes(data);
    expect(v?.text.total).toBe(formatVolume(data.volumes.inventory.at(-1)?.totalM3 ?? 0));
  });

  it('old project report prints the carried kit figure, labelled', async () => {
    const read = await readSurveyFiles(kitReader(), manifest, []);
    if (!read) throw new Error('no kit pile');
    const d = await buildSurveyData(read, reader.bytes, { need: 'report' });
    const root = layout(['stockpiles', 'volume-over-time'], d);
    const t = text(root);
    expect(t).toContain('From an earlier version (kit, Triangulated toe)');
    const row = [...root.querySelectorAll('table.sv-piles tr')]
      .map(text)
      .find((r) => r.includes('Kit pile 1'));
    expect(row).toMatch(/175\.0 m³.*150\.0 m³.*25\.0 m³/);
    // the kit's density (no site material matches the pile's null material): tonnes print
    expect(row).toMatch(/175\.0 m³.*280\.0 t/);
    const csv = stockpileCsv(await buildSurveyData(read, reader.bytes, { need: 'stockpile-csv' }));
    // material Stockpile material, density 1.6, and 280 t on the latest date
    expect(csv).toMatch(/Kit pile 1,Stockpile material,,1\.6,/);
    expect(csv).toContain(',280,');
  });

  it('a survey that cannot be worked out leaves its parts out of a house report only', async () => {
    const fails = () => Promise.reject(new Error('tile unreadable'));
    expect(await surveyOrNone(fails, false)).toBeNull();
    await expect(surveyOrNone(fails, true)).rejects.toThrow('tile unreadable');
    expect(await surveyOrNone(() => Promise.resolve(data), false)).toBe(data);
  });

  it('the stockpile map draws every pile, whatever the template lists', async () => {
    const lineOnly: SurveyFiles = {
      ...files,
      template: {
        schema: 'aio.report-template/1',
        entries: [{ kind: 'measurement', id: 'm-line', parts: ['value'], addedAt: NOW }],
      },
    };
    const d = await buildSurveyData(lineOnly, reader.bytes, { need: 'report' });
    // the template lists one line: no pile is among the listed measurements
    expect(d.measurements.map((m) => m.id)).toEqual(['m-line']);
    expect(d.volumes.piles.length).toBeGreaterThan(1);
    const svg = pilePlan(d, 'Stockpiles');
    expect(svg).toContain('<svg');
    for (const p of d.volumes.piles) expect(svg).toContain(`>${p.ref}<`);
  });

  it('template entries print as report cards in template order', async () => {
    const withTemplate: SurveyFiles = {
      ...files,
      template: {
        schema: 'aio.report-template/1',
        entries: [
          { kind: 'measurement', id: 'm-line', parts: ['value', 'chart'], addedAt: NOW },
          { kind: 'section', section: 'stockpiles' },
          { kind: 'measurement', id: 'm-pile', parts: ['value', 'chart', 'table'], addedAt: NOW },
        ],
      },
    };
    const d = await buildSurveyData(withTemplate, reader.bytes, { need: 'report' });
    const root = layout(['measurements'], d);
    const cards = [...root.querySelectorAll('[data-testid="report-card"]')];
    expect(cards.map((c) => c.getAttribute('data-measure-id'))).toEqual(['m-line', 'm-pile']);
    expect(cards[0]?.querySelector('[data-testid="report-line-profile"] svg')).not.toBeNull();
    expect(cards[1]?.querySelector('[data-testid="report-volume-time"] svg')).not.toBeNull();
    expect(text(cards[1] ?? root)).toContain('400.0 m³');
    // the pile's readout table, its "table" part
    expect(root.querySelectorAll('table.sv-readout')).toHaveLength(1);
  });

  it('volume over time section lists change since previous', () => {
    const root = layout(['volume-over-time']);
    const t = text(root);
    expect(t).toContain('Volume over time');
    const [first] = [...root.querySelectorAll('table.sv-time')];
    const rows = [...(first?.querySelectorAll('tbody tr') ?? [])].map(cells);
    // date, volume, change since the date before, mass (the pile has a density), status
    expect(rows).toEqual([
      ['31 Jan 2026', '200.0 m³', '', '400.0 t', ''],
      ['28 Feb 2026', '300.0 m³', '100.0 m³', '600.0 t', ''],
      ['31 Mar 2026', '400.0 m³', '100.0 m³', '800.0 t', ''],
    ]);
    expect(root.querySelector('[data-testid="report-volume-time"] svg')).not.toBeNull();
    // the site inventory, stacked, with its change since the date before
    expect(root.querySelector('[data-testid="report-inventory-time"] svg')).not.toBeNull();
    const inv = [...root.querySelectorAll('table.sv-inv tbody tr')].map(cells);
    expect(inv).toHaveLength(3);
    const c3 = data.volumes.inventory.at(-1);
    expect(inv[2]?.[0]).toBe('31 Mar 2026');
    expect(inv[2]?.[1]).toBe(formatVolume(c3?.totalM3 ?? Number.NaN));
    expect(inv[2]?.[2]).toBe(formatVolume(c3?.change?.m3 ?? Number.NaN));
    expect(inv[2]?.[3]).toBe('4 of 4 piles');
  });

  it('prints earthworks with tolerance and progress, and the sections', () => {
    const root = layout(['earthworks']);
    const row = [...root.querySelectorAll('table.sv-ew tr')]
      .map(text)
      .find((r) => r.includes('Pad'));
    expect(row).toMatch(/320\.0 m³/);
    expect(row).toContain('75 % (±0.150 m)');
    expect(row).toMatch(/80 %$/);
  });

  it('earthworks section draws the shared chart with design dashed', () => {
    const root = layout(['earthworks']);
    const charts = root.querySelectorAll('[data-testid="report-section"]');
    expect(charts).toHaveLength(1);
    const kinds = [...(charts[0]?.querySelectorAll('polyline[data-kind]') ?? [])].map((p) => [
      p.getAttribute('data-kind'),
      p.getAttribute('stroke-dasharray'),
    ]);
    expect(kinds).toContainEqual(['design', '6 4']);
    expect(kinds).toContainEqual(['current', null]);
    expect(kinds).toContainEqual(['earlier', null]);
    // the old hand-drawn chart is gone
    expect(root.querySelector('svg.svsec')).toBeNull();
  });

  it('prints airspace remaining and compaction per lift', () => {
    const root = layout(['landfill']);
    expect(text(root.querySelector('[data-sv="airspace"]') ?? root)).toContain(
      'Airspace remaining: 1 600.0 m³',
    );
    const lifts = [...root.querySelectorAll('table.sv-lifts tbody tr')].map(text);
    expect(lifts).toHaveLength(3);
    expect(lifts[1]).toMatch(/1 600\.0 m³.*1 440\.0 t.*0\.900 t\/m³/);
    expect(lifts[2]).toMatch(/0\.950 t\/m³/);
  });

  it('draws nothing for nothing', () => {
    expect(measurementPlan([], 'x')).toBe('');
  });

  it('makes the measurements CSV from the same data', () => {
    const csv = measurementsCsv(data);
    const lines = csv.replace(String.fromCharCode(0xfeff), '').split('\r\n');
    const net = lines.find((l) => l.startsWith('M1,m-pile,') && l.includes('pile.net'));
    expect(net).toContain(',400.0 m³,400,m³,400,m3,ok,');
  });
});

// ---------------------------------------------------------------- the report card is the app's

/** A line or point measurement drawn on the site (no comparison). */
const drawnOn = (
  id: string,
  tool: SurveyMeasurement['tool'],
  family: SurveyMeasurement['family'],
  points: [number, number, number][],
  extra: Partial<SurveyMeasurement> = {},
): SurveyMeasurement => ({
  id,
  family,
  tool,
  label: id,
  scope: { kind: 'site' },
  points,
  items: [],
  results: [],
  createdAt: NOW,
  ...extra,
});

/** The app's detail card of a measurement: drawn points, the survey's heights under it. */
async function appCard(m: SurveyMeasurement, on: SurveyFiles, capture = 'c3') {
  const s = on.surfaces.find((x) => x.capture === capture);
  if (!s) throw new Error('no surface');
  const drawn = { ...m, points: drawnPoints(m, on.manifest) };
  const ctx = { settings: on.settings, templates: on.templates, captures: CAPS };
  return withSurface(
    (h) => cardModel(drawn, { ...ctx, surface: h }),
    s,
    (c, r) => reader.bytes(`survey/surfaces/${s.id}/0/${String(c)}_${String(r)}.bin`),
  );
}

/** The report's cards of `extra` measurements, printed through the report template. */
async function reportCards(on: SurveyFiles, extra: SurveyMeasurement[]) {
  const d = await buildSurveyData(
    {
      ...on,
      measurements: [...on.measurements, ...extra],
      template: {
        schema: 'aio.report-template/1',
        entries: extra.map((m) => ({
          kind: 'measurement' as const,
          id: m.id,
          parts: ['value' as const],
          addedAt: NOW,
        })),
      },
    },
    reader.bytes,
    { need: 'report' },
  );
  return new Map(d.entries.map((e) => [e.m.id, e.card]));
}

describe('the report card is the app card', () => {
  it('berm-check headline, elevation difference and terrain area match the app card', async () => {
    const berm = drawnOn('m-berm', 'berm-check', 'line', [
      [E0 + 15, N0 + 30, 100],
      [E0 + 45, N0 + 30, 100],
    ]);
    const diff = drawnOn('m-diff', 'elevation-difference', 'point', [[E0 + 30, N0 + 30, 101]]);
    const area = drawnOn('m-area', 'area', 'polygon', ring(20, 40));
    const cards = await reportCards(files, [berm, diff, area]);
    for (const m of [berm, diff, area]) expect(cards.get(m.id)).toEqual(await appCard(m, files));
    // the berm's crest is the pile top on the survey (104 m), read from the surface
    expect(cards.get('m-berm')?.primary?.text).toMatch(/^104\.0+/);
    // the point's ground and its difference to it join the secondary line
    expect(cards.get('m-diff')?.secondary).toMatch(/104\.0+/);
    expect(cards.get('m-diff')?.secondary).toMatch(/3\.0+/);
    // terrain area: the surface under the polygon, more than its plan area of 400 m²
    const terrain = cards.get('m-area')?.more.find((r) => /terrain/i.test(r.label));
    expect(terrain?.text).toMatch(/m²$/);
  });

  it('a lined-up survey-scoped measurement prints where the app draws it', async () => {
    const lined: SurveyFiles = {
      ...files,
      manifest: ProjectManifest.parse({
        ...manifest,
        captures: CAPS.map((c) =>
          c.id === 'c3' ? { ...c, lineUp: { eastM: 2, northM: 1, with: 'c2', at: NOW } } : c,
        ),
      }),
    };
    const point = drawnOn('m-lined', 'elevation', 'point', [[E0 + 30, N0 + 30, 102]], {
      scope: { kind: 'survey', capture: 'c3' },
    });
    const cards = await reportCards(lined, [point]);
    const app = await appCard(point, lined);
    expect(cards.get('m-lined')).toEqual(app);
    // its easting and northing are the drawn ones (the date's line-up added), not the stored ones
    const stored = cardModel(point, { settings, templates: files.templates, captures: CAPS });
    expect(cards.get('m-lined')?.secondary).not.toBe(stored.secondary);
  });
});

describe('the report follows the site number style', () => {
  it('the KPIs, the table and the card agree in the imperial style', async () => {
    const imperial: SurveyFiles = {
      ...files,
      settings: { ...settings, locale: 'imperial' },
      template: {
        schema: 'aio.report-template/1',
        entries: [{ kind: 'measurement', id: 'm-cell', parts: ['value'], addedAt: NOW }],
      },
    };
    const d = await buildSurveyData(imperial, reader.bytes, { need: 'report' });
    const root = layout(['stockpiles'], d);
    const total = d.volumes.inventory.at(-1)?.totalM3 ?? Number.NaN;
    const want = formatQuantity(total, 'volume', settings.units, settings.precision, 'imperial');
    expect(want).toContain(',');
    const tiles = [...root.querySelectorAll('.tile b')].map((b) => b.textContent);
    expect(tiles).toContain(want);
    const totalRow = [...root.querySelectorAll('table.sv-piles tr.total')].map(cells)[0];
    expect(totalRow).toContain(want);
    // the cell's card and its row: the same figure, in the same style
    const card = d.entries.find((e) => e.m.id === 'm-cell')?.card.primary?.text;
    expect(card).toBe('1,600.0 m³');
    const row = [...root.querySelectorAll('table.sv-piles tr')]
      .map(cells)
      .find((r) => r.includes('Cell 1'));
    expect(row).toContain(card);
  });
});

describe('the stockpile table and the volume over time section', () => {
  it('prints a stale figure marked, and leaves it out of the total', async () => {
    const stale = {
      ...files,
      measurements: files.measurements.map((m) =>
        m.id === 'm-pile2'
          ? { ...m, results: m.results.map((r) => ({ ...r, fingerprint: 'sha256:before' })) }
          : m,
      ),
    };
    const d = await buildSurveyData(stale, reader.bytes, { need: 'report' });
    const root = layout(['stockpiles'], d);
    const tr = [...root.querySelectorAll('table.sv-piles tr')].find((r) =>
      text(r).includes('Stockpile B'),
    );
    expect(tr?.className).toContain('flag');
    expect(cells(tr ?? root)).toContain('200.0 m³');
    expect(text(root)).toContain('Stockpile B (stale)');
    const totalRow = [...root.querySelectorAll('table.sv-piles tr.total')].map(cells)[0];
    expect(totalRow).toContain(formatVolume(d.volumes.inventory.at(-1)?.totalM3 ?? 0));
    expect(totalRow).toContain('3 of 4 piles');
  });

  it('lists every pile over time when the template names no volume measurement', async () => {
    const d = await buildSurveyData(
      {
        ...files,
        template: {
          schema: 'aio.report-template/1',
          entries: [{ kind: 'measurement', id: 'm-line', parts: ['value'], addedAt: NOW }],
        },
      },
      reader.bytes,
      { need: 'report' },
    );
    const root = layout(['volume-over-time'], d);
    expect(root.querySelectorAll('table.sv-time')).toHaveLength(4);
  });

  it('reads only the stored dates when no section prints the others', async () => {
    const d = await buildSurveyData(files, reader.bytes, { need: 'report', fillDates: false });
    const a = d.volumes.piles.find((p) => p.id === 'm-pile');
    expect(a?.rows.map((r) => r.valueM3 === null)).toEqual([true, true, false]);
  });
});
