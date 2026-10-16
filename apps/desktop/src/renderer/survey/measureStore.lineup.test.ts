// @vitest-environment jsdom
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it } from 'vitest';
import { copyToSurvey, editEvent, measureStore, setScope, startEditing } from './measureStore';

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
  layers: [],
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

const stored = (id: string) => measureStore.getState().file.measurements.find((m) => m.id === id);

beforeEach(() => {
  workspace.getState().openProject({ id: 'two-dates', root: 'E:/t', manifest });
  measureStore.setState({
    readOnly: false,
    autosave: false,
    tool: null,
    draw: null,
    editing: null,
    selected: ['m-jun'],
    focus: 'm-jun',
    file: {
      schema: 'aio.measurements/1',
      measurements: [
        measurement('m-site', { kind: 'site' }),
        measurement('m-jun', { kind: 'survey', capture: 'jun' }),
      ],
    },
  });
});

describe('editing a measurement of a lined-up date', () => {
  it('edits in the drawn frame and saves a survey-scoped measurement without the shift', () => {
    startEditing();
    expect(measureStore.getState().editing?.points[0]).toEqual([102, 199, 5]);
    // the person types the drawn easting of the first vertex
    editEvent({ type: 'set', vertex: 0, coords: { e: 112 } });
    expect(stored('m-jun')?.points).toEqual([
      [110, 200, 5],
      [103, 204, 5],
    ]);
  });

  it('saves a site measurement as it is drawn', () => {
    measureStore.setState({ focus: 'm-site', selected: ['m-site'] });
    startEditing();
    expect(measureStore.getState().editing?.points[0]).toEqual([100, 200, 5]);
    editEvent({ type: 'set', vertex: 0, coords: { e: 112 } });
    expect(stored('m-site')?.points[0]).toEqual([112, 200, 5]);
  });
});

describe('moving a measurement to another scope', () => {
  it('keeps it where it is drawn when it moves to a lined-up date', () => {
    setScope('m-site', { kind: 'survey', capture: 'jun' });
    expect(stored('m-site')?.points).toEqual([
      [98, 201, 5],
      [101, 205, 5],
    ]);
  });

  it('keeps a copy where the original is drawn', () => {
    copyToSurvey('m-jun', 'jan');
    const copy = measureStore.getState().file.measurements.at(-1);
    expect(copy?.scope).toEqual({ kind: 'survey', capture: 'jan' });
    expect(copy?.points).toEqual([
      [102, 199, 5],
      [105, 203, 5],
    ]);
  });
});
