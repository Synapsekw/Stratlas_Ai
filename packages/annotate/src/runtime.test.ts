import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import {
  annotateUi,
  beginSighting,
  cancelSighting,
  confirmSighting,
  focusIssue,
  issueEditor,
  issueSaver,
  setAnnotateReadOnly,
} from './runtime';
import { catalogue, makeIssue, meshSighting, photoSighting, tankModel } from './testing';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel],
  classCatalogues: [catalogue],
};

describe('annotation runtime', () => {
  afterEach(() => {
    issueSaver.cancel();
    annotateUi.setState({ pending: null, attachToSelected: false });
    workspace.getState().closeProject();
  });

  it('in a read-only package a finished shape opens nothing and the editor refuses changes', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, []);
    setAnnotateReadOnly(true);
    try {
      beginSighting(photoSighting, { x: 10, y: 20 });
      expect(annotateUi.getState().pending).toBeNull();
      const r = issueEditor.create({ sighting: photoSighting, classId: 'crack', severity: 4 });
      expect(r.ok).toBe(false);
      expect(workspace.getState().issues).toEqual([]);
      expect(issueSaver.status.state).toBe('saved');
    } finally {
      setAnnotateReadOnly(false);
    }
  });

  it('a finished shape opens the picker, and confirming creates and selects the issue', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, []);
    beginSighting(photoSighting, { x: 10, y: 20 });
    expect(annotateUi.getState().pending?.sighting).toEqual(photoSighting);
    expect(confirmSighting('crack', 4)).toBeNull();
    const [issue] = workspace.getState().issues;
    expect(issue).toMatchObject({ code: 'F01', classId: 'crack', severity: 4, status: 'draft' });
    expect(workspace.getState().selection).toEqual({ kind: 'issue', id: issue?.id });
    expect(annotateUi.getState()).toMatchObject({
      pending: null,
      lastClassId: 'crack',
      lastSeverity: 4,
    });
    expect(issueSaver.status.state).toBe('pending');
  });

  it('reports an invalid choice and keeps the shape', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, []);
    beginSighting(photoSighting);
    expect(confirmSighting('pothole', 3)).toContain('is not in the project');
    expect(annotateUi.getState().pending).not.toBeNull();
    cancelSighting();
    expect(annotateUi.getState().pending).toBeNull();
  });

  it('attaches to the selected issue when asked to', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [makeIssue()]);
    workspace.getState().select({ kind: 'issue', id: 'i1' });
    annotateUi.setState({ attachToSelected: true });
    beginSighting(photoSighting);
    expect(workspace.getState().issues[0]?.sightings).toEqual([meshSighting, photoSighting]);
  });

  it('focusing an issue selects it and flies to its best sighting', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [makeIssue()]);
    const issue = workspace.getState().issues[0];
    if (!issue) throw new Error('no issue');
    focusIssue(issue);
    expect(workspace.getState().selection).toEqual({ kind: 'issue', id: 'i1' });
    expect(workspace.getState().camera?.target).toEqual({
      kind: 'point',
      p: [1, 2, 3],
      distance: 4,
    });
  });
});
