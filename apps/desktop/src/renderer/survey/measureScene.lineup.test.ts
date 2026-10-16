// @vitest-environment jsdom
import type { Layer, ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { captureIndex } from '@aio/workspace';
import { beforeEach, describe, expect, it } from 'vitest';
import { shapesOf } from './measureScene';
import { measureStore } from './measureStore';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  capture,
});

/** The second date is lined up 2 m east and 1 m south. */
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Two dates',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    {
      id: 'jun',
      label: 'June',
      date: '2026-06-01',
      lineUp: { eastM: 2, northM: -1, with: 'jan', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [mesh('model-jan', 'jan'), mesh('model-jun', 'jun')],
  severityModels: [],
  classCatalogues: [],
};

const measurement = (id: string, scope: SurveyMeasurement['scope']): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'distance',
  label: id,
  scope,
  points: [
    [100, 200, 5],
    [103, 204, 5],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
});

beforeEach(() => {
  measureStore.setState({
    editing: null,
    focus: null,
    selected: [],
    file: {
      schema: 'aio.measurements/1',
      measurements: [
        measurement('m-site', { kind: 'site' }),
        measurement('m-jan', { kind: 'survey', capture: 'jan' }),
        measurement('m-jun', { kind: 'survey', capture: 'jun' }),
      ],
    },
  });
});

const ws = { dates: captureIndex(manifest), hidden: {} };
const pointsOf = (id: string) =>
  shapesOf(measureStore.getState(), ws, manifest, 'grid north').find((s) => s.id === id)?.points;

describe('measurements in the views', () => {
  it('draws a survey-scoped measurement with its date shift', () => {
    expect(pointsOf('m-jun')).toEqual([
      [102, 199, 5],
      [105, 203, 5],
    ]);
  });

  it('leaves a site measurement where it is', () => {
    expect(pointsOf('m-site')).toEqual([
      [100, 200, 5],
      [103, 204, 5],
    ]);
    // a date without a shift stays too
    expect(pointsOf('m-jan')).toEqual([
      [100, 200, 5],
      [103, 204, 5],
    ]);
  });
});
