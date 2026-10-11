// @vitest-environment jsdom
import { defaultToolContext, type AppHooks } from '@aio/ai';
import { DEFAULT_ISSUE_VIEW, issueView, resetIssueView, setIssueView } from '@aio/annotate';
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detections } from '../detections/store';
import { evidence } from '../issueCard/evidence';
import { DEFAULT_MEDIA_VIEW, mediaView, setMediaView } from '../screens/mediaView';
import { shell } from '../shell';
import type { Screen } from '../store';
import { stagePrefs } from '../workspace/stagePrefs';
import { registerAgentHooks } from './hooks';

const photos = (ids: string[]) => ids.map((id) => ({ id, src: { path: `photos/${id}.jpg` } }));

const manifest = (id: string): ProjectManifest => ({
  schema: 'aio.project/1',
  id,
  name: `Tank farm ${id}`,
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Drone photos',
      visible: true,
      items: photos(['p0', 'p1', 'p2', 'p3', 'p4']),
    },
    {
      kind: 'photos',
      id: 'thermal',
      name: 'Thermal photos',
      visible: true,
      items: photos(['t0', 't1']),
    },
  ],
  severityModels: [
    {
      id: 'sev',
      name: 'Kit',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
        { value: 3, label: 'Severe', color: '#ee3f4b', criteria: '' },
      ],
      uncertain: { label: 'Uncertain', color: '#b68ef8' },
    },
  ],
  classCatalogues: [],
});
const project = (id: string) => ({ id, root: `E:/projects/${id}`, manifest: manifest(id) });

function issue(id: string, severity: Issue['severity'], photo: string): Issue {
  return {
    id,
    code: `D${id.padStart(2, '0')}`,
    classId: 'crack',
    severityModelId: 'sev',
    severity,
    status: 'reviewed',
    title: id,
    note: '',
    author: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    sightings: [
      { on: 'image', layer: 'photos', photo, geom: { type: 'box', x: 10, y: 20, w: 30, h: 40 } },
    ],
    source: 'import',
  };
}

// p1 level 1; p2 levels 2 and 3; p3 level 3; p4 level 2; p0 and the thermal photos nothing
const ISSUES = [
  issue('1', 1, 'p1'),
  issue('2', 2, 'p2'),
  issue('3', 3, 'p2'),
  issue('4', 3, 'p3'),
  issue('5', 2, 'p4'),
];

/** A review detection on a thermal photo, graded Severe, still waiting. */
const detection: Detection = {
  id: 'd',
  pass: 'review.json',
  source: { kind: 'photo', layer: 'thermal', photo: 't0' },
  size: [1, 1],
  geom: { type: 'box', x: 0.25, y: 0.5, w: 0.25, h: 0.25 },
  classId: 'crack',
  severity: 3,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'human', author: 'x' },
};

function reviewed(projectId: string) {
  detections.setState({
    projectId,
    review: reviewReducer(initialReview(), { type: 'load', detections: [detection] }),
  });
}

/** A hook as the agent's tools reach it: through the app hooks of the tool context. */
function hook<K extends keyof AppHooks>(name: K): NonNullable<AppHooks[K]> {
  const found = defaultToolContext('photo').app?.[name];
  if (!found) throw new Error(`The ${name} hook is not registered`);
  return found;
}

let unregister: () => void;
beforeEach(() => {
  unregister = registerAgentHooks();
  shell.setState({ screen: 'scene', stageMode: '3d', stageAuto: false });
  shell.getState().setAgentDock(true);
  workspace.getState().openProject(project('p1'), ISSUES);
  mediaView.setState(DEFAULT_MEDIA_VIEW);
  resetIssueView();
});
afterEach(() => {
  unregister();
  evidence.setState({ open: null });
  stagePrefs.getState().update('p1', { split: undefined });
  workspace.getState().closeProject();
  detections.setState({ projectId: null, review: initialReview() });
});

describe('registering the hooks', () => {
  it('gives the tools every hook, and takes them back', () => {
    const names = [
      'screen',
      'openScreen',
      'showPhotos',
      'showIssues',
      'showEvidence',
      'captureView',
      'viewFilters',
    ] as const;
    for (const name of names) expect(hook(name), name).toBeTypeOf('function');
    unregister();
    const app = defaultToolContext('photo').app;
    for (const name of names) expect(app?.[name], name).toBeUndefined();
  });
});

