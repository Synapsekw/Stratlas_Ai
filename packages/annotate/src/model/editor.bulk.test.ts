import type { ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { catalogue, makeIssue, photoSighting, strictModel, tankModel } from '../testing';
import { createIssueEditor } from './editor';
import { mapSeverity } from './severityMap';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel, strictModel],
  classCatalogues: [catalogue],
};

function setup(
  issues = [makeIssue({ id: 'i1', code: 'F01' }), makeIssue({ id: 'i2', code: 'F02' })],
) {
  const store = createWorkspace();
  store.setState({ project: { id: 'p', root: '/p', manifest }, issues });
  let n = 0;
  const editor = createIssueEditor({ store, newId: () => `n${String(++n)}` });
  return { store, editor };
}

describe('mapSeverity', () => {
  it('keeps a level the new model has, else takes the nearest (ties go up)', () => {
    expect(mapSeverity(2, strictModel)).toBe(2);
    expect(mapSeverity(5, strictModel)).toBe(3);
    expect(mapSeverity(0, strictModel)).toBe(1);
    const gappy = {
      ...strictModel,
      levels: [1, 3].map((v) => ({ value: v, label: String(v), color: '#000000', criteria: '' })),
    };
    expect(mapSeverity(2, gappy)).toBe(3);
  });
  it('keeps uncertain where the model has it, else the highest level', () => {
    expect(mapSeverity('uncertain', tankModel)).toBe('uncertain');
    expect(mapSeverity('uncertain', strictModel)).toBe(3);
  });
});

describe('createMany', () => {
  it('createMany numbers the issues in sequence as one command', () => {
    const { store, editor } = setup();
    const r = editor.createMany(
      [
        { sighting: photoSighting, classId: 'crack', severity: 3 },
        { sighting: photoSighting, classId: 'blister', severity: 2 },
        { sighting: photoSighting, classId: 'pothole', severity: 1 },
      ],
      'Accept 3 detections',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.map((i) => i.code)).toEqual(['F03', 'F04', 'F05']);
    expect(store.getState().issues).toHaveLength(5);
    expect(editor.state.undoLabel).toBe('Accept 3 detections');
    expect(editor.undo()).toBe(true);
    expect(store.getState().issues.map((i) => i.code)).toEqual(['F01', 'F02']);
    expect(editor.redo()).toBe(true);
    expect(store.getState().issues).toHaveLength(5);
  });

  it('creates nothing when one input is refused', () => {
    const { store, editor } = setup();
    const r = editor.createMany(
      [
        { sighting: photoSighting, classId: 'crack', severity: 3 },
        { sighting: photoSighting, classId: 'nope', severity: 2 },
      ],
      'Accept 2 detections',
    );
    expect(r.ok).toBe(false);
    expect(store.getState().issues).toHaveLength(2);
    expect(editor.state.canUndo).toBe(false);
  });

  it('is a no-op for an empty list', () => {
    const { editor } = setup();
    expect(editor.createMany([], 'Accept 0 detections')).toEqual({ ok: true, value: [] });
    expect(editor.state.canUndo).toBe(false);
  });
});

describe('reassignClass', () => {
  it('moves every issue of a class in one step, mapping severities to the new model', () => {
    const { store, editor } = setup([
      makeIssue({ id: 'i1', code: 'F01', classId: 'crack', severity: 5 }),
      makeIssue({ id: 'i2', code: 'F02', classId: 'crack', severity: 'uncertain' }),
      makeIssue({ id: 'i3', code: 'F03', classId: 'blister', severity: 2 }),
    ]);
    const r = editor.reassignClass('crack', 'pothole');
    expect(r).toEqual({ changed: 2, skipped: [] });
    const [a, b, c] = store.getState().issues;
    expect(a).toMatchObject({ classId: 'pothole', severityModelId: 'road-3', severity: 3 });
    expect(b).toMatchObject({ classId: 'pothole', severityModelId: 'road-3', severity: 3 });
    expect(c).toMatchObject({ classId: 'blister' });
    expect(editor.state.undoLabel).toBe('Move 2 issues from Crack to Pothole');
    editor.undo();
    expect(store.getState().issues.map((i) => i.classId)).toEqual(['crack', 'crack', 'blister']);
  });

  it('skips every issue when the target class does not exist', () => {
    const { editor } = setup([makeIssue({ id: 'i1', code: 'F01', classId: 'crack' })]);
    const r = editor.reassignClass('crack', 'nope');
    expect(r.changed).toBe(0);
    expect(r.skipped).toHaveLength(1);
  });
});
