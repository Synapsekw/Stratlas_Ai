import type { JobRecord, PipelineName } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { buildParams, FORMS, finishedManifestJob, TILESET_WRITERS, type Field } from './jobs';

const M11: PipelineName[] = [
  'survey.prepare',
  'survey.compare',
  'survey.overlay',
  'survey.section',
  'survey.export',
  'survey.qa',
  'survey.cleanup',
  'design.import',
  'geo.calibration',
  'hydro.flood',
  'hydro.flow',
  'hydro.rainfall',
  'haul.analyse',
];

const job = (pipeline: JobRecord['pipeline'], status: JobRecord['status']): JobRecord => ({
  id: `j-${pipeline}`,
  pipeline,
  project: 'E:/data/projects/site',
  params: {},
  status,
  progress: status === 'done' ? 1 : 0.5,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
});

describe('M11 jobs and the open project', () => {
  it('writes the survey folder only: no manifest reload, no tilesets', () => {
    for (const p of M11) {
      expect(
        finishedManifestJob([job(p, 'running')], [job(p, 'done')], 'e:/data/projects/site'),
        p,
      ).toBe(false);
      expect(TILESET_WRITERS.has(p), p).toBe(false);
    }
  });
});

describe('M11 forms', () => {
  it('has a form for every M11 pipeline', () => {
    for (const p of M11) expect(FORMS[p], p).toBeDefined();
  });

  it('leaves the pipelines with lists of points or surfaces to the Survey panels', () => {
    for (const p of [
      'survey.prepare',
      'survey.compare',
      'survey.section',
      'survey.cleanup',
      'geo.calibration',
      'haul.analyse',
    ] as const) {
      expect(FORMS[p], p).toEqual([]);
      expect(buildParams(p, {}).ok, p).toBe(false);
    }
  });

  it('builds the smallest valid params of the flat pipelines', () => {
    expect(buildParams('survey.overlay', { surface: 'dsm-1', kind: 'contours' })).toEqual({
      ok: true,
      params: { surface: 'dsm-1', kind: 'contours' },
    });
    expect(
      buildParams('survey.export', {
        what: 'surface',
        format: 'geotiff',
        crs: 'site',
        surface: 'dsm-1',
        out: 'D:/out/dsm.tif',
      }),
    ).toEqual({
      ok: true,
      params: {
        what: 'surface',
        format: 'geotiff',
        crs: 'site',
        surface: 'dsm-1',
        out: 'D:/out/dsm.tif',
      },
    });
    expect(
      buildParams('survey.qa', { capture: 'c1', surface: 'dsm-1', level: 'moderate' }),
    ).toEqual({ ok: true, params: { capture: 'c1', surface: 'dsm-1', level: 'moderate' } });
    expect(buildParams('design.import', { src: 'D:/in/design.xml' })).toEqual({
      ok: true,
      params: { src: 'D:/in/design.xml' },
    });
    expect(
      buildParams('design.import', {
        src: 'D:/in/design.dxf',
        format: 'dxf',
        units: 'mm',
        useCalibration: 'true',
      }),
    ).toEqual({
      ok: true,
      params: { src: 'D:/in/design.dxf', format: 'dxf', units: 'mm', useCalibration: true },
    });
    expect(
      buildParams('hydro.flood', { surface: 'dsm-1', levelM: '10', mode: 'all-below' }),
    ).toEqual({ ok: true, params: { surface: 'dsm-1', levelM: 10, mode: 'all-below' } });
    expect(buildParams('hydro.flow', { surface: 'dsm-1', mode: 'catchment' })).toEqual({
      ok: true,
      params: { surface: 'dsm-1', mode: 'catchment' },
    });
    expect(
      buildParams('hydro.rainfall', {
        surface: 'dsm-1',
        hyetograph: 'D:/in/rain.csv',
        manningN: '0.03',
        infiltrationMmPerH: '0',
        cellM: '1',
      }),
    ).toEqual({
      ok: true,
      params: {
        surface: 'dsm-1',
        hyetograph: 'D:/in/rain.csv',
        manningN: 0.03,
        infiltrationMmPerH: 0,
        cellM: 1,
      },
    });
  });

  it('says what is missing or wrong', () => {
    expect(buildParams('hydro.flood', { surface: 'dsm-1', mode: 'all-below' })).toEqual({
      ok: false,
      error: 'Water level (m) is required.',
    });
    expect(
      buildParams('hydro.rainfall', {
        surface: 'dsm-1',
        hyetograph: 'D:/in/rain.csv',
        manningN: '0.03',
        infiltrationMmPerH: '0',
        cellM: '3',
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Cell \(m\): /) as unknown });
  });

  it('offers only values the contract takes in every select', () => {
    for (const p of M11)
      for (const f of FORMS[p].filter((x) => x.kind === 'select' && !x.boolean))
        for (const o of (f.options ?? []).filter((x) => x.value !== '')) {
          const base: Record<string, string> = {};
          for (const g of FORMS[p]) if (g.required) base[g.key] = sample(g);
          const r = buildParams(p, { ...base, [f.key]: o.value });
          expect(r, `${p}.${f.key}=${o.value}`).toMatchObject({ ok: true });
        }
  });
});

/** A valid value for a required field: the first choice, a number, a path or an id. */
function sample(f: Field): string {
  if (f.kind === 'select') return f.options?.find((o) => o.value !== '')?.value ?? '';
  if (f.kind === 'number') return '1';
  if (f.kind === 'file') return 'D:/in/a.csv';
  return 'dsm-1';
}