describe('the screen', () => {
  it('is the project screen that shows, and "other" anywhere else', () => {
    for (const screen of ['scene', 'issues', 'media', 'detections', 'reports'] as const) {
      shell.setState({ screen });
      expect(hook('screen')()).toBe(screen);
    }
    const others: Screen[] = ['projects', 'welcome', 'review', 'settings', 'globe'];
    for (const screen of others) {
      shell.setState({ screen });
      expect(hook('screen')(), screen).toBe('other');
    }
  });

  it('opens with the agent column unfolded on the screens that have it', () => {
    hook('openScreen')('media');
    expect(shell.getState().screen).toBe('media');
    expect(shell.getState().agentDockCollapsed).toBe(false);
  });

  it('leaves the column as it is when the Scene opens', () => {
    hook('openScreen')('scene');
    expect(shell.getState().screen).toBe('scene');
    expect(shell.getState().agentDockCollapsed).toBe(true);
    shell.getState().setAgentDock(false);
    shell.setState({ screen: 'issues' });
    hook('openScreen')('scene');
    expect(shell.getState().screen).toBe('scene');
    expect(shell.getState().agentDockCollapsed).toBe(false);
  });
});

describe('showing photos', () => {
  it('resolves "highest" to the highest level present and says what Media shows', () => {
    const view = hook('showPhotos')({ severity: 'highest' });
    expect(mediaView.getState()).toEqual({
      onlyFindings: false,
      order: 'file',
      severity: 3,
      scope: null,
    });
    // p2 and p3 carry a Severe finding; seven photos in the two sets
    expect(view).toEqual({ shown: 2, total: 7, severity: 3, severityLabel: 'Severe' });
  });

  it('replaces the filter: what is not named goes back to its default', () => {
    setMediaView({
      onlyFindings: true,
      order: 'count',
      severity: 1,
      scope: { label: 'Some', ids: ['photos/p1'] },
    });
    expect(hook('showPhotos')({})).toEqual({
      shown: 7,
      total: 7,
      severity: null,
      severityLabel: '',
    });
    expect(mediaView.getState()).toEqual(DEFAULT_MEDIA_VIEW);
  });

  it('counts only the photos with findings when asked, in the order asked', () => {
    const view = hook('showPhotos')({ onlyFindings: true, order: 'severity' });
    expect(view).toMatchObject({ shown: 4, total: 7, severity: null });
    expect(mediaView.getState()).toMatchObject({ onlyFindings: true, order: 'severity' });
  });

  it('shows only the photos of a scope, and takes "highest" within it', () => {
    const scope = { label: 'On Tank T-101', ids: ['photos/p1', 'photos/p4'] };
    expect(hook('showPhotos')({ scope })).toMatchObject({ shown: 2, total: 7 });
    expect(mediaView.getState().scope).toEqual(scope);
    // the worst on those two photos is Moderate, on p4
    expect(hook('showPhotos')({ scope, severity: 'highest' })).toEqual({
      shown: 1,
      total: 7,
      severity: 2,
      severityLabel: 'Moderate',
    });
    expect(mediaView.getState().severity).toBe(2);
  });

  it('names one level, and Uncertain', () => {
    expect(hook('showPhotos')({ severity: 1 })).toEqual({
      shown: 1,
      total: 7,
      severity: 1,
      severityLabel: 'Minor',
    });
    expect(hook('showPhotos')({ severity: 'uncertain' })).toEqual({
      shown: 0,
      total: 7,
      severity: 'uncertain',
      severityLabel: 'Uncertain',
    });
  });

  it('counts the review detections of this project, as Media does', () => {
    reviewed('p1');
    // the Severe detection on a thermal photo joins p2 and p3
    expect(hook('showPhotos')({ severity: 'highest' })).toMatchObject({ shown: 3, severity: 3 });
    // a review left over from another project is not this project's
    reviewed('p2');
    expect(hook('showPhotos')({ severity: 'highest' })).toMatchObject({ shown: 2, severity: 3 });
  });

  it('sets no level when nothing is graded, without failing', () => {
    workspace.getState().openProject(project('p1'), []);
    expect(hook('showPhotos')({ severity: 'highest', onlyFindings: true })).toEqual({
      shown: 0,
      total: 7,
      severity: null,
      severityLabel: '',
    });
    expect(mediaView.getState()).toMatchObject({ severity: null, onlyFindings: true });
  });

  it('has no label for a level of a project without a severity model', () => {
    const bare = project('p1');
    bare.manifest.severityModels = [];
    workspace.getState().openProject(bare, ISSUES);
    expect(hook('showPhotos')({ severity: 'highest' })).toEqual({
      shown: 2,
      total: 7,
      severity: 3,
      severityLabel: '',
    });
  });

  it('shows nothing and leaves the filter alone without a project', () => {
    workspace.getState().closeProject();
    setMediaView({ order: 'count' });
    expect(hook('showPhotos')({ severity: 'highest', onlyFindings: true })).toEqual({
      shown: 0,
      total: 0,
      severity: null,
      severityLabel: '',
    });
    expect(mediaView.getState()).toEqual({ ...DEFAULT_MEDIA_VIEW, order: 'count' });
  });
});

