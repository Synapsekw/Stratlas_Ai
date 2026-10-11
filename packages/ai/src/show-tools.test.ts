import type { Issue, Sighting, Vec3 } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAssetCache } from './asset-index';
import { currentPose } from './camera-tools';
import {
  runRendererTool,
  ToolError,
  type AppHooks,
  type AppScreen,
  type IssueViewFilter,
  type PhotoViewFilter,
  type PhotoViewResult,
  type RendererToolContext,
} from './renderer-tools';
import { showToolInputs } from './show-tool-specs';
import { fakeStage, fixtureIssue, siteManifest, siteWorkspace } from './test-fixtures';
import { getToolSpec, riskOf, toolsForWindow, undoable } from './tools';
import { z } from 'zod';

beforeEach(() => {
  clearAssetCache();
});

const NO_HOOK = 'This build of the app cannot open screens for the agent.';

const onModel = (p: Vec3): Sighting => ({
  on: 'mesh',
  layer: 'plant',
  geom: { type: 'spoint', p, n: [0, 1, 0] },
});
const onPhoto = (photo: string): Sighting => ({
  on: 'image',
  layer: 'photos',
  photo,
  geom: { type: 'point', x: 0.5, y: 0.5 },
});

/**
 * The plant with three findings: A01 (S5, closed) on tank 1, F02 (S2, draft) on tank 2 and on a
 * photo, F05 (S4, reviewed) on tank 3.
 */
function workspace(extra: Issue[] = []) {
  const ws = siteWorkspace();
  const add = (i: Issue) => {
    ws.getState().upsertIssue(i);
  };
  add(
    fixtureIssue({
      id: 'a1',
      code: 'A01',
      severity: 5,
      status: 'closed',
      title: 'Old leak',
      sightings: [onModel([100, 50, -50])],
    }),
  );
  add(
    fixtureIssue({
      id: 'f2',
      code: 'F02',
      classId: 'coating',
      severity: 2,
      status: 'draft',
      title: 'Paint loss',
      sightings: [onModel([200, 50, -50]), onPhoto('DJI_0661')],
    }),
  );
  extra.forEach(add);
  return ws;
}

/** The host app as a recording stub: what it was asked to open and show, in order. */
function recordingApp(opts: { screen?: AppScreen | 'other'; evidence?: boolean } = {}) {
  const log: string[] = [];
  let screen = opts.screen ?? 'scene';
  const restore = vi.fn();
  const photos: PhotoViewResult = { shown: 3, total: 12, severity: 4, severityLabel: 'S4' };
  const app = {
    screen: () => screen,
    openScreen: vi.fn((s: AppScreen) => {
      screen = s;
      log.push(`open:${s}`);
    }),
    showPhotos: vi.fn((f: PhotoViewFilter) => {
      log.push('showPhotos');
      return f.scope ? { ...photos, shown: f.scope.ids.length } : photos;
    }),
    showIssues: vi.fn((f: IssueViewFilter) => {
      log.push('showIssues');
      return { shown: f.scope ? f.scope.ids.length : 7 };
    }),
    showEvidence: vi.fn((id: string) => {
      log.push(`evidence:${id}`);
      return opts.evidence ?? false;
    }),
    captureView: vi.fn(() => restore),
  } satisfies AppHooks;
  return { app, log, restore };
}

function ctx(
  opts: {
    ws?: ReturnType<typeof siteWorkspace>;
    stage?: boolean;
    screen?: AppScreen | 'other';
    evidence?: boolean;
    app?: AppHooks;
  } = {},
) {
  const ws = opts.ws ?? workspace();
  const stage = opts.stage === false ? null : fakeStage(ws);
  const host = recordingApp(opts);
  ws.subscribe((s, prev) => {
    if (s.selection !== prev.selection) host.log.push(`select:${s.selection?.id ?? 'none'}`);
  });
  const c: RendererToolContext = {
    workspace: ws,
    window: 'scene3d',
    scene: () => stage,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-05T12:00:00Z'),
    app: opts.app ?? host.app,
  };
  return { c, ws, ...host };
}

const near = (a: readonly number[], b: readonly number[], tol = 0.01) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= tol);

const photoOnly = (over: Partial<Issue>, photo: string) =>
  fixtureIssue({ sightings: [onPhoto(photo)], ...over });

/** M01, marked on the map and nowhere else. */
const onMapOnly = () =>
  fixtureIssue({
    id: 'm1',
    code: 'M01',
    sightings: [{ on: 'map', layer: 'plant', geojson: { type: 'Point', coordinates: [48, 29] } }],
  });

