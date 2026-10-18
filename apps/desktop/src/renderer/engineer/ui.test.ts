// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPane } from '../agent/agentPaneStore';
import { beginIssueEdit, clearIssueEditing } from '../issueCard/state';
import { shell } from '../shell';
import { drawerStore } from '../workspace/workbench/drawerStore';
import { workbench } from '../workspace/workbench/workbenchStore';
import { engineerUi, followEngineeringReview, openEngineeringReview } from './ui';

let stop: (() => void) | undefined;
beforeEach(() => {
  workbench.getState().reset();
  engineerUi.getState().hide();
  shell.getState().setRight(false);
  agentPane.getState().setMode('normal');
  stop = followEngineeringReview();
});
afterEach(() => {
  stop?.();
  clearIssueEditing();
  engineerUi.getState().hide();
  drawerStore.getState().close();
  shell.getState().setRight(false);
});

describe('engineering review workbench lifecycle', () => {
  it('an explicit review uses the workbench and its folded-sidebar drawer', () => {
    shell.getState().setRight(true);
    agentPane.getState().setMode('max');
    openEngineeringReview();
    expect(engineerUi.getState()).toMatchObject({ open: true, review: true });
    expect(workbench.getState().front).toBe('review');
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(drawerStore.getState().opened).toBe('click');
    expect(agentPane.getState().mode).toBe('normal');
  });

  it('a finished run waits behind an issue being edited until explicitly opened', () => {
    beginIssueEdit('editing-card');
    openEngineeringReview(true);
    expect(workbench.getState().front).toBe('selection');
    expect(workbench.getState().attention).toBe('review');
    expect(engineerUi.getState().review).toBe(true);
    openEngineeringReview();
    expect(workbench.getState().front).toBe('review');
    expect(workbench.getState().attention).toBeNull();
  });

  it('closing the tab hides the review and explicit progress closes its tab', () => {
    openEngineeringReview();
    workbench.getState().close('review');
    expect(engineerUi.getState()).toMatchObject({ open: false, review: false });
    openEngineeringReview();
    engineerUi.getState().show();
    expect(engineerUi.getState()).toMatchObject({ open: true, review: false });
    expect(workbench.getState().tabs.some((tab) => tab.id === 'review')).toBe(false);
  });
});
