import { defaultSurveySettings, type DesignsFile, type MeasurementsFile } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  exportFileName,
  exportParams,
  exportProblem,
  exportSuffix,
  measurementIds,
  siteSuffix,
  sourcesFor,
  type ExportChoice,
  type ExportCrs,
  type ExportUnits,
} from './exportHelpers';

interface NameCase {
  crs: ExportCrs;
  calibrated: boolean;
  vertical: string;
  geoid: string | null;
  units: ExportUnits;
  suffix: string;
}
const names = JSON.parse(
  readFileSync(new URL('./__fixtures__/export-names.json', import.meta.url), 'utf8'),
) as { cases: NameCase[] };

describe('exportSuffix', () => {
  it.each(names.cases)('$suffix (the rule the pipeline writes)', (c) => {
    expect(exportSuffix(c.crs, c.calibrated, c.vertical, c.geoid, c.units)).toBe(c.suffix);
  });

  it('follows the site settings', () => {
    const s = defaultSurveySettings();
    expect(siteSuffix(s, 'site', 'us-ft')).toBe('_site-grid_usft');
    const cal = { ...s, calibration: 'cal-1', verticalDatum: { kind: 'calibration' as const } };
    expect(siteSuffix(cal, 'site', 'm')).toBe('_site-grid-cal_cal_m');
    expect(siteSuffix(cal, 'wgs84', 'm')).toBe('_wgs84_ellh_m');
    expect(exportFileName('Pad design, Pad top', '_site-grid_m', 'landxml')).toBe(
      'Pad-design-Pad-top_site-grid_m.xml',
    );
  });
});

const designs: DesignsFile = {
  schema: 'aio.designs/1',
  designs: [
    {
      id: 'pad',
      name: 'Pad design',
      src: 'pad.xml',
      sha256: '0'.repeat(64),
      bytes: 1,
      format: 'landxml',
      units: 'm',
      calibrated: false,
      importedAt: '2026-10-09T00:00:00Z',
      layers: [
        {
          id: 'top',
          name: 'Pad top',
          kind: 'surface',
          file: 'top.tin',
          counts: {},
          visible: true,
          archived: false,
          verticalOffsetM: 0,
        },
        {
          id: 'cl',
          name: 'CL1',
          kind: 'alignment',
          file: 'cl.alignment.json',
          counts: {},
          visible: true,
          archived: false,
          verticalOffsetM: 0,
        },
      ],
    },
  ],
};

const base: ExportChoice = {
  what: 'surface',
  format: 'landxml',
  crs: 'site',
  units: 'm',
  detail: 1,
  source: null,
  measurements: [],
  surface: null,
};

describe('sources and parameters', () => {
  it('offers prepared surfaces, whole designs and their layers, and difference overlays', () => {
    const src = sourcesFor('surface', {
      surfaces: [],
      designs,
      overlays: null,
      manifest: null,
    });
    expect(src.map((s) => s.label)).toEqual([
      'Pad design (whole design)',
      'Pad design, Pad top',
      'Pad design, CL1',
    ]);
    expect(src[0]?.param).toEqual({ layer: 'pad' });
    expect(src[1]?.param).toEqual({ layer: 'pad/top' });
  });

  it('builds parameters the schema takes, with the destination as out', () => {
    const p = exportParams(
      { ...base, source: { key: 'k', label: 'x', param: { layer: 'pad' } }, detail: 0.25 },
      'E:/out/pad_site-grid_m.xml',
    );
    expect(p).toEqual({
      what: 'surface',
      format: 'landxml',
      crs: 'site',
      units: 'm',
      decimate: 0.25,
      layer: 'pad',
      out: 'E:/out/pad_site-grid_m.xml',
    });
    const m = exportParams(
      { ...base, what: 'measurements', format: 'csv', measurements: ['a', 'b'], detail: 0.25 },
      'E:/out/m.csv',
    );
    expect(m.decimate).toBeUndefined();
    expect(m.measurements).toEqual(['a', 'b']);
  });

  it('says why a choice cannot be exported', () => {
    expect(exportProblem({ ...base, format: 'laz' })).toMatch(/Surface exports as/);
    expect(exportProblem({ ...base, format: 'kml' })).toMatch(/WGS 84/);
    expect(exportProblem({ ...base, crs: 'wgs84' })).toMatch(/grid coordinates/);
    expect(exportProblem({ ...base, crs: { epsg: 0 } })).toMatch(/EPSG code/);
    expect(exportProblem(base)).toMatch(/Pick what/);
    expect(exportProblem({ ...base, what: 'section', format: 'csv' })).toMatch(/line measurements/);
  });

  it('picks measurements by selection, folder or all, lines only for sections', () => {
    const file: MeasurementsFile = {
      schema: 'aio.measurements/1',
      measurements: [
        {
          id: 'a',
          family: 'polygon',
          tool: 'volume',
          label: 'A',
          folder: 'Piles',
          scope: { kind: 'site' },
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
          items: [],
          results: [],
          createdAt: '2026-10-09T00:00:00Z',
        },
        {
          id: 'b',
          family: 'line',
          tool: 'section',
          label: 'B',
          scope: { kind: 'site' },
          points: [
            [0, 0, 0],
            [5, 0, 0],
          ],
          items: [],
          results: [],
          createdAt: '2026-10-09T00:00:00Z',
        },
      ],
    };
    expect(measurementIds(file, { kind: 'all' }, false)).toEqual(['a', 'b']);
    expect(measurementIds(file, { kind: 'folder', folder: 'Piles' }, false)).toEqual(['a']);
    expect(measurementIds(file, { kind: 'selected', ids: ['a', 'b'] }, true)).toEqual(['b']);
  });
});
