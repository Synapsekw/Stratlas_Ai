import type { Issue, Vec3 } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSET_NEAR_M,
  ASSET_SLACK_M,
  assetIndex,
  assetOfPoint,
  clearAssetCache,
  describeIssue,
  issuesOn,
  severityLabel,
  type AssetBox,
} from './asset-index';
import type { RendererToolContext } from './tool-kit';
import { ToolError } from './tool-kit';
import { fakeStage, fixtureIssue, siteManifest, siteWorkspace, SITE_NODES } from './test-fixtures';

beforeEach(() => {
  clearAssetCache();
});

function ctx(opts: { stage?: boolean; ws?: ReturnType<typeof siteWorkspace> } = {}) {
  const ws = opts.ws ?? siteWorkspace();
  const stage = opts.stage === false ? null : fakeStage(ws);
  const c: RendererToolContext = {
    workspace: ws,
    window: 'photo',
    scene: () => stage,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-05T12:00:00Z'),
  };
  return c;
}

const box = (tag: string, min: Vec3, max: Vec3, area?: string): AssetBox => ({
  tag,
  ...(area ? { area } : {}),
  box: { min, max },
});

const outer = box('BIG', [0, 0, 0], [100, 100, 100], 'Yard');
const inner = box('SMALL', [40, 40, 40], [60, 60, 60], 'Yard');

describe('assetOfPoint', () => {
  it('names the box a point is inside, at distance 0', () => {
    expect(assetOfPoint([50, 50, 50], [outer])).toEqual({
      asset: 'BIG',
      area: 'Yard',
      how: 'inside',
      distanceM: 0,
    });
  });

  it('prefers the smaller of two nested boxes', () => {
    expect(assetOfPoint([50, 50, 50], [outer, inner])?.asset).toBe('SMALL');
    expect(assetOfPoint([50, 50, 50], [inner, outer])?.asset).toBe('SMALL');
  });

  it('keeps tag order between boxes of the same size', () => {
    const a = box('A', [0, 0, 0], [10, 10, 10]);
    const b = box('B', [0, 0, 0], [10, 10, 10]);
    expect(assetOfPoint([5, 5, 5], [a, b])?.asset).toBe('A');
    expect(assetOfPoint([5, 5, 5], [b, a])?.asset).toBe('B');
  });

  it('forgives a point just outside, links a close one as near, and drops a far one', () => {
    expect(ASSET_SLACK_M).toBe(0.5);
    expect(ASSET_NEAR_M).toBe(5);
    expect(assetOfPoint([100.4, 50, 50], [outer])?.how).toBe('inside');
    const near = assetOfPoint([103, 50, 50], [outer]);
    expect(near?.how).toBe('near');
    expect(near?.distanceM).toBeCloseTo(3, 1);
    expect(assetOfPoint([106, 50, 50], [outer])).toBeNull();
  });

  it('measures a diagonal distance to the box, not to its centre', () => {
    const near = assetOfPoint([103, 104, 50], [outer]);
    expect(near?.how).toBe('near');
    expect(near?.distanceM).toBeCloseTo(5, 1);
  });
});

