// @vitest-environment jsdom
// The survey sections (M11 G9) on a small analytic project: flat ground at 100 m on three surveys
// of one 256 m tile at 1 m cells, two box-shaped stockpiles that change by known volumes, a pad
// against a flat design at 101 m, a landfill cell filled by 1 m per survey under a cap at 103 m,
// and a weighbridge log. On aligned cells every volume is the analytic one (section 26: posts are
// read exactly, interior cells have coverage 1) up to the float32 heights of the tiles, so the
// sections, the CSVs and the panel agree to the cubic metre.
import {
  houseReportModel,
  measurementsCsv,
  resolveReportBranding,
  stockpileCsv,
  type SurveyReportData,
} from '@aio/project/export';
import {
  DesignsFile,
  HeightTiles,
  MeasurementsFile,
  ProjectManifest,
  SurveySettings,
  defaultSurveySettings,
  type ComparisonItem,
  type SurveyMeasurement,
} from '@aio/schema';
import { compareItem, encodeTile, projectResolver } from '@aio/survey';
import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, describe, expect, it } from 'vitest';
import { Pager } from './pager';
import { SECTION_LAYOUTS, type HouseContext } from './sections';
import { measurementPlan, sectionChart } from './survey';
import {
  buildSurveyData,
  readSurveyFiles,
  surveyPlan,
  surveySectionIds,
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

const measurements = MeasurementsFile.parse({
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
let data: SurveyReportData;

const reader = {
  json: (p: string) => Promise.resolve(FILES.get(p) ?? null),
  text: (p: string) => Promise.resolve(p === 'survey/weighbridge.csv' ? WEIGH : null),
  bytes: (p: string) => Promise.resolve(BYTES.get(p) ?? null),
};

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
    expect(plan.stockpiles.map((m) => m.id)).toEqual(['m-pile', 'm-pile2']);
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

  it('computes the stockpiles on the last two surveys: exact volumes, tonnes, the change', () => {
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
    expect(inv.total.piles).toBe(2);
    near(inv.total.currentM3, 600);
    near(inv.total.changeM3, 200);
    near(inv.total.tonnes, 1100);
    expect(inv.byMaterial.map((x) => x.name)).toEqual(['Gravel 20 mm', 'Washed sand']);
    near(inv.byMaterial[0]?.tonnes, 800);
    near(inv.byMaterial[1]?.currentM3, 200);
  });

  it('gives the same numbers as the panel computes (one engine, one fingerprint)', async () => {
    const m = measurements.measurements[0];
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

  it('reports the saved results, and says so, when no surface is prepared', async () => {
    const saved = {
      ...files,
      surfaces: [],
      measurements: files.measurements.map((m) =>
        m.id === 'm-pile'
          ? {
              ...m,
              results:
                data.measurements[0]?.comparisons.flatMap((c) => (c.result ? [c.result] : [])) ??
                [],
            }
          : m,
      ),
    };
    const d = await buildSurveyData(saved, reader.bytes, { need: 'report' });
    expect(d.computed).toBe(false);
    near(d.stockpiles.rows.find((r) => r.id === 'm-pile')?.currentM3, 400);
    expect(d.stockpiles.rows.find((r) => r.id === 'm-pile2')?.current?.status).toBe('missing');
  });
});

// ---------------------------------------------------------------- the sections

function layout(ids: readonly string[]): HTMLElement {
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
    survey: data,
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
    expect(rows.find((r) => r.includes('Total'))).toMatch(/600\.0 m³.*1 100\.0 t/);
    expect(t).toContain('Materials summary');
  });

  it('prints earthworks with tolerance and progress, and the sections', () => {
    const root = layout(['earthworks']);
    const row = [...root.querySelectorAll('table.sv-ew tr')]
      .map(text)
      .find((r) => r.includes('Pad'));
    expect(row).toMatch(/320\.0 m³/);
    expect(row).toContain('75 % (±0.150 m)');
    expect(row).toMatch(/80 %$/);
    expect(root.querySelectorAll('svg.svsec')).toHaveLength(1);
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
    expect(sectionChart({ ref: 'M1', label: 'x', lengthM: 1, profiles: [] })).toBe('');
  });

  it('makes the measurements CSV from the same data', () => {
    const csv = measurementsCsv(data);
    const lines = csv.replace(String.fromCharCode(0xfeff), '').split('\r\n');
    const net = lines.find((l) => l.startsWith('M1,m-pile,') && l.includes('pile.net'));
    expect(net).toContain(',400.0 m³,400,m³,400,m3,ok,');
  });
});
