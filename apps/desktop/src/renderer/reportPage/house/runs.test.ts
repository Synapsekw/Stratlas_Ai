// @vitest-environment jsdom
// The haul-road compliance and hydrology sections of the house report (M11 integration): the
// haul run `haul.analyse` writes (the schema's fixture: a straight road whose right side drops
// away, so every station fails the right berm) and three hydrology runs with known numbers.
import { houseReportModel, resolveReportBranding, surveyBasis } from '@aio/project/export';
import {
  HaulRun,
  HydroRun,
  ProjectManifest,
  SurveySettings,
  defaultSurveySettings,
  type ReportSectionId,
} from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pager } from './pager';
import {
  HAUL_STATIONS_MAX,
  readSiteRuns,
  runSectionIds,
  stationResult,
  type SiteRuns,
} from './runs';
import { SECTION_LAYOUTS, type HouseContext } from './sections';

const haulFixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../../../packages/schema/src/__fixtures__/haul/run.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'runs-test',
  name: 'Runs test',
  customer: 'Demo customer (fictional)',
  site: 'Fictional quarry',
  crs: { epsg: 32639 },
  origin: [553000, 2333000, 100],
  captures: [{ id: 'm1', label: 'Survey 1 October 2026', date: '2026-10-01' }],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

const base = {
  schema: 'aio.hydro-run/1',
  jobId: 'job-1',
  surface: { id: 'dsm-1', name: 'Quarry DSM', fingerprint: 'sha256:ab' },
  params: {},
  cellM: 0.5,
  files: {},
  fingerprint: 'sha256:cd',
};

const FLOOD = HydroRun.parse({
  ...base,
  id: 'flood-1',
  pipeline: 'hydro.flood',
  computedAt: '2026-10-09T09:00:00Z',
  results: {
    levelM: 101.25,
    mode: 'connected',
    seed: [553000, 2333000],
    areaM2: 1250,
    volumeM3: 937.5,
    maxDepthM: 1.5,
    wetCells: 5000,
  },
});

const FLOW = HydroRun.parse({
  ...base,
  id: 'flow-1',
  pipeline: 'hydro.flow',
  computedAt: '2026-10-09T08:00:00Z',
  results: {
    mode: 'catchment',
    method: 'd8',
    depressions: 'fill',
    path: {
      start: [553000, 2333000],
      end: [553100, 2333000],
      lengthM: 120,
      fallM: 6,
      cells: 240,
      leavesSurface: true,
    },
    outlets: [
      { pourPoint: [553100.25, 2333000.75], areaM2: 4000, cells: 16000 },
      { pourPoint: [553050, 2333010], outlet: [553050, 2333010], areaM2: 1500, cells: 6000 },
    ],
  },
});

const RAIN = HydroRun.parse({
  ...base,
  id: 'rain-1',
  pipeline: 'hydro.rainfall',
  computedAt: '2026-10-09T07:00:00Z',
  preview: true,
  notes: ['Infiltration as a constant rate of 5 mm/h.'],
  results: {
    durationMin: 60,
    frameMin: 5,
    frames: [],
    rainM3: 1000,
    infiltratedM3: 100,
    outflowM3: 600,
    storedM3: 300,
    massErrorPct: 0,
    peakOutflowM3s: 0.42,
    peakAtMin: 35,
    finalOutflowM3s: 0.05,
    maxDepthM: 0.8,
    steps: 720,
    areaM2: 20000,
  },
});

const runs = (patch: Partial<SiteRuns> = {}): SiteRuns => ({
  basis: surveyBasis(defaultSurveySettings(), manifest.crs, null),
  haul: [HaulRun.parse(haulFixture)],
  hydro: [FLOOD, FLOW, RAIN],
  ...patch,
});

function layout(id: 'haul' | 'hydrology', r: SiteRuns): HTMLElement {
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
      surveySections: runSectionIds(r),
    }),
    text: { summary: '', method: '', findings: '' },
    images: { overview: [] },
    product: 'Quadrion AI',
    survey: null,
    runs: r,
  };
  const fn = SECTION_LAYOUTS[id];
  if (!fn) throw new Error(id);
  pager.start(id);
  fn(pager, ctx, '07');
  return root;
}

const text = (el: Element) => el.textContent.replace(/\s+/g, ' ');
/** Table rows, cells joined with ` | `. */
const rows = (root: Element, cls: string) =>
  [...root.querySelectorAll(`table.${cls} tbody tr`)].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => text(td).trim()).join(' | '),
  );