describe('the catalogue', () => {
  it('offers the five tools in every window as view changes or reads', () => {
    const names = toolsForWindow('photo').map((s) => s.meta.name);
    for (const n of ['show_issue', 'show_photos', 'show_issues', 'open_screen']) {
      expect(names, n).toContain(n);
      expect(riskOf(n), n).toBe('navigate');
      expect(undoable(n), n).toBe(true);
      expect(getToolSpec(n)?.meta.scope, n).toBe('app');
    }
    expect(names).toContain('list_assets');
    expect(riskOf('list_assets')).toBe('read');
    expect(getToolSpec('list_assets')?.meta.scope).toBe('project');
  });

  it('writes no dashes into what the model reads', () => {
    for (const n of ['show_issue', 'show_photos', 'show_issues', 'open_screen', 'list_assets']) {
      expect(getToolSpec(n)?.meta.description, n).not.toMatch(/[–—]/);
    }
  });

  it('gives the small models the three show tools', () => {
    const compact = toolsForWindow('scene3d', 'compact').map((s) => s.meta.name);
    expect(compact).toEqual(expect.arrayContaining(['show_issue', 'show_photos', 'show_issues']));
    expect(compact).not.toContain('list_assets');
  });

  it('tells the model what each field takes, in the schema the provider gets', () => {
    const fields = (name: keyof typeof showToolInputs) => {
      const schema = z.toJSONSchema(showToolInputs[name]) as {
        properties?: Record<string, { description?: string }>;
      };
      return schema.properties ?? {};
    };
    // a description on the optional wrapper replaces the one inside: both have to say it
    const one = fields('show_issue');
    expect(one.where?.description).toContain('"selection"');
    expect(one.where?.description).toContain('With no issue');
    expect(one.issue?.description).toContain('code');
    expect(one.issue?.description).toContain('Leave out');
    for (const name of ['show_photos', 'show_issues'] as const) {
      expect(fields(name).where?.description, name).toContain('"selection"');
      expect(fields(name).severity?.description, name).toContain('"highest"');
    }
    expect(fields('show_photos').issue?.description).toContain('code');
  });
});

