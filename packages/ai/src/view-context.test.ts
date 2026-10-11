import type { Vec3 } from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAssetCache } from './asset-index';
import type { AppHooks, RendererToolContext, ViewFilters } from './renderer-tools';
import { fakeStage, fixtureIssue, siteWorkspace } from './test-fixtures';
import { viewContext } from './view-context';

beforeEach(() => {
  clearAssetCache();
});

const FILTERS: ViewFilters = {
  photos: { onlyFindings: true, order: 'severity', severity: 4, scope: 'On 20-T-0003' },
  issues: { severity: null, classId: null, status: null, text: '', sort: 'code', scope: null },
};

function ctx(app?: AppHooks, stage = true): RendererToolContext {
  const ws = siteWorkspace();
  const scene = stage ? fakeStage(ws) : null;
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => scene,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-05T12:00:00Z'),
    ...(app ? { app } : {}),
  };
}

const onTank3 = (p: Vec3) => [
  {
    on: 'mesh' as const,
    layer: 'plant',
    geom: { type: 'spoint' as const, p, n: [0, 1, 0] as Vec3 },
  },
];

describe('the view context', () => {
  it('reports the screen and the filters that are on', () => {
    const c = ctx({ screen: () => 'media', viewFilters: () => FILTERS });
    expect(viewContext(c)).toEqual({ screen: 'media', filters: FILTERS });
  });

  it('is empty without the hooks', () => {
    expect(viewContext(ctx())).toEqual({});
  });

  it('is empty, not an error, when a hook throws', () => {
    const c = ctx({
      screen: () => {
        throw new Error('boom');
      },
    });
    expect(viewContext(c)).toEqual({});
  });

  it('describes the selected asset: findings, open ones and the worst level by name', () => {
    const c = ctx({ screen: () => 'scene' });
    c.workspace.getState().upsertIssue(
      fixtureIssue({
        id: 'f6',
        code: 'F06',
        severity: 2,
        status: 'draft',
        sightings: onTank3([300, 50, -50]),
      }),
    );
    c.workspace.getState().select({ kind: 'asset', id: '20-T-0003', layer: 'plant' });
    expect(viewContext(c)).toEqual({
      screen: 'scene',
      selectedAsset: { name: '20-T-0003', findings: 2, open: 2, worst: 'S4' },
    });
  });

  it('counts closed findings but takes the worst level from the open ones', () => {
    const c = ctx();
    c.workspace.getState().upsertIssue(
      fixtureIssue({
        id: 'f7',
        code: 'F07',
        severity: 5,
        status: 'closed',
        sightings: onTank3([300, 50, -50]),
      }),
    );
    c.workspace.getState().select({ kind: 'asset', id: '20-T-0003' });
    expect(viewContext(c).selectedAsset).toEqual({
      name: '20-T-0003',
      findings: 2,
      open: 1,
      worst: 'S4',
    });
  });

  it('says nothing about an asset whose bounds are not known yet', () => {
    const c = ctx(undefined, false);
    c.workspace.getState().select({ kind: 'asset', id: '20-T-0003' });
    expect(viewContext(c)).toEqual({});
  });

  it('says nothing about a selection that is not an asset', () => {
    const c = ctx();
    c.workspace.getState().select({ kind: 'issue', id: 'f5' });
    expect(viewContext(c)).toEqual({});
  });

  it('has a null worst level for an asset with no findings', () => {
    const c = ctx();
    c.workspace.getState().select({ kind: 'asset', id: '20-T-0001' });
    expect(viewContext(c).selectedAsset).toEqual({
      name: '20-T-0001',
      findings: 0,
      open: 0,
      worst: null,
    });
  });
});
