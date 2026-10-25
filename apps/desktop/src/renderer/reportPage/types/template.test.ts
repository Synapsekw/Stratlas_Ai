// The report-type seam: the registry holds one template per report type, the volumetric one is
// offered for projects with stockpile volumes, and its render lays out one A4 page per printed page
// of the page plan, for the report pages that have a component.
import { pagePlan, type VolumetricInput } from '@aio/project/export';
import {
  ReportPageId,
  ReportTypeId,
  VolumetricTextId,
  type ProjectManifest,
  type ReportViewsFrame,
  type SurveyMeasurement,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { SurveyFiles } from '../house/surveyData';
import { REPORT_TEMPLATES, volumetricTemplate } from './index';
import { NO_VIEWS, reportViews } from './template';

const square = (e: number): [number, number][] => [
  [e, 0],
  [e + 10, 0],
  [e + 10, 10],
  [e, 10],
];

const INPUT: VolumetricInput = {
  captures: [
    { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
    { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
  ],
  piles: Array.from({ length: 13 }, (_, i) => ({
    id: `m${String(i)}`,
    label: `P${String(i + 1).padStart(2, '0')}`,
    material: null,
    base: 'Lowest point on the outline',
    dates: ['c1', 'c2'].map((capture, k) => ({
      capture,
      volumeM3: 100 * (i + 1) + k * 10,
      densityTPerM3: null,
      areaM2: 100,
      peakM: 3,
      plusMinusM3: null,
      outline: square(20 * i),
    })),
  })),
  project: { name: 'Demo yard', customer: null, site: null, crs: 'EPSG:32632' },
  method: { cellM: null, gsdCm: null, siteDensityTPerM3: null },
  frame: null,
};

const pile = (over: Partial<SurveyMeasurement>): SurveyMeasurement => ({
  id: 'p1',
  family: 'polygon',
  tool: 'volume',
  label: 'P01',
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-16T00:00:00Z',
  ...over,
});

const project = (measurements: SurveyMeasurement[] | null) => ({
  manifest: { name: 'Demo yard' } as ProjectManifest,
  survey: measurements ? ({ measurements } as unknown as SurveyFiles) : null,
});

describe('the report-type seam', () => {
  it('registers one template per report type', () => {
    expect(Object.keys(REPORT_TEMPLATES).sort()).toEqual([...ReportTypeId.options].sort());
    expect(REPORT_TEMPLATES.volumetric).toBe(volumetricTemplate);
    expect(volumetricTemplate.id).toBe('volumetric');
    expect(volumetricTemplate.textParts).toEqual(VolumetricTextId.options);
    expect(volumetricTemplate.pages).toEqual(ReportPageId.options);
  });

  it('offers the volumetric report for a project with a stockpile volume', () => {
    expect(volumetricTemplate.offered(project([pile({})]))).toBe(true);
    expect(volumetricTemplate.offered(project([pile({ family: 'line', tool: 'distance' })]))).toBe(
      false,
    );
    expect(volumetricTemplate.offered(project([]))).toBe(false);
    expect(volumetricTemplate.offered(project(null))).toBe(false);
  });

  it("builds the model from the app's figures", () => {
    const model = volumetricTemplate.model(INPUT);
    expect(model.piles).toHaveLength(13);
    expect(model.piles[0]?.label).toBe('P13');
  });

  it('lays out one page per printed page of the plan, numbered, with the cover first', () => {
    const model = volumetricTemplate.model(INPUT);
    const pages = volumetricTemplate.render(model, { parts: {}, pileNotes: {} }, NO_VIEWS);
    const known = pages.map((p) => p.page);
    // the cover and its continued page; the pages B and C add theirs when registered
    expect(known.slice(0, 2)).toEqual(['cover', 'cover']);
    expect(pages[1]?.continued).toBe(true);
    expect(pages.map((p) => p.number)).toEqual(pages.map((_, k) => k + 1));
    const planned = pagePlan(
      model,
      Object.fromEntries(ReportPageId.options.map((id) => [id, known.includes(id)])),
    );
    expect(pages.map((p) => [p.page, p.from, p.to])).toEqual(
      planned.map((p) => [p.page, p.from, p.to]),
    );
  });

  it('leaves out a page the person turned off, keeping at least one', () => {
    const model = volumetricTemplate.model({ ...INPUT, pages: { cover: false } });
    const pages = volumetricTemplate.render(model, { parts: {}, pileNotes: {} }, NO_VIEWS);
    expect(pages.length).toBeGreaterThan(0);
  });

  it('finds a picture by kind and date through the frame', () => {
    const frame: ReportViewsFrame = {
      schema: 'aio.report-views/1',
      extent: [0, 0, 10, 10],
      widthPx: 100,
      heightPx: 100,
      mPerPx: 0.1,
      views: [
        { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
        { name: 'cutfill-c2', kind: 'cutfill', capture: 'c2', pair: 'c1', file: 'cutfill-c2.jpg' },
      ],
      markers3d: {},
      fingerprint: 'f',
    };
    const v = reportViews(frame, (f) => `x/${f}`);
    expect(v.picture('photo', 'c2')).toBe('x/photo-c2.jpg');
    expect(v.picture('cutfill', 'c2', 'c1')).toBe('x/cutfill-c2.jpg');
    expect(v.picture('cutfill', 'c2', 'c0')).toBeNull();
    expect(v.picture('photo', 'c1')).toBeNull();
    expect(NO_VIEWS.picture('photo', 'c2')).toBeNull();
  });
});