describe('show_issue', () => {
  it('with no issue named shows the most severe open one, not a closed one above it', async () => {
    const { c, ws, app } = ctx();
    const r = await runRendererTool('show_issue', {}, c);
    expect(r.result).toMatchObject({
      issue: {
        id: 'f5',
        code: 'F05',
        severity: 4,
        severityLabel: 'S4',
        asset: '20-T-0003',
        area: '20 · LNG tanks',
      },
      photoOnly: false,
      sameLevel: { count: 0, codes: [] },
    });
    expect(r.summary).toBe('F05');
    expect(ws.getState().selection).toEqual({ kind: 'issue', id: 'f5' });
    expect(app.showEvidence).toHaveBeenCalledWith('f5');
  });

  it('several share the worst level: the first by code, and it names the others', async () => {
    const tie = fixtureIssue({ id: 'f3', code: 'F03', sightings: [onModel([100, 50, -50])] });
    for (const extra of [[tie], [tie, fixtureIssue({ id: 'f10', code: 'F10' })]]) {
      const { c } = ctx({ ws: workspace(extra) });
      const r = await runRendererTool('show_issue', {}, c);
      expect(r.result).toMatchObject({
        issue: { code: 'F03' },
        sameLevel: { count: extra.length, codes: extra.length === 1 ? ['F05'] : ['F05', 'F10'] },
      });
    }
  });

  it('names at most five of the others at the level', async () => {
    const more = Array.from({ length: 7 }, (_, k) =>
      fixtureIssue({ id: `g${String(k)}`, code: `G${String(k + 1)}` }),
    );
    const r = await runRendererTool('show_issue', {}, ctx({ ws: workspace(more) }).c);
    expect(r.result).toMatchObject({
      issue: { code: 'F05' },
      sameLevel: { count: 7, codes: ['G1', 'G2', 'G3', 'G4', 'G5'] },
    });
  });

  it('picks among the findings on an asset, in an area or on the selection', async () => {
    const { c, ws } = ctx();
    const tank2 = await runRendererTool('show_issue', { where: '20-T-0002' }, c);
    expect(tank2.result).toMatchObject({ issue: { code: 'F02', asset: '20-T-0002' } });
    const area = await runRendererTool('show_issue', { where: 'LNG tanks' }, c);
    expect(area.result).toMatchObject({ issue: { code: 'F05' }, sameLevel: { count: 0 } });
    ws.getState().select({ kind: 'asset', id: '20-T-0002' });
    const selected = await runRendererTool('show_issue', { where: 'selection' }, c);
    expect(selected.result).toMatchObject({ issue: { code: 'F02' } });
    expect(selected.result).not.toHaveProperty('where');
    expect(selected.result).not.toHaveProperty('note');
  });

  it('"this asset" with no tagged asset selected is the whole project, and it says so', async () => {
    const whole = {
      issue: { code: 'F05' },
      where: null,
      note: 'No tagged asset is selected, so this covers the whole project.',
    };
    const { c, ws } = ctx();
    const nothing = await runRendererTool('show_issue', { where: 'selection' }, c);
    expect(nothing.result).toMatchObject(whole);
    // a finding, or a part of the model that carries no tag, is not something findings sit on
    ws.getState().select({ kind: 'issue', id: 'f2' });
    expect((await runRendererTool('show_issue', { where: 'selection' }, c)).result).toMatchObject(
      whole,
    );
    ws.getState().select({ kind: 'asset', id: 'Mesh_12' });
    expect((await runRendererTool('show_issue', { where: 'selection' }, c)).result).toMatchObject(
      whole,
    );
    // a name that matches nothing is still an error
    await expect(runRendererTool('show_issue', { where: 'T-999' }, c)).rejects.toThrow(
      'No place matches "T-999"',
    );
  });

  it('says so when the asset has no open findings, and changes nothing', async () => {
    const { c, ws, log } = ctx();
    await expect(runRendererTool('show_issue', { where: '10-B-11' }, c)).rejects.toThrow(
      new ToolError('No open findings on 10-B-11.'),
    );
    // tank 1 has a finding, but it is closed
    const closedOnly = runRendererTool('show_issue', { where: '20-T-0001' }, c);
    await expect(closedOnly).rejects.toBeInstanceOf(ToolError);
    await expect(closedOnly).rejects.toThrow(new ToolError('No open findings on 20-T-0001.'));
    expect(ws.getState().selection).toBeNull();
    expect(log).toEqual([]);
  });

  it('an asset without open findings: says when findings are on photos or the map only', async () => {
    // a project graded from photos: no finding has a place in the model, so no asset has any
    const one = ctx({ ws: workspace([photoOnly({ id: 'p1', code: 'P01' }, 'DJI_0661')]) });
    const failed = runRendererTool('show_issue', { where: '10-B-11' }, one.c);
    await expect(failed).rejects.toBeInstanceOf(ToolError);
    await expect(failed).rejects.toThrow(
      new ToolError(
        'No open findings on 10-B-11. 1 finding is marked on photos or the map only and is not matched to assets.',
      ),
    );
    const two = ctx({
      ws: workspace([photoOnly({ id: 'p1', code: 'P01' }, 'DJI_0661'), onMapOnly()]),
    });
    await expect(runRendererTool('show_issue', { where: 'Jetty & berths' }, two.c)).rejects.toThrow(
      new ToolError(
        'No open findings on 10 · Jetty & berths. 2 findings are marked on photos or the map only and are not matched to assets.',
      ),
    );
    expect(two.ws.getState().selection).toBeNull();
    expect(two.log).toEqual([]);
  });

  it('says so when the project has no open findings', async () => {
    const { c, ws } = ctx();
    for (const i of ws.getState().issues) ws.getState().upsertIssue({ ...i, status: 'closed' });
    await expect(runRendererTool('show_issue', {}, c)).rejects.toThrow('No open findings.');
  });

  it('shows a named finding, closed or not, by a loose code', async () => {
    const r = await runRendererTool('show_issue', { issue: 'a1' }, ctx().c);
    expect(r.result).toMatchObject({ issue: { code: 'A01', status: 'closed' } });
    await expect(runRendererTool('show_issue', { issue: 'Z99' }, ctx().c)).rejects.toThrow(
      ToolError,
    );
  });

  it('from another screen opens Scene before it selects', async () => {
    const { c, log, app } = ctx({ screen: 'media' });
    await runRendererTool('show_issue', {}, c);
    expect(app.openScreen).toHaveBeenCalledTimes(1);
    expect(app.openScreen).toHaveBeenCalledWith('scene');
    expect(log).toEqual(['open:scene', 'select:f5', 'evidence:f5']);
  });

  it('on Scene opens no screen', async () => {
    const { c, app } = ctx();
    await runRendererTool('show_issue', {}, c);
    expect(app.openScreen).not.toHaveBeenCalled();
  });

  it('leaves the camera to the app when the evidence opened, and flies itself otherwise', async () => {
    const opened = ctx({ evidence: true });
    const before = currentPose(opened.c);
    const r = await runRendererTool('show_issue', {}, opened.c);
    expect(r.result).toMatchObject({ evidence: true });
    expect(currentPose(opened.c)).toEqual(before);
    expect(opened.ws.getState().lastCamera).toBeNull();

    const plain = ctx({ evidence: true });
    const start = currentPose(plain.c);
    const flown = await runRendererTool('show_issue', { evidence: false }, plain.c);
    expect(flown.result).toMatchObject({ evidence: false });
    expect(plain.app.showEvidence).not.toHaveBeenCalled();
    expect(currentPose(plain.c)).not.toEqual(start);
    expect(near(currentPose(plain.c)?.target ?? [], [300, 50, -50])).toBe(true);
  });

  it('flies itself when the finding has no evidence to open', async () => {
    const { c } = ctx({ evidence: false });
    const r = await runRendererTool('show_issue', {}, c);
    expect(r.result).toMatchObject({ evidence: false });
    expect(near(currentPose(c)?.target ?? [], [300, 50, -50])).toBe(true);
  });

  it('a finding marked on a photo only: stands where the photo was taken', async () => {
    const p1 = photoOnly({ id: 'p1', code: 'P01', severity: 3 }, 'DJI_0661');
    const { c, ws } = ctx({ ws: workspace([p1]), evidence: true });
    const r = await runRendererTool('show_issue', { issue: 'P01' }, c);
    expect(near(currentPose(c)?.position ?? [], [150, 80, 50])).toBe(true);
    expect(r.result).toMatchObject({
      issue: { code: 'P01', photos: 1, photoOnly: true },
      photoOnly: true,
      evidence: true,
    });
    expect((r.result as { note?: string }).note).toBeUndefined();
    expect((r.result as { issue: { asset?: string } }).issue.asset).toBeUndefined();
    expect(ws.getState().selection).toEqual({ kind: 'issue', id: 'p1' });
  });

  it('a photo without a pose: selects the finding and says there is nothing to fly to', async () => {
    const ws = workspace([photoOnly({ id: 'p2', code: 'P02', severity: 3 }, 'IMG_0002')]);
    const m = siteManifest();
    const layers = m.layers.map((l) =>
      l.kind === 'photos'
        ? { ...l, items: [...l.items, { id: 'IMG_0002', src: { path: 'photos/IMG_0002.jpg' } }] }
        : l,
    );
    ws.getState().replaceManifest({ ...m, layers });
    const { c } = ctx({ ws });
    const before = currentPose(c);
    const r = await runRendererTool('show_issue', { issue: 'P02' }, c);
    expect(r.result).toMatchObject({
      issue: { code: 'P02' },
      photoOnly: true,
      note: 'This finding has no position to fly to.',
    });
    expect(ws.getState().selection).toEqual({ kind: 'issue', id: 'p2' });
    expect(ws.getState().lastCamera?.target).toEqual({
      kind: 'selection',
      selection: { kind: 'issue', id: 'p2' },
    });
    expect(currentPose(c)).toEqual(before);
  });

  it('a finding marked on the map only: the map shows it, and it says so', async () => {
    const stage = { stageView: () => ({ show3d: true, showMap: true }) };
    const { c, ws } = ctx({
      ws: workspace([onMapOnly()]),
      app: { ...recordingApp().app, ...stage },
    });
    const r = await runRendererTool('show_issue', { issue: 'M01' }, c);
    expect(r.result).toMatchObject({
      issue: { code: 'M01' },
      photoOnly: false,
      note: 'This finding is marked on the map only. The map shows it.',
    });
    expect(ws.getState().lastCamera?.target).toEqual({
      kind: 'selection',
      selection: { kind: 'issue', id: 'm1' },
    });
  });

  it('a finding marked on the map only, with no map on the stage: says to open the map', async () => {
    const said = 'This finding is marked on the map only. Open the map to see it.';
    const stage = { stageView: () => ({ show3d: true, showMap: false }) };
    const only3d = ctx({ ws: workspace([onMapOnly()]), app: { ...recordingApp().app, ...stage } });
    const r = await runRendererTool('show_issue', { issue: 'M01' }, only3d.c);
    expect(r.result).toMatchObject({ issue: { code: 'M01' }, note: said });
    // a host that cannot say what the stage shows does not claim the map shows it
    const unknown = ctx({ ws: workspace([onMapOnly()]) });
    const blind = await runRendererTool('show_issue', { issue: 'M01' }, unknown.c);
    expect(blind.result).toMatchObject({ note: said });
    // the map still gets the request: it pans there once it is opened
    expect(unknown.ws.getState().lastCamera?.target).toEqual({
      kind: 'selection',
      selection: { kind: 'issue', id: 'm1' },
    });
  });

  it('says why the finding has no asset while the bounds of the assets are not known', async () => {
    // no screen hook: nothing to wait for, and no 3D view was ever mounted
    const host = recordingApp();
    const app: AppHooks = { openScreen: host.app.openScreen, showEvidence: host.app.showEvidence };
    const { c } = ctx({ stage: false, app });
    const r = await runRendererTool('show_issue', {}, c);
    expect(r.result).toMatchObject({
      issue: { code: 'F05' },
      note: 'The 3D model has not loaded yet, so the asset of each finding is not known. Open Scene and ask again.',
    });
    expect((r.result as { issue: object }).issue).not.toHaveProperty('asset');
    expect(host.app.openScreen).toHaveBeenCalledWith('scene');
  });

  it('undo puts the selection, the camera and the view of the app back', async () => {
    const { c, ws, app, restore } = ctx({ screen: 'issues' });
    ws.getState().select({ kind: 'asset', id: '20-T-0001' });
    const before = currentPose(c);
    const r = await runRendererTool('show_issue', {}, c);
    expect(app.captureView).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    r.undo?.();
    expect(ws.getState().selection).toEqual({ kind: 'asset', id: '20-T-0001' });
    expect(near(currentPose(c)?.position ?? [], before?.position ?? [NaN])).toBe(true);
    expect(near(currentPose(c)?.target ?? [], before?.target ?? [NaN])).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('from another screen, undo puts the camera back where it was when the 3D view appeared', async () => {
    const ws = workspace();
    // an old camera request of the agent: not where the camera is when Scene opens again
    ws.getState().flyTo({ kind: 'point', p: [1, 2, 3], distance: 10, dir: [0, 0, 1] });
    const stage = fakeStage(ws);
    const host = recordingApp({ screen: 'media' });
    let mounted = false;
    const app: AppHooks = {
      ...host.app,
      openScreen: (s) => {
        host.app.openScreen(s);
        mounted = mounted || s === 'scene';
      },
    };
    // the 3D view is not mounted on Media: it appears once Scene is opened
    const c: RendererToolContext = {
      ...ctx({ ws, app, stage: false }).c,
      scene: () => (mounted ? stage : null),
    };
    const r = await runRendererTool('show_issue', {}, c);
    expect(near(currentPose(c)?.target ?? [], [300, 50, -50])).toBe(true);
    r.undo?.();
    expect(near(currentPose(c)?.position ?? [], [600, 450, 600])).toBe(true);
    expect(near(currentPose(c)?.target ?? [], [0, 0, 0])).toBe(true);
    expect(host.restore).toHaveBeenCalledTimes(1);
  });

  it('remembers the view of the app before it opens anything', async () => {
    const order: string[] = [];
    const host = recordingApp({ screen: 'media' });
    const app: AppHooks = {
      ...host.app,
      openScreen: () => {
        order.push('open');
      },
      screen: () => 'media',
      captureView: () => {
        order.push('capture');
        return () => undefined;
      },
    };
    await runRendererTool('show_issue', {}, ctx({ app }).c);
    expect(order).toEqual(['capture', 'open']);
  });

  it('needs the app to open screens', async () => {
    const { c, ws } = ctx({ app: { showEvidence: () => true } });
    await expect(runRendererTool('show_issue', {}, c)).rejects.toThrow(NO_HOOK);
    expect(ws.getState().selection).toBeNull();
  });
});

describe('show_photos', () => {
  it('passes "highest" to the app, reports the level it used, then opens Media', async () => {
    const { c, app, log } = ctx();
    const r = await runRendererTool('show_photos', { severity: 'highest' }, c);
    expect(app.showPhotos).toHaveBeenCalledWith({
      onlyFindings: true,
      order: 'severity',
      severity: 'highest',
      scope: null,
    });
    expect(r.result).toEqual({ shown: 3, total: 12, severity: 'S4', scope: null });
    expect(r.summary).toBe('3 photos');
    expect(log).toEqual(['showPhotos', 'open:media']);
  });

  it('with nothing asked shows every photo', async () => {
    const { c, app } = ctx();
    await runRendererTool('show_photos', { order: 'file' }, c);
    expect(app.showPhotos).toHaveBeenCalledWith({
      onlyFindings: false,
      order: 'file',
      severity: null,
      scope: null,
    });
  });

  it('on an asset: the photos of its findings, as a scope the screen shows as a chip', async () => {
    const { c, app } = ctx();
    const r = await runRendererTool('show_photos', { where: '20-T-0002' }, c);
    expect(app.showPhotos).toHaveBeenCalledWith({
      onlyFindings: true,
      order: 'severity',
      severity: null,
      scope: { label: 'On 20-T-0002', ids: ['photos/DJI_0661'] },
    });
    expect(r.result).toMatchObject({ shown: 1, scope: 'On 20-T-0002' });
    expect(r.result).not.toHaveProperty('notOnAnAsset');
    expect(r.summary).toBe('1 photo');
  });

  it('a scope without photos still opens Media, showing none', async () => {
    const { c, app, log } = ctx();
    const r = await runRendererTool('show_photos', { where: '20-T-0003' }, c);
    expect(app.showPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { label: 'On 20-T-0003', ids: [] } }),
    );
    expect(r.result).toMatchObject({ shown: 0, scope: 'On 20-T-0003' });
    expect(log).toEqual(['showPhotos', 'open:media']);
  });

  it('of one finding, of one class, and of both at once', async () => {
    const { c, app } = ctx();
    const one = await runRendererTool('show_photos', { issue: 'f2' }, c);
    expect(one.result).toMatchObject({ scope: 'Finding F02', shown: 1 });
    const cls = await runRendererTool('show_photos', { classId: 'coating' }, c);
    expect(cls.result).toMatchObject({ scope: 'Coating damage', shown: 1 });
    // F05 is corrosion: no finding is both on tank 2 and F05
    const both = await runRendererTool(
      'show_photos',
      { where: '20-T-0002', issue: 'F05', classId: 'Corrosion', onlyFindings: false },
      c,
    );
    expect(both.result).toMatchObject({ scope: 'On 20-T-0002, Finding F05, Corrosion', shown: 0 });
    expect(app.showPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ onlyFindings: false }),
    );
    await expect(runRendererTool('show_photos', { classId: 'rust' }, c)).rejects.toThrow(
      'corrosion (Corrosion)',
    );
  });

  it('counts the findings that sit on no asset because they are on photos only', async () => {
    const ws = workspace([photoOnly({ id: 'p1', code: 'P01' }, 'DJI_0661')]);
    const r = await runRendererTool('show_photos', { where: '20-T-0002' }, ctx({ ws }).c);
    expect(r.result).toMatchObject({ notOnAnAsset: 1 });
  });

  it('a project without photos says so and opens nothing', async () => {
    const ws = workspace();
    const m = siteManifest();
    ws.getState().replaceManifest({ ...m, layers: m.layers.filter((l) => l.kind !== 'photos') });
    const { c, log } = ctx({ ws });
    await expect(runRendererTool('show_photos', { severity: 'highest' }, c)).rejects.toThrow(
      'This project has no photos.',
    );
    expect(log).toEqual([]);
  });

  it('a severity word that is not a level is an input error the model can read', async () => {
    const { c, app } = ctx();
    const said =
      'Invalid input at severity: Give a level value from severityLevels (a number), "uncertain" or "highest".';
    const bad = runRendererTool('show_photos', { severity: 'critical' }, c);
    await expect(bad).rejects.toBeInstanceOf(ToolError);
    await expect(bad).rejects.toThrow(new ToolError(said));
    for (const severity of ['severe', '4', 2.5]) {
      await expect(runRendererTool('show_issues', { severity }, c)).rejects.toThrow(
        new ToolError(said),
      );
    }
    expect(app.showPhotos).not.toHaveBeenCalled();
    expect(app.showIssues).not.toHaveBeenCalled();
  });

  it('a level the project does not have is an error that lists its levels', async () => {
    const { c, app, log } = ctx();
    const said =
      'This project has no severity level 7. Its levels are 1 S1, 2 S2, 3 S3, 4 S4, 5 S5.';
    const photos = runRendererTool('show_photos', { severity: 7 }, c);
    await expect(photos).rejects.toBeInstanceOf(ToolError);
    await expect(photos).rejects.toThrow(new ToolError(said));
    await expect(runRendererTool('show_issues', { severity: 7 }, c)).rejects.toThrow(
      new ToolError(said),
    );
    expect(app.captureView).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('"uncertain" in a project whose levels have no uncertain is the same kind of error', async () => {
    const ws = workspace();
    const m = siteManifest();
    const severityModels = m.severityModels.map((s) => ({
      id: s.id,
      name: s.name,
      levels: s.levels.slice(0, 3),
    }));
    ws.getState().replaceManifest({ ...m, severityModels });
    await expect(
      runRendererTool('show_issues', { severity: 'uncertain' }, ctx({ ws }).c),
    ).rejects.toThrow('This project has no "uncertain" level. Its levels are 1 S1, 2 S2, 3 S3.');
  });

  it('"this asset" with nothing selected: the photos of the whole project', async () => {
    const { c, app } = ctx();
    const r = await runRendererTool('show_photos', { where: 'selection', severity: 'highest' }, c);
    expect(app.showPhotos).toHaveBeenCalledWith({
      onlyFindings: true,
      order: 'severity',
      severity: 'highest',
      scope: null,
    });
    expect(r.result).toEqual({
      shown: 3,
      total: 12,
      severity: 'S4',
      scope: null,
      where: null,
      note: 'No tagged asset is selected, so this covers the whole project.',
    });
  });

  it('undo is the view the app remembered before the filter changed', async () => {
    const { c, restore } = ctx();
    const r = await runRendererTool('show_photos', { severity: 2 }, c);
    r.undo?.();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('needs the app to open screens', async () => {
    const { c } = ctx({ app: { showPhotos: recordingApp().app.showPhotos } });
    await expect(runRendererTool('show_photos', {}, c)).rejects.toThrow(NO_HOOK);
  });
});

describe('show_issues', () => {
  it('"highest" is the highest open level among the findings asked for', async () => {
    const { c, app, log } = ctx();
    const r = await runRendererTool('show_issues', { severity: 'highest', where: '20-T-0002' }, c);
    expect(app.showIssues).toHaveBeenCalledWith({
      severity: 2,
      classId: null,
      status: null,
      sort: 'severity',
      dir: 'asc',
      scope: { label: 'On 20-T-0002', ids: ['f2'] },
    });
    expect(r.result).toEqual({ shown: 1, severity: 'S2', scope: 'On 20-T-0002' });
    expect(r.summary).toBe('1 finding');
    expect(log).toEqual(['showIssues', 'open:issues']);
  });

  it('"highest" of the project skips closed findings, and of a class stays in the class', async () => {
    const { c, app } = ctx();
    const all = await runRendererTool('show_issues', { severity: 'highest' }, c);
    expect(all.result).toMatchObject({ severity: 'S4', scope: null });
    await runRendererTool('show_issues', { severity: 'highest', classId: 'Coating damage' }, c);
    expect(app.showIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ severity: 2, classId: 'coating' }),
    );
    // asked for the closed ones: the highest among them
    await runRendererTool('show_issues', { severity: 'highest', status: 'closed' }, c);
    expect(app.showIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ severity: 5, status: 'closed' }),
    );
  });

  it('passes a level, a status, text and the sort as they are', async () => {
    const { c, app } = ctx();
    const r = await runRendererTool(
      'show_issues',
      { severity: 'uncertain', status: 'draft', text: 'paint', sort: 'code' },
      c,
    );
    expect(app.showIssues).toHaveBeenCalledWith({
      severity: 'uncertain',
      classId: null,
      status: 'draft',
      text: 'paint',
      sort: 'code',
      dir: 'asc',
      scope: null,
    });
    expect(r.result).toEqual({ shown: 7, severity: 'Uncertain', scope: null });
  });

  it('with no level asked reports none', async () => {
    const r = await runRendererTool('show_issues', {}, ctx().c);
    expect(r.result).toEqual({ shown: 7, severity: null, scope: null });
  });

  it('"highest" with a text is the highest level among the findings the text matches', async () => {
    const { c, app } = ctx();
    const r = await runRendererTool('show_issues', { severity: 'highest', text: 'PAINT' }, c);
    expect(app.showIssues).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 2, text: 'PAINT' }),
    );
    expect(r.result).toMatchObject({ severity: 'S2' });
  });

  it('"this asset" with nothing selected: the findings of the whole project', async () => {
    const { c, app } = ctx();
    const r = await runRendererTool('show_issues', { where: 'selection', severity: 'highest' }, c);
    expect(app.showIssues).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 4, scope: null }),
    );
    expect(r.result).toEqual({
      shown: 7,
      severity: 'S4',
      scope: null,
      where: null,
      note: 'No tagged asset is selected, so this covers the whole project.',
    });
  });

  it('needs the app to set the filter', async () => {
    const { c } = ctx({ app: { openScreen: () => undefined } });
    await expect(runRendererTool('show_issues', {}, c)).rejects.toThrow(NO_HOOK);
  });
});