describe('assetIndex', () => {
  it('links a finding to the tank whose box contains it', () => {
    const c = ctx();
    const index = assetIndex(c);
    expect(index.status).toBe('ready');
    const tank = SITE_NODES.find((n) => n[2][0] === 300 && n[2][2] === -50);
    expect(tank?.[0]).toBe('20-T-0003');
    expect(index.links.get('f5')).toMatchObject({
      asset: '20-T-0003',
      area: '20 · LNG tanks',
      how: 'inside',
    });
    expect(index.unplaced).toEqual([]);
  });

  it('keeps the bounds it measured when the scene is not mounted (Media), per project', () => {
    const ws = siteWorkspace();
    const first = assetIndex(ctx({ ws }));
    expect(first.status).toBe('ready');
    const later = assetIndex({ ...ctx({ ws }), scene: () => null });
    expect(later.status).toBe('ready');
    expect(later.links.get('f5')).toEqual(first.links.get('f5'));
  });

  it('says loading, never "no findings", when nothing was ever measured', () => {
    const c = { ...ctx(), scene: () => null };
    expect(assetIndex(c).status).toBe('loading');
    expect(() => issuesOn(c, '20-T-0003')).toThrow(
      'The 3D model is still loading, so findings cannot be matched to assets yet. Open Scene and try again in a moment.',
    );
    expect(() => issuesOn(c, '20-T-0003')).toThrow(ToolError);
  });

  it('discards remembered bounds when the number of tags changes', () => {
    const ws = siteWorkspace();
    assetIndex(ctx({ ws }));
    const m = siteManifest();
    const layers = m.layers.map((l) =>
      l.kind === 'mesh' ? { ...l, tags: (l.tags ?? []).slice(0, 2) } : l,
    );
    ws.getState().replaceManifest({ ...m, layers });
    expect(assetIndex({ ...ctx({ ws }), scene: () => null }).status).toBe('loading');
  });

  it('is none for a project without tagged assets', () => {
    const ws = createWorkspace();
    const m = siteManifest();
    const layers = m.layers.map((l) => (l.kind === 'mesh' ? { ...l, tags: [] } : l));
    ws.getState().openProject({ id: 'site', root: 'E:/site', manifest: { ...m, layers } }, []);
    const c = ctx({ ws });
    expect(assetIndex(c).status).toBe('none');
    expect(() => issuesOn(c, '20-T-0003')).toThrow('This project has no tagged assets.');
  });

  it('puts a finding seen only on a photo among the unplaced ones', () => {
    const photoOnly: Issue = fixtureIssue({
      id: 'p1',
      code: 'P01',
      sightings: [
        {
          on: 'image',
          layer: 'photos',
          photo: 'DJI_0661',
          geom: { type: 'point', x: 10, y: 10 },
        },
        {
          on: 'image',
          layer: 'photos',
          photo: 'DJI_0661',
          geom: { type: 'point', x: 20, y: 20 },
        },
      ],
    });
    const ws = siteWorkspace();
    ws.getState().openProject({ id: 'site', root: 'E:/site', manifest: siteManifest() }, [
      ...ws.getState().issues,
      photoOnly,
    ]);
    const c = ctx({ ws });
    const index = assetIndex(c);
    expect(index.unplaced).toEqual(['p1']);
    expect(index.links.has('p1')).toBe(false);
    const d = describeIssue(c, photoOnly, index);
    expect(d.photoOnly).toBe(true);
    expect(d.photos).toBe(1);
    expect(d.position).toBeUndefined();
    expect(d.asset).toBeUndefined();
  });
});

describe('issuesOn', () => {
  it('takes the selected asset', () => {
    const c = ctx();
    c.workspace.getState().select({ kind: 'asset', id: '20-T-0003' });
    expect(issuesOn(c, 'selection')).toEqual({ label: '20-T-0003', ids: ['f5'], unplaced: 0 });
  });

  it('rejects when nothing that findings sit on is selected', () => {
    const c = ctx();
    expect(() => issuesOn(c, 'selection')).toThrow(
      'Nothing is selected that findings can sit on. Name an asset or an area.',
    );
    c.workspace.getState().select({ kind: 'issue', id: 'f5' });
    expect(() => issuesOn(c, 'selection')).toThrow(ToolError);
  });

  it('takes a tag or an area name', () => {
    const c = ctx();
    expect(issuesOn(c, '20-T-0003').ids).toEqual(['f5']);
    expect(issuesOn(c, '20-T-0001').ids).toEqual([]);
    const area = issuesOn(c, '20 · LNG tanks');
    expect(area.ids).toEqual(['f5']);
    expect(area.label).toBe('20 · LNG tanks');
    expect(issuesOn(c, '10 · Jetty & berths').ids).toEqual([]);
  });
});

describe('severityLabel', () => {
  const c = ctx();
  it('reads the label of the level in the issue own model', () => {
    expect(severityLabel(c, fixtureIssue({ severity: 4 }))).toBe('S4');
  });
  it('uses the uncertain label of the model', () => {
    expect(severityLabel(c, fixtureIssue({ severity: 'uncertain' }))).toBe('Uncertain');
  });
  it('falls back to "Level n" for a value the model lacks', () => {
    expect(severityLabel(c, fixtureIssue({ severity: 9 }))).toBe('Level 9');
    expect(severityLabel(c, fixtureIssue({ severity: 2, severityModelId: 'gone' }))).toBe(
      'Level 2',
    );
  });
});

describe('describeIssue', () => {
  it('gives the asset, area and a position rounded to one decimal', () => {
    const c = ctx();
    const index = assetIndex(c);
    const issue = c.workspace.getState().issues[0];
    if (!issue) throw new Error('no issue');
    expect(describeIssue(c, issue, index)).toMatchObject({
      id: 'f5',
      code: 'F05',
      severity: 4,
      severityLabel: 'S4',
      asset: '20-T-0003',
      area: '20 · LNG tanks',
      position: [300, 50, -50],
      photos: 0,
      photoOnly: false,
    });
  });
});