describe('the haul-road and hydrology sections', () => {
  it('print in the house report only for a project with runs of their kind', () => {
    const model = (surveySections: ReportSectionId[]) =>
      houseReportModel({
        manifest,
        issues: [],
        branding: resolveReportBranding(undefined, 'Quadrion AI'),
        surveySections,
      }).sections;
    expect(model(runSectionIds(runs()))).toEqual(expect.arrayContaining(['haul', 'hydrology']));
    expect(model(runSectionIds(runs({ hydro: [] })))).not.toContain('hydrology');
    expect(model([])).not.toContain('haul');
    expect(runSectionIds(null)).toEqual([]);
  });

  it('reads the runs main named, leaving out a missing or mismatched one', async () => {
    const files: Record<string, unknown> = {
      'survey/haul/example/run.json': haulFixture,
      'survey/hydro/flood-1/run.json': FLOOD,
      'survey/hydro/other/run.json': FLOOD,
      'survey/settings.json': SurveySettings.parse({
        ...defaultSurveySettings(),
        units: { ...defaultSurveySettings().units, distance: 'us-ft' },
      }),
    };
    const r = await readSiteRuns({ json: (p) => Promise.resolve(files[p] ?? null) }, manifest, {
      haul: ['example', 'gone', '../x'],
      hydro: ['flood-1', 'other'],
    });
    expect(r.haul.map((x) => x.id)).toEqual(['example']);
    expect(r.hydro.map((x) => x.id)).toEqual(['flood-1']);
    expect(r.basis.units.distance).toBe('us-ft');
  });

  it('prints a haul-road run: the stations with pass and fail, the failing stretches and the limits', () => {
    const root = layout('haul', runs());
    const t = text(root);
    expect(t).toContain('Haul-road compliance');
    expect(t).toContain('Coordinates in EPSG:32639, grid distances');
    expect(t).toContain('Drawn centreline');
    expect(t).toContain(
      '40.000 m of centreline, a station every 20.000 m, on the surface Quarry DSM',
    );
    const stations = rows(root, 'sv-haul-stations');
    expect(stations).toHaveLength(3);
    expect(stations[0]).toBe(
      '0+001.000 | 20.000 m | 0.0 % | 3.0 % / 3.0 % |  | 1.400 m / Drop | Fail: Berm, right',
    );
    expect(root.querySelectorAll('table.sv-haul-stations tr.fail')).toHaveLength(3);
    expect(rows(root, 'sv-haul-stretches')).toEqual([
      'Berm, right | 0+001.000 | 0+039.000 | 38.000 m | 3',
    ]);
    expect(rows(root, 'sv-haul-limits')).toEqual([
      'Smallest road width | 18.000 m',
      'Steepest grade | 10.0 %',
      'Smallest cross fall | 1.0 %',
      'Largest cross fall | 4.0 %',
      'Lowest berm | 1.000 m',
    ]);
    expect(t).not.toMatch(/[–—]/);
  });

  it('lists at most the cap of stations and says where the rest are', () => {
    const run = HaulRun.parse(haulFixture);
    const first = run.stations[0];
    if (!first) throw new Error('station');
    const many = {
      ...run,
      stations: Array.from({ length: HAUL_STATIONS_MAX + 5 }, () => ({
        ...first,
        status: 'pass' as const,
      })),
      stretches: [],
      params: { ...run.params, limits: {} },
    };
    const root = layout('haul', runs({ haul: [many] }));
    expect(rows(root, 'sv-haul-stations')).toHaveLength(HAUL_STATIONS_MAX);
    const t = text(root);
    expect(t).toContain('And 5 more stations, in the run file (survey/haul/example/run.json).');
    expect(t).toContain('No stretch fails a check.');
    expect(t).toContain('No limits were set');
    expect(stationResult({ ...first, status: 'no-data' })).toBe('No data');
  });

  it('prints flood level, area and volume, the catchments and the rainfall summary with its preview flag', () => {
    const root = layout('hydrology', runs());
    const t = text(root);
    expect(t).toContain('Hydrology');
    // flood: level, area, volume and depth in the site units
    expect(t).toContain('101.250 m');
    expect(t).toContain('1 250.00 m²');
    expect(t).toContain('937.5 m³');
    expect(t).toContain('Water connected to the chosen point');
    // flow: the runoff path and the catchments
    expect(t).toContain(
      'Runoff path: 120.000 m long, falling 6.000 m, leaving the surface at its edge.',
    );
    expect(rows(root, 'sv-hydro-catchments')).toEqual([
      'Main outlet | 553100.25, 2333000.75 | 4 000.00 m² | ',
      '2 | 553050.00, 2333010.00 | 1 500.00 m² | ',
    ]);
    // rainfall: the summary, and the preview flag on that run only
    expect(rows(root, 'sv-hydro-rain')).toEqual([
      'Duration | 60 min',
      'Area | 20 000.00 m²',
      'Rain | 1 000.0 m³',
      'Infiltrated | 100.0 m³',
      'Outflow | 600.0 m³',
      'Stored | 300.0 m³',
      'Peak outflow | 0.420 m³/s after 35 min',
      'Outflow at the end | 0.050 m³/s',
      'Deepest water | 0.800 m',
      'Mass balance error | 0.00 %',
    ]);
    expect(root.querySelectorAll('[data-sv="preview"]')).toHaveLength(1);
    expect(t).toContain('Infiltration as a constant rate of 5 mm/h.');
    expect(t).not.toMatch(/[–—]/);
  });

  it('formats in the site units (US survey feet)', () => {
    const basis = surveyBasis(
      {
        ...defaultSurveySettings(),
        units: { ...defaultSurveySettings().units, distance: 'us-ft' },
      },
      manifest.crs,
      null,
    );
    const root = layout('hydrology', runs({ basis, hydro: [FLOOD] }));
    // 101.25 m and 1.5 m in US survey feet (1200/3937 m)
    expect(text(root)).toContain('332.184 US ft');
    expect(text(root)).toContain('4.921 US ft');
  });
});
