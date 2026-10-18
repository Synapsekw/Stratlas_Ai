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
    workbench.getState().open('display');
    shell.getState().setRight(true);
    agentPane.getState().setMode('max');
    openEngineeringReview();
    expect(engineerUi.getState()).toMatchObject({ open: true, review: true });
    expect(workbench.getState().front).toBe('review');
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(drawerStore.getState().opened).toBe('click');
    expect(agentPane.getState().mode).toBe('normal');
    expect(workbench.getState().tabs.some((tab) => tab.id === 'display')).toBe(false);
  });

  it.each(['rf', 'display'] as const)(
    'keeps the unpinned %s panel when a completed review arrives without starting a tool',
    (panel) => {
      workbench.getState().open(panel);
      const toolSeq = workbench.getState().toolSeq;
      openEngineeringReview(true);
      const bench = workbench.getState();
      expect(bench.front).toBe('review');
      expect(bench.tabs.find((tab) => tab.id === panel)).toMatchObject({ pinned: false });
      expect(bench.tabs.find((tab) => tab.id === 'review')).toMatchObject({ live: false });
      expect(bench.toolSeq).toBe(toolSeq);
      expect(bench.openedByTool.has('review')).toBe(false);
    },
  );

  it('a finished run waits behind an issue being edited until explicitly opened', () => {
    workbench.getState().open('rf');
    shell.getState().setRight(true);
    agentPane.getState().setMode('max');
    beginIssueEdit('editing-card');
    openEngineeringReview(true);
    expect(workbench.getState().front).toBe('rf');
    expect(workbench.getState().attention).toBe('review');
    expect(workbench.getState().tabs.find((tab) => tab.id === 'review')?.live).toBe(false);
    expect(drawerStore.getState().opened).toBeNull();
    expect(agentPane.getState().mode).toBe('max');
    expect(engineerUi.getState().review).toBe(true);
    openEngineeringReview();
    expect(workbench.getState().front).toBe('review');
    expect(workbench.getState().attention).toBeNull();
  });

  it('queues attention again when a later completion arrives during an issue edit', () => {
    openEngineeringReview(true);
    workbench.getState().show('selection');
    beginIssueEdit('editing-card');
    openEngineeringReview(true);
    openEngineeringReview(true);
    expect(workbench.getState().front).toBe('selection');
    expect(workbench.getState().waiting).toEqual(['review']);
    expect(workbench.getState().attention).toBe('review');
    expect(workbench.getState().tabs.filter((tab) => tab.id === 'review')).toHaveLength(1);
    openEngineeringReview();
    expect(workbench.getState().waiting).toEqual([]);
    expect(workbench.getState().front).toBe('review');
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
