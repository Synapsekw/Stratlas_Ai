import { describe, expect, it } from 'vitest';
import { actionRisk, actionToolInputs, AGENT_ACTIONS } from './action-tool-specs';
import { approvalFor, riskOf } from './tools';

describe('the action coverage table', () => {
  it('gives every entry a risk or a reason', () => {
    for (const [id, e] of Object.entries(AGENT_ACTIONS)) {
      if ('risk' in e) expect(['navigate', 'write'], id).toContain(e.risk);
      else expect(e.exclude.length, id).toBeGreaterThan(10);
    }
  });

  it('asks before an action that changes data, never before a view action', () => {
    expect(actionRisk('measure.delete')).toBe('write');
    expect(actionRisk('layer.hide')).toBe('navigate');
    // unknown and excluded ids ask first: the bridge refuses them anyway
    expect(actionRisk('nope.nothing')).toBe('write');
    expect(actionRisk('layer.rename')).toBe('write');
    expect(actionRisk(42)).toBe('write');
  });

  it('decides run_action approval per call from the action it names', () => {
    const view = { action: 'date.view', target: { kind: 'date', date: 'c1' } };
    const del = { action: 'date.delete', target: { kind: 'date', date: 'c1' } };
    expect(riskOf('run_action', view)).toBe('navigate');
    expect(approvalFor('run_action', view)).toBe(false);
    expect(approvalFor('run_action', del)).toBe(true);
    // without an input (a restored step, a listing) it counts as a write
    expect(approvalFor('run_action')).toBe(true);
    expect(riskOf('list_actions')).toBe('read');
  });

  it('takes the targets the model can name', () => {
    const ok = (target: unknown) => actionToolInputs.list_actions.safeParse({ target }).success;
    expect(ok({ kind: 'project' })).toBe(true);
    expect(ok({ kind: 'date', date: null })).toBe(true);
    expect(ok({ kind: 'layers', ids: ['a'] })).toBe(true);
    expect(ok({ kind: 'media', layer: 'p', ids: ['x'] })).toBe(true);
    expect(ok({ kind: 'layers', ids: [] })).toBe(false);
    expect(ok({ kind: 'group' })).toBe(false);
  });
});
