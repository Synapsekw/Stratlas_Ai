// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { beginIssueEdit, clearIssueEditing } from '../../issueCard/state';
import { shell } from '../../shell';
import { followTool } from './followTool';
import { createWorkbenchStore } from './workbenchStore';

afterEach(() => {
  clearIssueEditing();
  shell.getState().setRight(false);
});

describe('one rule for bringing a tool tab forward (D14)', () => {
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
    followTool('annotate', { unfold: true }, wb);
    expect(shell.getState().rightCollapsed).toBe(false);
  });
});
