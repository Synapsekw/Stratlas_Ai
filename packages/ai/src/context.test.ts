import { describe, expect, it } from 'vitest';
import { assembleContext, bindingLabel, formatClock } from './context';
import { fixtureWorkspace, T0 } from './test-fixtures';

describe('window context', () => {
  it('describes the project, time, clip, selection, layers and counts', () => {
    const ws = fixtureWorkspace();
    ws.getState().select({ kind: 'asset', id: '20-T-0002', layer: 'm1' });
    ws.getState().setTime(T0 + 26_000);
    const ctx = assembleContext(ws.getState(), 'scene3d');
    expect(ctx).toMatchObject({
      window: 'scene3d',
      project: { name: 'Tank farm', customer: 'Acme', site: 'North' },
      time: { nowUtc: '2023-02-21T15:11:26.000Z', playing: false },
      activeClip: { id: 'v1', name: 'DJI_0789', atSeconds: 26 },
      selection: { kind: 'asset', id: '20-T-0002', label: '20-T-0002' },
      counts: {
        clips: 2,
        issues: 3,
        issuesByStatus: { reviewed: 1, draft: 1, closed: 1 },
        openIssuesBySeverity: { '4': 1, '2': 1 },
      },
    });
    const layers = ctx.layers as { visible: { id: string }[]; hiddenCount: number };
    expect(layers.visible.map((l) => l.id)).toEqual(['m1', 'v1', 'v2']);
    expect(layers.hiddenCount).toBe(1);
  });

  it('labels an issue selection by its code', () => {
    const ws = fixtureWorkspace();
    ws.getState().select({ kind: 'issue', id: 'i1' });
    expect(assembleContext(ws.getState(), 'issues').selection).toMatchObject({ label: 'D01' });
  });

  it('works with no project open', () => {
    const ws = fixtureWorkspace();
    ws.getState().closeProject();
    expect(assembleContext(ws.getState(), 'map')).toMatchObject({ project: null, selection: null });
  });

  it('is JSON safe', () => {
    const ctx = assembleContext(fixtureWorkspace().getState(), 'video');
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctx);
  });
});

describe('binding chip', () => {
  it('reads window, selection and time', () => {
    const ws = fixtureWorkspace();
    ws.getState().select({ kind: 'asset', id: '20-T-0002' });
    ws.getState().setTime(T0 + 26_000);
    expect(bindingLabel('scene3d', ws.getState())).toBe('3D view, 20-T-0002, 15:11:26');
  });

  it('leaves out what is not there', () => {
    const ws = fixtureWorkspace();
    ws.getState().closeProject();
    expect(bindingLabel('issues', ws.getState())).toBe('Issues');
  });

  it('formats the clock in UTC', () => {
    expect(formatClock(T0 + 5_000)).toBe('15:11:05');
  });
});
