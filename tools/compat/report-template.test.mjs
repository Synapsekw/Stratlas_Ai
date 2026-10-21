// Volumetric parity wave 1 contracts (spec 2026-10-20-volumetric-parity-design) are additive,
// pinned against the 0.21 schema (tools/compat/schema-0.21):
// - `MeasurementsFile` and `SurveySettings` are loose objects, so 0.21 opens a file carrying
//   origin, series, previousResults, kitPilesConverted, carried, uncertainty and angles, and keeps
//   every one of them when it writes the file back;
// - `report/template.json` is a file 0.21 never opens, and `volume-over-time` is a report section
//   id 0.21 does not know (it sits in `reportSectionsExtra`).
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const result = {
  item: 'cmp-1',
  status: 'ok',
  cutM3: 12.5,
  fillM3: 40,
  netM3: 27.5,
  totalM3: 52.5,
  areaM2: 200,
  areaCutM2: 60,
  areaFillM2: 120,
  areaUnchangedM2: 20,
  uncoveredM2: 0,
  fromLabel: 'Survey A',
  toLabel: 'Survey B',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0,
  engine: 'ts',
  fingerprint: 'kit:Pile 1:e1:tin',
  computedAt: '2026-10-20T08:00:00Z',
  carried: { from: 'kit', base: 'tin', pile: 'Pile 1', epoch: 'e1' },
  uncertainty: { plusMinusM3: 3, sigmaM: 0.05, source: 'checkpoints' },
};

const measurements = () => ({
  schema: 'aio.measurements/1',
  kitPilesConverted: ['Pile 1'],
  measurements: [
    {
      id: 'm-1',
      family: 'polygon',
      tool: 'volume',
      label: 'Stockpile A',
      scope: { kind: 'survey', capture: 'c1' },
      points: [[500000, 2900000, 10]],
      items: [],
      results: [result],
      origin: { kind: 'kit-pile', pile: 'Pile 1' },
      series: [result],
      previousResults: [
        { netM3: 1, totalM3: 2, label: 'Before', replacedAt: '2026-10-20T09:00:00Z' },
      ],
      createdAt: '2026-10-20T08:00:00Z',
    },
  ],
});

describe('volumetric parity contracts are additive', () => {
  it('0.21 opens a measurements file with every new field and keeps them', () => {
    const r = v021.MeasurementsFile.safeParse(measurements());
    expect(r.success).toBe(true);
    expect(r.data.kitPilesConverted).toEqual(['Pile 1']);
    expect(r.data.measurements[0].origin).toEqual({ kind: 'kit-pile', pile: 'Pile 1' });
    expect(r.data.measurements[0].series).toHaveLength(1);
    expect(r.data.measurements[0].results[0].carried.base).toBe('tin');
    expect(current.MeasurementsFile.safeParse(r.data).success).toBe(true);
  });

  it('0.21 opens survey settings with angles and keeps them', () => {
    const settings = { ...current.defaultSurveySettings(), angles: current.DEFAULT_ANGLES };
    const r = v021.SurveySettings.safeParse(settings);
    expect(r.success).toBe(true);
    expect(r.data.angles).toEqual(current.DEFAULT_ANGLES);
  });

  it('a later build may add entry kinds, parts and sections to the report template', () => {
    const later = {
      schema: 'aio.report-template/1',
      entries: [
        { kind: 'banner', text: 'x' },
        {
          kind: 'measurement',
          id: 'm-1',
          parts: ['value', 'photo'],
          addedAt: '2026-10-20T08:00:00Z',
        },
        { kind: 'section', section: 'drone-photos' },
      ],
      layout: { columns: 2 },
    };
    const r = current.ReportTemplateFile.safeParse(later);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(later);
  });

  it('the report template is a family 0.21 does not know', () => {
    expect(current.SCHEMA_REGISTRY.some((e) => e.family === 'aio.report-template')).toBe(true);
    expect(v021.SCHEMA_REGISTRY.some((e) => e.family === 'aio.report-template')).toBe(false);
    expect(v021.ReportSectionId.safeParse('volume-over-time').success).toBe(false);
    expect(current.ReportSectionId.safeParse('volume-over-time').success).toBe(true);
  });
});