describe('open_screen', () => {
  it('opens the screen and can be undone', async () => {
    const { c, app, restore } = ctx();
    const r = await runRendererTool('open_screen', { screen: 'reports' }, c);
    expect(app.openScreen).toHaveBeenCalledWith('reports');
    expect(r.result).toEqual({ screen: 'reports' });
    r.undo?.();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('knows the five screens only', async () => {
    await expect(runRendererTool('open_screen', { screen: 'globe' }, ctx().c)).rejects.toThrow(
      /^Invalid input at screen/,
    );
  });

  it('a missing hook fails with the fixed message', async () => {
    const { c } = ctx({ app: {} });
    const failed = runRendererTool('open_screen', { screen: 'media' }, c);
    await expect(failed).rejects.toBeInstanceOf(ToolError);
    await expect(failed).rejects.toThrow(NO_HOOK);
  });
});

describe('list_assets', () => {
  it('lists the assets with findings, the worst open level first', async () => {
    const { c } = ctx();
    const r = await runRendererTool('list_assets', {}, c);
    expect(r.result).toEqual({
      by: 'asset',
      total: 3,
      shown: 3,
      unplaced: 0,
      noAsset: 0,
      rows: [
        {
          name: '20-T-0003',
          area: '20 · LNG tanks',
          findings: 1,
          open: 1,
          worst: { level: 4, label: 'S4' },
        },
        {
          name: '20-T-0002',
          area: '20 · LNG tanks',
          findings: 1,
          open: 1,
          worst: { level: 2, label: 'S2' },
        },
        // its only finding is closed: nothing open, so no worst level
        { name: '20-T-0001', area: '20 · LNG tanks', findings: 1, open: 0, worst: null },
      ],
    });
    expect(r.summary).toBe('3 assets');
  });

  it('by area adds the assets of an area up', async () => {
    const ws = workspace([photoOnly({ id: 'p1', code: 'P01' }, 'DJI_0661')]);
    const r = await runRendererTool('list_assets', { by: 'area' }, ctx({ ws }).c);
    expect(r.result).toEqual({
      by: 'area',
      total: 1,
      shown: 1,
      unplaced: 1,
      noAsset: 0,
      rows: [{ name: '20 · LNG tanks', findings: 3, open: 2, worst: { level: 4, label: 'S4' } }],
    });
    expect(r.summary).toBe('1 area');
  });

  it('keeps to the limit and says how many there are', async () => {
    const r = await runRendererTool('list_assets', { limit: 1 }, ctx().c);
    expect(r.result).toMatchObject({ total: 3, shown: 1, rows: [{ name: '20-T-0003' }] });
  });

  /** Tank 1 with the most findings (three, two of them open, S1), tank 3 with the worst (one, S4). */
  const busyTank = () =>
    workspace(
      ['g1', 'g2'].map((id) =>
        fixtureIssue({
          id,
          code: id.toUpperCase(),
          severity: 1,
          sightings: [onModel([100, 50, -50])],
        }),
      ),
    );
  const names = (r: { result: unknown }) =>
    (r.result as { rows: { name: string }[] }).rows.map((row) => row.name);

  it('orders by the worst open level unless asked, and cuts to the limit after ordering', async () => {
    const { c } = ctx({ ws: busyTank() });
    for (const input of [{}, { sort: 'worst' }]) {
      const all = await runRendererTool('list_assets', input, c);
      expect(names(all)).toEqual(['20-T-0003', '20-T-0002', '20-T-0001']);
      const one = await runRendererTool('list_assets', { ...input, limit: 1 }, c);
      expect(one.result).toMatchObject({ total: 3, shown: 1 });
      expect(names(one)).toEqual(['20-T-0003']);
    }
  });

  it('sort findings: the asset with the most findings first, also past the limit', async () => {
    const { c } = ctx({ ws: busyTank() });
    const all = await runRendererTool('list_assets', { sort: 'findings' }, c);
    // tank 1 has three; tanks 2 and 3 one each, both open: the name decides
    expect(names(all)).toEqual(['20-T-0001', '20-T-0002', '20-T-0003']);
    expect(all.result).toMatchObject({
      rows: [{ name: '20-T-0001', findings: 3, open: 2, worst: { level: 1, label: 'S1' } }, {}, {}],
    });
    // more assets than the limit: the cut comes after the order, so the one asked for is there
    const one = await runRendererTool('list_assets', { sort: 'findings', limit: 1 }, c);
    expect(one.result).toMatchObject({ total: 3, shown: 1 });
    expect(names(one)).toEqual(['20-T-0001']);
    await expect(runRendererTool('list_assets', { sort: 'count' }, c)).rejects.toThrow(
      /^Invalid input at sort/,
    );
  });

  it('sort findings: with as many findings, the one with more of them open comes first', async () => {
    // tank 2 and tank 3 get a second finding each; the one of tank 2 is closed
    const closed = fixtureIssue({
      id: 'c1',
      code: 'C01',
      status: 'closed',
      sightings: [onModel([200, 50, -50])],
    });
    const open = fixtureIssue({ id: 'o1', code: 'O01', sightings: [onModel([300, 50, -50])] });
    const r = await runRendererTool(
      'list_assets',
      { sort: 'findings' },
      ctx({ ws: workspace([closed, open]) }).c,
    );
    expect(r.result).toMatchObject({
      rows: [
        { name: '20-T-0003', findings: 2, open: 2 },
        { name: '20-T-0002', findings: 2, open: 1 },
        { name: '20-T-0001', findings: 1, open: 0 },
      ],
    });
  });

  it('counts the findings that have a place in the model but no asset within reach', async () => {
    // far from every tagged asset; and one on a photo only, which is counted apart
    const far = fixtureIssue({ id: 'x1', code: 'X01', sightings: [onModel([5000, 0, 5000])] });
    const ws = workspace([far, photoOnly({ id: 'p1', code: 'P01' }, 'DJI_0661')]);
    const r = await runRendererTool('list_assets', {}, ctx({ ws }).c);
    expect(r.result).toMatchObject({ total: 3, unplaced: 1, noAsset: 1 });
  });

  it('says in its description which order answers which question', () => {
    const said = getToolSpec('list_assets')?.meta.description ?? '';
    expect(said).toContain("Use it for 'which asset is in the worst shape'.");
    expect(said).toContain("Use sort findings for 'which asset has the most findings'.");
  });

  it('says the model is still loading when the bounds were never measured', async () => {
    const { c } = ctx({ stage: false });
    const failed = runRendererTool('list_assets', {}, c);
    await expect(failed).rejects.toBeInstanceOf(ToolError);
    await expect(failed).rejects.toThrow('still loading');
  });

  it('says so in a project without tagged assets', async () => {
    const ws = workspace();
    const m = siteManifest();
    const layers = m.layers.map((l) => (l.kind === 'mesh' ? { ...l, tags: [] } : l));
    ws.getState().replaceManifest({ ...m, layers });
    await expect(runRendererTool('list_assets', {}, ctx({ ws }).c)).rejects.toThrow(
      'This project has no tagged assets.',
    );
  });
});

describe('issue rows', () => {
  it('list_issues on an asset, with where it is and how many photos', async () => {
    const { c } = ctx();
    const r = await runRendererTool('list_issues', { where: 'tank 2' }, c);
    expect(r.result).toMatchObject({
      total: 1,
      where: '20-T-0002',
      issues: [
        {
          code: 'F02',
          severityLabel: 'S2',
          asset: '20-T-0002',
          area: '20 · LNG tanks',
          position: [200, 50, -50],
          photos: 1,
          photoOnly: false,
        },
      ],
    });
  });

  it('list_issues sorted by code reads like the register', async () => {
    const ws = workspace([fixtureIssue({ id: 'f10', code: 'F10' })]);
    const r = await runRendererTool('list_issues', { sort: 'code' }, ctx({ ws }).c);
    const codes = (r.result as { issues: { code: string }[] }).issues.map((i) => i.code);
    expect(codes).toEqual(['A01', 'F02', 'F05', 'F10']);
  });

  it('list_issues on "this asset" with nothing selected lists the whole project and says so', async () => {
    const { c, ws } = ctx();
    const r = await runRendererTool('list_issues', { where: 'selection' }, c);
    expect(r.result).toMatchObject({
      total: 3,
      where: null,
      note: 'No tagged asset is selected, so this covers the whole project.',
    });
    ws.getState().select({ kind: 'asset', id: '20-T-0002' });
    const tank = await runRendererTool('list_issues', { where: 'selection' }, c);
    expect(tank.result).toMatchObject({ total: 1, where: '20-T-0002' });
    expect(tank.result).not.toHaveProperty('note');
  });

  it('summarize_issues names the level and the asset of the most severe open ones', async () => {
    const { c } = ctx();
    const r = await runRendererTool('summarize_issues', {}, c);
    // A01 (S5) is closed: the first row is the finding show_issue picks
    expect((r.result as { mostSevere: object[] }).mostSevere).toMatchObject([
      { code: 'F05', severityLabel: 'S4', asset: '20-T-0003' },
      { code: 'F02', severityLabel: 'S2', asset: '20-T-0002' },
    ]);
    expect(r.result).toMatchObject({ total: 3, byStatus: { closed: 1 } });
    const shown = await runRendererTool('show_issue', { evidence: false }, c);
    expect(shown.result).toMatchObject({ issue: { code: 'F05' } });
    // the bounds are known here, so there is nothing to explain
    expect(r.result).not.toHaveProperty('note');
    // asked for the closed ones: those are the ones listed
    const closed = await runRendererTool('summarize_issues', { status: 'closed' }, c);
    expect((closed.result as { mostSevere: object[] }).mostSevere).toMatchObject([{ code: 'A01' }]);
  });
});
