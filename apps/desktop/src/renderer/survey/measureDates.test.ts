import type { Layer, ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { captureIndex, createWorkspace, scopedStore } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { measurementsOn } from './measureDates';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture?: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  ...(capture ? { capture } : {}),
});

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Two dates',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    { id: 'jun', label: 'June', date: '2026-06-01' },
  ],
  layers: [mesh('site'), mesh('model-jan', 'jan'), mesh('model-jun', 'jun')],
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
    [0, 0, 0],
    [1, 0, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
});

const state = {
  file: {
    schema: 'aio.measurements/1' as const,
    measurements: [
      measurement('m-site', { kind: 'site' }),
      measurement('m-jan', { kind: 'survey', capture: 'jan' }),
      measurement('m-jun', { kind: 'survey', capture: 'jun' }),
    ],
  },
  editing: null,
  focus: null,
};

const ids = (ms: SurveyMeasurement[]) => ms.map((m) => m.id);

describe('measurementsOn', () => {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'two-dates', root: 'E:/t', manifest });
  // as the app opens a project with dates: the latest survey shows, the earlier one is hidden
  ws.getState().setLayerVisible('model-jan', false);
  const index = captureIndex(manifest);
  ws.getState().setDates(index);

  it('a single view draws the site-wide measurements and those of the survey on screen', () => {
    expect(ids(measurementsOn(state, ws.getState()))).toEqual(['m-site', 'm-jun']);
  });

  it('each side of a split draws the measurements of the date it shows', () => {
    const left = scopedStore(ws, { capture: 'jan', index, mode: 'hide', camera: true });
    const right = scopedStore(ws, { capture: 'jun', index, mode: 'drop', camera: false });
    expect(ids(measurementsOn(state, left.getState()))).toEqual(['m-site', 'm-jan']);
    expect(ids(measurementsOn(state, right.getState()))).toEqual(['m-site', 'm-jun']);
  });

  it('a view without a date of its own sees the workspace as it is', () => {
    expect(ids(measurementsOn(state, scopedStore(ws).getState()))).toEqual(['m-site', 'm-jun']);
  });

  it('the measurement being edited stays on every view', () => {
    const left = scopedStore(ws, { capture: 'jan', index, mode: 'hide', camera: true });
    const editing = { ...state, editing: { points: [] } as never, focus: 'm-jun' };
    expect(ids(measurementsOn(editing, left.getState()))).toEqual(['m-site', 'm-jan', 'm-jun']);
  });
});
