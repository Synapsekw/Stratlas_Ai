import type { Issue, ProjectManifest, Vec3 } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { BoxGeometry, Group, Mesh } from 'three';
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

/** A scene that has streamed in one tagged node only. */
function partial(ws: ReturnType<typeof siteWorkspace>, keep: string): RendererToolContext {
  const stage = fakeStage(ws);
  const root = stage.scene.children[0];
  if (!root) throw new Error('no root');
  for (const node of [...root.children]) if (node.name !== keep) root.remove(node);
  return { ...ctx({ ws }), scene: () => stage };
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

  it('remembers bounds per project, not in one global entry', () => {
    const a = siteWorkspace();
    const first = assetIndex(ctx({ ws: a }));
    expect(first.status).toBe('ready');
    // another project with the same number of tags, nothing measured for it
    const other = createWorkspace();
    other
      .getState()
      .openProject(
        { id: 'other', root: 'E:/other', manifest: { ...siteManifest(), id: 'other' } },
        [],
      );
    expect(assetIndex({ ...ctx({ ws: other }), scene: () => null }).status).toBe('loading');
    // and project A is still remembered
    const again = assetIndex({ ...ctx({ ws: siteWorkspace() }), scene: () => null });
    expect(again.status).toBe('ready');
    expect(again.links.get('f5')).toEqual(first.links.get('f5'));
  });

  it('keeps the remembered bounds of nodes a partial measure lacks', () => {
    const ws = siteWorkspace();
    assetIndex(ctx({ ws }));
    const c = partial(ws, '20-T-0001');
    const index = assetIndex(c);
    expect(index.status).toBe('ready');
    expect(index.boxes.map((b) => b.tag).sort()).toEqual(SITE_NODES.map((n) => n[0]).sort());
    expect(index.links.get('f5')?.asset).toBe('20-T-0003');
    expect(issuesOn(c, '20-T-0003').ids).toEqual(['f5']);
  });

  it('does not answer for an asset whose bounds are not known yet', () => {
    const c = partial(siteWorkspace(), '20-T-0001');
    expect(assetIndex(c).status).toBe('ready');
    const loading =
      'The 3D model is still loading, so findings cannot be matched to assets yet. Open Scene and try again in a moment.';
    expect(() => issuesOn(c, '20-T-0003')).toThrow(loading);
    expect(issuesOn(c, '20-T-0001').ids).toEqual([]);
    // an area answers from the assets it has bounds for, and refuses when it has none
    expect(issuesOn(c, '20 · LNG tanks').ids).toEqual([]);
    expect(() => issuesOn(c, '10 · Jetty & berths')).toThrow(loading);
    c.workspace.getState().select({ kind: 'asset', id: '20-T-0003' });
    expect(() => issuesOn(c, 'selection')).toThrow(loading);
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

  /** The site with its bounds measured, then one tag renamed: as many tags as before. */
  function renamed() {
    const ws = siteWorkspace();
    assetIndex(ctx({ ws }));
    const m = siteManifest();
    const layers = m.layers.map((l) =>
      l.kind === 'mesh'
        ? { ...l, tags: l.tags?.map((t) => (t.tag === '10-B-11' ? { ...t, tag: 'B-11' } : t)) }
        : l,
    );
    ws.getState().replaceManifest({ ...m, layers });
    return ws;
  }

  it('leaves no asset by the old name when a tag is renamed, the number of tags the same', () => {
    // measured again: the box goes by the new name, and the old one is gone
    const tags = assetIndex(ctx({ ws: renamed() })).boxes.map((b) => b.tag);
    expect(tags.sort()).toEqual([
      '10-A-0004',
      '20-P-0003A',
      '20-T-0001',
      '20-T-0002',
      '20-T-0003',
      'B-11',
    ]);
  });

  it('discards remembered bounds when a tag is renamed and nothing can be measured', () => {
    // on Media: what was remembered was measured for other tags
    expect(assetIndex({ ...ctx({ ws: renamed() }), scene: () => null }).status).toBe('loading');
  });

  it('keeps the remembered bounds when the manifest is saved again with the same tags', () => {
    const ws = siteWorkspace();
    assetIndex(ctx({ ws }));
    const m = siteManifest();
    // the same tags in another order, and something else changed
    const layers = m.layers.map((l) =>
      l.kind === 'mesh' ? { ...l, tags: [...(l.tags ?? [])].reverse() } : l,
    );
    ws.getState().replaceManifest({ ...m, name: 'Plant, renamed', layers });
    const later = assetIndex({ ...ctx({ ws }), scene: () => null });
    expect(later.status).toBe('ready');
    expect(later.boxes).toHaveLength(SITE_NODES.length);
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

  it('says that a named part of the model without a tag is not an asset, not that it loads', () => {
    const ws = siteWorkspace();
    const stage = fakeStage(ws);
    // a node of the model that nobody tagged: a place with a name, but no asset
    const part = new Group();
    part.name = 'Flare stack';
    part.userData.aioNode = true;
    const mesh = new Mesh(new BoxGeometry(4, 60, 4));
    mesh.position.set(298, 30, -52);
    part.add(mesh);
    stage.scene.children[0]?.add(part);
    stage.scene.updateMatrixWorld(true);
    const c: RendererToolContext = { ...ctx({ ws }), scene: () => stage };
    const failed = () => issuesOn(c, 'Flare stack');
    expect(failed).toThrow(ToolError);
    expect(failed).toThrow(
      new ToolError('Flare stack is not a tagged asset, so findings are not matched to it.'),
    );
    // a tagged asset and an area still answer, with that part in the model
    expect(issuesOn(c, '20-T-0003').ids).toEqual(['f5']);
    expect(issuesOn(c, 'LNG tanks').ids).toEqual(['f5']);
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

describe('describeIssue on a lined-up date', () => {
  it('reports the position where the date is drawn', () => {
    const ws = createWorkspace();
    const manifest = {
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [
        {
          id: 'd1',
          label: 'd1',
          date: '2025-01-01',
          lineUp: { eastM: 2, northM: 1, with: 'd0', at: '2026-01-01T00:00:00Z' },
        },
      ],
      layers: [
        { kind: 'mesh', id: 'm', name: 'M', visible: true, capture: 'd1', src: { path: 'm.glb' } },
      ],
      severityModels: [],
      classCatalogues: [],
    } as unknown as ProjectManifest;
    const issue = {
      id: 'i1',
      code: 'D1',
      title: 't',
      severity: 1,
      status: 'open',
      sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [10, 4, 20] } }],
    } as unknown as Issue;
    ws.getState().openProject({ id: 'p', root: 'C:/p', manifest }, [issue]);
    const c: RendererToolContext = {
      workspace: ws,
      window: 'photo',
      scene: () => null,
      fetchJson: () => Promise.resolve(null),
      captureFrame: () => Promise.resolve(null),
      now: () => new Date(0),
    };
    const none = { status: 'none' as const, boxes: [], links: new Map(), unplaced: [] };
    expect(describeIssue(c, issue, none).position).toEqual([12, 4, 19]);
  });
});