describe('showing findings', () => {
  it('sets the register and says how many it shows', () => {
    expect(hook('showIssues')({ severity: 2, sort: 'severity' })).toEqual({ shown: 2 });
    expect(issueView.getState()).toEqual({ ...DEFAULT_ISSUE_VIEW, sev: 2, sort: 'severity' });
  });

  it('replaces the filter: what is not named goes back to its default', () => {
    setIssueView({
      sev: 3,
      classId: 'weld',
      status: 'closed',
      text: 'roof',
      sort: 'updated',
      dir: 'desc',
      groupBy: 'class',
      scope: { label: 'Some', ids: ['1'] },
    });
    expect(hook('showIssues')({})).toEqual({ shown: 5 });
    expect(issueView.getState()).toEqual(DEFAULT_ISSUE_VIEW);
  });

  it('takes a class, a status, a direction and a scope', () => {
    const scope = { label: 'On Tank T-101', ids: ['1', '4', '5'] };
    expect(
      hook('showIssues')({ classId: 'crack', status: 'reviewed', dir: 'desc', scope }),
    ).toEqual({ shown: 3 });
    expect(issueView.getState()).toEqual({
      ...DEFAULT_ISSUE_VIEW,
      classId: 'crack',
      status: 'reviewed',
      dir: 'desc',
      scope,
    });
    expect(hook('showIssues')({ severity: 3, scope })).toEqual({ shown: 1 });
    expect(hook('showIssues')({ status: 'closed' })).toEqual({ shown: 0 });
  });

  it('puts the search text in the register without counting by it', () => {
    expect(hook('showIssues')({ text: 'nothing has this title' })).toEqual({ shown: 5 });
    expect(issueView.getState().text).toBe('nothing has this title');
  });
});

describe('the evidence of a finding', () => {
  it('opens beside the 3D view, as a click on its pin does', () => {
    expect(hook('showEvidence')('4')).toBe(true);
    expect(evidence.getState().open).toMatchObject({
      projectId: 'p1',
      issueId: '4',
      kind: 'photo',
    });
    expect(shell.getState().stageMode).toBe('split');
  });

  it('says when there is none', () => {
    expect(hook('showEvidence')('no such finding')).toBe(false);
    expect(evidence.getState().open).toBeNull();
    expect(shell.getState().stageMode).toBe('3d');
  });
});

