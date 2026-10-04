import type { Issue, ProjectManifest, Sighting } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import {
  NOW,
  catalogue,
  makeIssue,
  meshSighting,
  photoSighting,
  strictModel,
  tankModel,
} from '../testing';
import { createIssueEditor } from './editor';
import type { IssueSaver } from './persist';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel, strictModel],
  classCatalogues: [catalogue],
};

function fakeSaver() {
  const calls: { projectId: string; issues: Issue[] }[] = [];
  const saver: IssueSaver = {
    status: { state: 'saved' },
    schedule: (projectId, issues) => calls.push({ projectId, issues }),
    flush: () => Promise.resolve(),
    subscribe: () => () => undefined,
    cancel: () => undefined,
  };
  return { saver, calls };
}

function setup(issues: Issue[] = [], derive?: (s: Sighting, i: Issue) => Sighting[]) {
  const store = createWorkspace();
  store.getState().openProject({ id: 'hcl', root: 'x', manifest }, issues);
  const { saver, calls } = fakeSaver();
  let n = 0;
  const editor = createIssueEditor({
    store,
    saver,
    author: () => 'DR',
    clock: () => NOW,
    newId: () => `id${++n}`,
    ...(derive ? { derive } : {}),
  });
  return { store, editor, calls };
}

describe('IssueEditor', () => {
  it('creates an issue in the workspace and saves', () => {
    const { store, editor, calls } = setup();
    const r = editor.create({ sighting: photoSighting, classId: 'crack', severity: 4 });
    expect(r.ok).toBe(true);
    expect(store.getState().issues.map((i) => i.code)).toEqual(['F01']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.projectId).toBe('hcl');
  });

  it('refuses an invalid change and leaves state alone', () => {
    const { store, editor, calls } = setup([makeIssue()]);
    const r = editor.update('i1', { severity: 9 });
    expect(r.ok).toBe(false);
    expect(store.getState().issues[0]?.severity).toBe(5);
    expect(calls).toHaveLength(0);
  });

  it('undoes and redoes a create', () => {
    const { store, editor } = setup();
    editor.create({ sighting: photoSighting, classId: 'crack', severity: 4 });
    expect(editor.undo()).toBe(true);
    expect(store.getState().issues).toEqual([]);
    expect(editor.redo()).toBe(true);
    expect(store.getState().issues).toHaveLength(1);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(false);
  });

  it('undoes an edit', () => {
    const { store, editor } = setup([makeIssue()]);
    editor.update('i1', { title: 'Changed' });
    editor.setStatus('i1', 'reviewed');
    editor.undo();
    editor.undo();
    expect(store.getState().issues[0]).toEqual(makeIssue());
  });

  it('moves a sighting and deletes the emptied issue in one undo step', () => {
    const a = makeIssue({ id: 'a', sightings: [photoSighting] });
    const b = makeIssue({ id: 'b', code: 'F02' });
    const { store, editor } = setup([a, b]);
    expect(editor.moveSighting('a', 0, 'b').ok).toBe(true);
    expect(store.getState().issues.map((i) => i.id)).toEqual(['b']);
    expect(store.getState().issues[0]?.sightings).toEqual([meshSighting, photoSighting]);
    editor.undo();
    expect(
      store
        .getState()
        .issues.map((i) => i.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('merges two issues', () => {
    const a = makeIssue({ id: 'a' });
    const b = makeIssue({ id: 'b', code: 'F02', sightings: [photoSighting] });
    const { store, editor } = setup([a, b]);
    editor.merge('a', 'b');
    expect(store.getState().issues).toHaveLength(1);
    expect(store.getState().issues[0]?.sightings).toHaveLength(2);
  });

  it('removes an issue and clears its selection', () => {
    const { store, editor } = setup([makeIssue()]);
    store.getState().select({ kind: 'issue', id: 'i1' });
    editor.remove('i1');
    expect(store.getState().issues).toEqual([]);
    expect(store.getState().selection).toBeNull();
  });

  it('adds derived sightings (back-projection) in the same step', () => {
    const derive = vi.fn((s: Sighting) => (s.on === 'image' ? [meshSighting] : []));
    const { store, editor } = setup([], derive);
    editor.create({ sighting: photoSighting, classId: 'crack', severity: 4 });
    expect(store.getState().issues[0]?.sightings).toEqual([photoSighting, meshSighting]);
    editor.undo();
    expect(store.getState().issues).toEqual([]);
  });

  it('keeps an audit trail per issue', () => {
    const { editor } = setup([makeIssue()]);
    editor.update('i1', { note: 'x' });
    editor.setStatus('i1', 'reviewed');
    expect(editor.audit('i1').map((e) => e.action)).toEqual(['Edit F01', 'F01 to reviewed']);
    expect(editor.audit('i1')[0]).toMatchObject({ author: 'DR', at: NOW });
  });

  it('notifies listeners with undo state', () => {
    const { editor } = setup([makeIssue()]);
    const seen: (string | null)[] = [];
    editor.subscribe(() => seen.push(editor.state.undoLabel));
    editor.update('i1', { note: 'x' });
    expect(seen).toEqual(['Edit F01']);
  });

  it('forgets history when another project opens', () => {
    const { store, editor } = setup([makeIssue()]);
    editor.update('i1', { note: 'x' });
    store.getState().openProject({ id: 'other', root: 'y', manifest }, []);
    expect(editor.state.canUndo).toBe(false);
  });
});

describe('IssueEditor bulk actions', () => {
  const three = () => [
    makeIssue({ id: 'a', code: 'F01', severity: 2 }),
    makeIssue({ id: 'b', code: 'F02', severity: 4, status: 'reviewed' }),
    makeIssue({ id: 'c', code: 'F03', severity: 3, status: 'approved' }),
  ];

  it('sets the status of many issues in one undo step, walking the workflow', () => {
    const { store, editor, calls } = setup(three());
    const r = editor.setStatusMany(['a', 'b', 'c'], 'approved');
    expect(r).toEqual({ changed: 2, skipped: [] });
    expect(store.getState().issues.map((i) => i.status)).toEqual([
      'approved',
      'approved',
      'approved',
    ]);
    expect(calls).toHaveLength(1);
    expect(editor.state.undoLabel).toBe('Set 2 issues to approved');
    editor.undo();
    expect(store.getState().issues.map((i) => i.status)).toEqual(['draft', 'reviewed', 'approved']);
  });

  it('keeps the issue order of the register on bulk edits', () => {
    const { store, editor } = setup(three());
    editor.setStatusMany(['a'], 'reviewed');
    expect(store.getState().issues.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('sets the class of many issues and reports those it cannot change', () => {
    const { store, editor } = setup([...three(), makeIssue({ id: 'd', code: 'F04', severity: 5 })]);
    // pothole uses the 1 to 3 road model: severity 4 and 5 do not fit it
    const r = editor.setClassMany(['a', 'b', 'c', 'd'], 'pothole');
    expect(r.changed).toBe(2);
    expect(r.skipped.map((s) => s.code)).toEqual(['F02', 'F04']);
    expect(store.getState().issues.map((i) => i.classId)).toEqual([
      'pothole',
      'crack',
      'pothole',
      'crack',
    ]);
    editor.undo();
    expect(store.getState().issues.every((i) => i.classId === 'crack')).toBe(true);
  });

  it('merges duplicates into the most severe one in one undo step', () => {
    const { store, editor } = setup(three());
    store.getState().select({ kind: 'issue', id: 'a' });
    const r = editor.mergeMany(['a', 'b', 'c']);
    expect(r.ok && r.value.id).toBe('b');
    const after = store.getState().issues;
    expect(after.map((i) => i.id)).toEqual(['b']);
    expect(after[0]?.sightings).toHaveLength(3);
    expect(after[0]?.note).toContain('Merged F01');
    expect(after[0]?.note).toContain('Merged F03');
    expect(store.getState().selection).toEqual({ kind: 'issue', id: 'b' });
    editor.undo();
    expect(store.getState().issues.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('needs two issues to merge', () => {
    const { editor } = setup(three());
    expect(editor.mergeMany(['a']).ok).toBe(false);
  });
});
