import type { ProjectManifest, Sighting } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import {
  annotateUi,
  beginSighting,
  cameraSources,
  cancelSighting,
  confirmSighting,
  focusIssue,
  getIssueListActions,
  imageSizeOf,
  issueEditor,
  issueSaver,
  rememberImageSize,
  setAnnotateReadOnly,
  setIssueListActions,
} from './runtime';
import { catalogue, linedUp, makeIssue, meshSighting, photoSighting, tankModel } from './testing';

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

  it("keeps a shape drawn on a lined-up date in the date's own frame", () => {
    workspace.getState().openProject({ id: 'demo', root: 'r', manifest: linedUp }, []);
    const picked: Sighting = {
      on: 'mesh',
      layer: 'model-d2',
      geom: { type: 'spoint', p: [12, 0, 0], n: [0, 1, 0] },
    };
    beginSighting(picked);
    expect(annotateUi.getState().pending?.sighting).toEqual({
      ...picked,
      geom: { type: 'spoint', p: [10, 0, 0], n: [0, 1, 0] },
    });
    // flown to where it is drawn, and the cameras of the date are shifted
    const pending = annotateUi.getState().pending?.sighting;
    const issue = makeIssue({ sightings: pending ? [pending] : [] });
    focusIssue(issue);
    expect(workspace.getState().camera?.target).toEqual({
      kind: 'point',
      p: [12, 0, 0],
      distance: 4,
    });
    expect(cameraSources.shiftOf?.('model-d2')).toEqual({ eastM: 2, northM: 0 });
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

  it('shares remembered sizes and the issue list actions', () => {
    rememberImageSize('photos', 'F09', [640, 480]);
    expect(imageSizeOf('photos', 'F09')).toEqual([640, 480]);
    expect(cameraSources.imageSize('photos', 'F09')).toEqual([640, 480]);
    expect(imageSizeOf('photos', 'nope')).toBeNull();
    const placeOnModel = (ids: readonly string[]) => ids.length;
    const off = setIssueListActions({ placeOnModel });
    expect(getIssueListActions().placeOnModel).toBe(placeOnModel);
    // a stale remover does not take away actions set after it
    const later = { placeOnModel: (ids: readonly string[]) => ids.length + 1 };
    const offLater = setIssueListActions(later);
    off();
    expect(getIssueListActions().placeOnModel).toBe(later.placeOnModel);
    offLater();
    expect(getIssueListActions()).toEqual({});
    expect(getIssueListActions().placeOnModel).toBeUndefined();
  });
});