describe('putting the view back', () => {
  it('restores the screen, both filters and the column', () => {
    const restore = hook('captureView')();
    hook('showPhotos')({ severity: 'highest', scope: { label: 'Some', ids: ['photos/p2'] } });
    hook('showIssues')({ severity: 3, sort: 'severity' });
    hook('openScreen')('media');
    expect(shell.getState()).toMatchObject({ screen: 'media', agentDockCollapsed: false });
    restore();
    expect(shell.getState()).toMatchObject({ screen: 'scene', agentDockCollapsed: true });
    expect(mediaView.getState()).toEqual(DEFAULT_MEDIA_VIEW);
    expect(issueView.getState()).toEqual(DEFAULT_ISSUE_VIEW);
  });

  it('puts back the filters the person had set, not the defaults', () => {
    setMediaView({ onlyFindings: true, order: 'count', severity: 1 });
    setIssueView({ sev: 1, groupBy: 'class', text: 'roof' });
    const media = mediaView.getState();
    const issues = issueView.getState();
    const restore = hook('captureView')();
    hook('showPhotos')({ severity: 'highest' });
    hook('showIssues')({ severity: 3 });
    restore();
    expect(mediaView.getState()).toEqual(media);
    expect(issueView.getState()).toEqual(issues);
  });

  it('goes back to a screen with the column the way the column was, folded', () => {
    shell.setState({ screen: 'issues' });
    const restore = hook('captureView')();
    hook('openScreen')('media');
    expect(shell.getState().agentDockCollapsed).toBe(false);
    restore();
    // going back is not the agent opening Issues: the column the person had folded stays folded
    expect(shell.getState()).toMatchObject({ screen: 'issues', agentDockCollapsed: true });
  });

  it('closes the evidence it opened, and the stage is as it was', () => {
    const restore = hook('captureView')();
    hook('showEvidence')('4');
    expect(stagePrefs.getState().byProject.p1?.split).toBeDefined();
    restore();
    expect(evidence.getState().open).toBeNull();
    expect(shell.getState().stageMode).toBe('3d');
    expect(stagePrefs.getState().byProject.p1?.split).toBeUndefined();
  });

  it('keeps the evidence that was open before, on the finding it was on', () => {
    hook('showEvidence')('4');
    const before = evidence.getState().open;
    const split = stagePrefs.getState().byProject.p1?.split;
    const restore = hook('captureView')();
    hook('showEvidence')('1');
    hook('openScreen')('media');
    expect(evidence.getState().open?.issueId).toBe('1');
    restore();
    expect(evidence.getState().open).toEqual(before);
    expect(shell.getState()).toMatchObject({ screen: 'scene', stageMode: 'split' });
    expect(stagePrefs.getState().byProject.p1?.split).toEqual(split);
  });

  it('puts the stage mode back with how it was chosen', () => {
    // side by side because the project is video first, not because the person asked
    shell.setState({ stageMode: 'split', stageAuto: true });
    const restore = hook('captureView')();
    shell.getState().setStageMode('3d');
    expect(shell.getState()).toMatchObject({ stageMode: '3d', stageAuto: false });
    restore();
    expect(shell.getState()).toMatchObject({ stageMode: 'split', stageAuto: true });
  });

  it('changes nothing when nothing changed', () => {
    shell.setState({ screen: 'media', stageAuto: true });
    const prefs = stagePrefs.getState().byProject;
    const media = mediaView.getState();
    const issues = issueView.getState();
    hook('captureView')()();
    expect(shell.getState()).toMatchObject({
      screen: 'media',
      stageMode: '3d',
      stageAuto: true,
      agentDockCollapsed: true,
    });
    expect(stagePrefs.getState().byProject).toBe(prefs);
    expect(mediaView.getState()).toEqual(media);
    expect(issueView.getState()).toEqual(issues);
  });

  it('does nothing once another project is open', () => {
    const restore = hook('captureView')();
    workspace.getState().openProject(project('p2'), ISSUES);
    const scope = { label: 'Some', ids: ['photos/p2'] };
    hook('showPhotos')({ severity: 2, scope });
    hook('showIssues')({ severity: 2 });
    hook('showEvidence')('4');
    hook('openScreen')('media');
    const open = evidence.getState().open;
    restore();
    expect(shell.getState()).toMatchObject({
      screen: 'media',
      stageMode: 'split',
      agentDockCollapsed: false,
    });
    expect(mediaView.getState()).toMatchObject({ severity: 2, scope });
    expect(issueView.getState().sev).toBe(2);
    expect(evidence.getState().open).toBe(open);
    stagePrefs.getState().update('p2', { split: undefined });
  });

  it('never brings a scope of the old project into the next one', () => {
    hook('showPhotos')({ scope: { label: 'On Tank T-101', ids: ['photos/p2'] } });
    hook('showIssues')({ scope: { label: 'On Tank T-101', ids: ['3'] } });
    // taken with both chips on, as the undo of a later step would have it
    const restore = hook('captureView')();
    workspace.getState().openProject(project('p2'), ISSUES);
    expect(mediaView.getState().scope).toBeNull();
    expect(issueView.getState().scope).toBeNull();
    restore();
    expect(mediaView.getState().scope).toBeNull();
    expect(issueView.getState().scope).toBeNull();
  });

  it('does nothing once the project is closed', () => {
    const restore = hook('captureView')();
    hook('openScreen')('media');
    workspace.getState().closeProject();
    shell.setState({ screen: 'projects' });
    restore();
    expect(shell.getState()).toMatchObject({ screen: 'projects', agentDockCollapsed: false });
  });
});

describe('the filters that are on', () => {
  it('are none to begin with', () => {
    expect(hook('viewFilters')()).toEqual({
      photos: { onlyFindings: false, order: 'file', severity: null, scope: null },
      issues: { severity: null, classId: null, status: null, text: '', sort: 'code', scope: null },
    });
  });

  it('are reported with the label of each scope', () => {
    hook('showPhotos')({
      onlyFindings: true,
      order: 'severity',
      severity: 'highest',
      scope: { label: 'On Tank T-101', ids: ['photos/p2', 'photos/p3'] },
    });
    hook('showIssues')({
      severity: 'uncertain',
      classId: 'crack',
      status: 'reviewed',
      text: 'weld',
      sort: 'severity',
      scope: { label: 'In the bund', ids: ['1'] },
    });
    expect(hook('viewFilters')()).toEqual({
      photos: { onlyFindings: true, order: 'severity', severity: 3, scope: 'On Tank T-101' },
      issues: {
        severity: 'uncertain',
        classId: 'crack',
        status: 'reviewed',
        text: 'weld',
        sort: 'severity',
        scope: 'In the bund',
      },
    });
  });
});
