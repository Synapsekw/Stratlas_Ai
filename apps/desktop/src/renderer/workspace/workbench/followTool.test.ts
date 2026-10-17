// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentPaneStore } from '../../agent/agentPaneStore';
import { beginIssueEdit, clearIssueEditing } from '../../issueCard/state';
import { shell } from '../../shell';
import { drawerStore } from './drawerStore';
import { followTool, showBench } from './followTool';
import { showMeasureBench } from './measureFollow';
import { createWorkbenchStore } from './workbenchStore';

afterEach(() => {
  clearIssueEditing();
  shell.getState().setRight(false);
  drawerStore.getState().close();
});

describe('one rule for bringing a tool tab forward (D14)', () => {
  it('an open from the stage gives the bench back from a maximised agent', () => {
    const wb = createWorkbenchStore(null);
    const pane = createAgentPaneStore();
    pane.getState().setMode('max');
    showBench('display', wb, shell, pane);
    expect(wb.getState().front).toBe('display');
    expect(pane.getState().mode).toBe('normal');
    // a minimised agent stays on its line
    pane.getState().setMode('min');
    showBench('measure', wb, shell, pane);
    expect(pane.getState().mode).toBe('min');
  });

  it('a tool start takes the front, live', () => {
    const wb = createWorkbenchStore(null);
    followTool('measure', {}, wb);
    expect(wb.getState().front).toBe('measure');
    expect(wb.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(true);
  });

  it('a tool start waits behind an issue in edit, with a dot', () => {
    const wb = createWorkbenchStore(null);
    beginIssueEdit('card');
    followTool('annotate', {}, wb);
    expect(wb.getState().front).toBe('selection');
    expect(wb.getState().attention).toBe('annotate');
  });

  it('an explicit ask opens its tab in front even while an issue is edited', () => {
    const wb = createWorkbenchStore(null);
    beginIssueEdit('card');
    followTool('cleanup', { ask: true }, wb);
    expect(wb.getState().front).toBe('cleanup');
    expect(wb.getState().attention).toBeNull();
  });

  it('unfolds a folded sidebar only when asked to', () => {
    const wb = createWorkbenchStore(null);
    shell.getState().setRight(true);
    followTool('measure', {}, wb);
    expect(shell.getState().rightCollapsed).toBe(true);
    followTool('cleanup', { ask: true, unfold: true }, wb);
    expect(shell.getState().rightCollapsed).toBe(false);
  });
});

describe('an open from the stage (I-R40a)', () => {
  it('brings the tab forward and leaves the drawer shut while the sidebar shows', () => {
    const wb = createWorkbenchStore(null);
    showBench('jobs', wb);
    expect(wb.getState().front).toBe('jobs');
    expect(drawerStore.getState().opened).toBeNull();
  });

  it('with the sidebar folded, opens the drawer and keeps the sidebar folded', () => {
    const wb = createWorkbenchStore(null);
    shell.getState().setRight(true);
    showBench('jobs', wb);
    expect(wb.getState().front).toBe('jobs');
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(drawerStore.getState().opened).toBe('click');
  });

  it('showMeasureBench goes the same way: no unfold, the drawer instead', () => {
    const wb = createWorkbenchStore(null);
    shell.getState().setRight(true);
    showMeasureBench(wb);
    expect(wb.getState().front).toBe('measure');
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(drawerStore.getState().opened).toBe('click');
  });
});
