import { Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  getRendererTool,
  registerRendererTool,
  runRendererTool,
  ToolError,
  type RendererToolContext,
} from './renderer-tools';
import { fixtureWorkspace, T0 } from './test-fixtures';
import { TOOL_SPECS } from './tools';

const pass = (startUtcMs: number, x0: number) => ({
  schema: 'aio.flight/1',
  startUtcMs,
  samples: Array.from({ length: 21 }, (_, i) => ({
    t: i * 1000,
    pos: [x0 + i * 10, 100, 0],
    q: [0, 0, 0, 1],
  })),
});

function ctx(over: Partial<RendererToolContext> = {}): RendererToolContext {
  const ws = fixtureWorkspace();
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: (url) =>
      Promise.resolve(url.endsWith('DJI_0789.json') ? pass(T0, -100) : pass(T0 + 600_000, 1000)),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-03T12:00:00Z'),
    ...over,
  };
}

describe('renderer tool registry', () => {
  it('has an executor for every catalogue tool', () => {
    for (const s of TOOL_SPECS) expect(getRendererTool(s.meta.name), s.meta.name).toBeDefined();
  });

  it('has the show tools in the catalogue, each with its executor', () => {
    const names = TOOL_SPECS.map((s) => s.meta.name);
    for (const n of ['show_issue', 'show_photos', 'show_issues', 'open_screen', 'list_assets']) {
      expect(names, n).toContain(n);
      expect(getRendererTool(n), n).toBeDefined();
    }
  });

  it('refuses to register a tool twice', () => {
    expect(() => {
      registerRendererTool('list_issues', () => Promise.resolve({ result: null, summary: '' }));
    }).toThrow('already');
  });

  it('rejects input that does not match the schema with a fixed message', async () => {
    await expect(runRendererTool('set_time', {}, ctx())).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects unknown tools', async () => {
    await expect(runRendererTool('format_disk', {}, ctx())).rejects.toThrow(
      'not available in this window',
    );
  });
});

describe('read tools', () => {
  it('list_issues filters by status and severity', async () => {
    const r = await runRendererTool('list_issues', { severityMin: 3 }, ctx());
    expect(r.result).toMatchObject({ total: 2, issues: [{ code: 'D01' }, { code: 'F01' }] });
    const drafts = await runRendererTool('list_issues', { status: 'draft' }, ctx());
    expect(drafts.result).toMatchObject({ total: 1, issues: [{ code: 'D02' }] });
    expect(drafts.summary).toBe('1 issue');
  });

  it('list_issues sorted by severity is worst first, and every row names its level', async () => {
    const r = await runRendererTool('list_issues', { sort: 'severity' }, ctx());
    const rows = (r.result as { issues: { code: string; severityLabel: string }[] }).issues;
    expect(rows.map((i) => i.code)).toEqual(['F01', 'D01', 'D02']);
    expect(rows.map((i) => i.severityLabel)).toEqual(['S5', 'S4', 'S2']);
    // the fields a row had before keep their names
    expect(rows[1]).toMatchObject({
      id: 'i1',
      title: 'Roof corrosion',
      classId: 'corrosion',
      severity: 4,
      status: 'reviewed',
      source: 'human',
      layers: ['m1'],
      position: [0, 70, 0],
      photos: 0,
      photoOnly: false,
    });
  });

  it('list_issues sorts before it cuts to the limit', async () => {
    const r = await runRendererTool('list_issues', { sort: 'severity', limit: 1 }, ctx());
    expect(r.result).toMatchObject({ total: 3, shown: 1, issues: [{ code: 'F01' }] });
  });

  it('list_issues without a sort keeps the order of the project', async () => {
    const r = await runRendererTool('list_issues', {}, ctx());
    const rows = (r.result as { issues: { code: string }[] }).issues;
    expect(rows.map((i) => i.code)).toEqual(['D01', 'D02', 'F01']);
  });

  it('list_issues on an asset says the model is still loading when no bounds are known', async () => {
    // the 3D view is not mounted here: "no findings on this asset" would be a wrong answer
    await expect(runRendererTool('list_issues', { where: '20-T-0002' }, ctx())).rejects.toThrow(
      'still loading',
    );
  });

  it('rows without an asset say why while the bounds are not known', async () => {
    const note = 'The 3D model has not loaded yet, so the asset of each finding is not known.';
    const listed = await runRendererTool('list_issues', {}, ctx());
    expect((listed.result as { note?: string }).note).toContain(note);
    expect((listed.result as { issues: object[] }).issues[0]).not.toHaveProperty('asset');
    const summed = await runRendererTool('summarize_issues', {}, ctx());
    expect((summed.result as { note?: string }).note).toContain(note);
  });

  it('list_issues on "this asset" with nothing selected lists the whole project', async () => {
    // no bounds are known here either, but nothing is asked about an asset
    const r = await runRendererTool('list_issues', { where: 'selection' }, ctx());
    expect(r.result).toMatchObject({ total: 3, where: null });
    const note = (r.result as { note: string }).note;
    expect(note).toContain('No tagged asset is selected, so this covers the whole project.');
    expect(note).toContain('The 3D model has not loaded yet');
  });

  it('list_issues takes a class by its id or its label, and lists the classes for a wrong one', async () => {
    for (const classId of ['coating', 'Coating damage', 'coating DAMAGE']) {
      const r = await runRendererTool('list_issues', { classId }, ctx());
      expect(r.result, classId).toMatchObject({ total: 1, issues: [{ code: 'F01' }] });
    }
    const wrong = runRendererTool('list_issues', { classId: 'rust' }, ctx());
    await expect(wrong).rejects.toBeInstanceOf(ToolError);
    await expect(wrong).rejects.toThrow(
      "Choose classId from this project's classes: corrosion (Corrosion), coating (Coating damage).",
    );
  });

  it('summarize_issues lists the most severe open ones with the name of their level', async () => {
    const r = await runRendererTool('summarize_issues', {}, ctx());
    // F01 (S5) is closed: it is counted, not listed
    expect((r.result as { mostSevere: object[] }).mostSevere).toMatchObject([
      { code: 'D01', severityLabel: 'S4' },
      { code: 'D02', severityLabel: 'S2' },
    ]);
    expect(r.result).toMatchObject({ total: 3, byStatus: { closed: 1 } });
    const closed = await runRendererTool('summarize_issues', { status: 'closed' }, ctx());
    expect((closed.result as { mostSevere: object[] }).mostSevere).toMatchObject([
      { code: 'F01', severityLabel: 'S5' },
    ]);
  });

  it('summarize_issues counts by severity, status and class', async () => {
    const r = await runRendererTool('summarize_issues', {}, ctx());
    expect(r.result).toMatchObject({
      total: 3,
      bySeverity: { '4': 1, '2': 1, '5': 1 },
      byClass: { Corrosion: 2, 'Coating damage': 1 },
    });
  });

  it('list_clips lists video layers with their start', async () => {
    const r = await runRendererTool('list_clips', {}, ctx());
    expect(r.result).toMatchObject({
      clips: [
        { id: 'v1', name: 'DJI_0789', active: true, startUtc: '2023-02-21T15:11:00.000Z' },
        { id: 'v2', name: 'DJI_0790', active: false },
      ],
    });
  });

  it('find_clips_near finds the clips that pass an issue', async () => {
    const r = await runRendererTool(
      'find_clips_near',
      { target: { kind: 'issue', id: 'D01' }, radiusM: 40 },
      ctx(),
    );
    expect(r.result).toMatchObject({
      clips: [{ id: 'v1', minDistanceM: 30, closestAtUtc: '2023-02-21T15:11:10.000Z' }],
    });
    expect(r.summary).toBe('1 of 2 clips');
  });

  it('find_clips_near measures a lined-up clip along its flight where it is drawn', async () => {
    const ws = fixtureWorkspace();
    const m = ws.getState().project?.manifest;
    if (!m) throw new Error('fixture');
    // the clip's date is lined up 40 m north: its path is drawn at z -40, 50 m from the issue
    ws.getState().replaceManifest({
      ...m,
      captures: [
        {
          id: 'd2',
          label: 'Second',
          date: '2023-02-21',
          lineUp: { eastM: 0, northM: 40, with: 'd1', at: '2026-10-16T08:00:00Z' },
        },
      ],
      layers: m.layers.map((l) => (l.id === 'v1' ? { ...l, capture: 'd2' } : l)),
    });
    const r = await runRendererTool(
      'find_clips_near',
      { target: { kind: 'issue', id: 'D01' }, radiusM: 60 },
      ctx({ workspace: ws }),
    );
    expect(r.result).toMatchObject({ clips: [{ id: 'v1', minDistanceM: 50 }] });
  });

  it('find_clips_near explains an asset it cannot place', async () => {
    await expect(
      runRendererTool('find_clips_near', { target: { kind: 'asset', id: '20-T-0002' } }, ctx()),
    ).rejects.toThrow('Open the 3D view');
  });
});

describe('navigate tools', () => {
  it('set_time moves the clock and undo puts it back', async () => {
    const c = ctx();
    const before = c.workspace.getState().nowMs;
    const r = await runRendererTool('set_time', { clipId: 'v2', clipSeconds: 12 }, c);
    expect(c.workspace.getState().nowMs).toBe(T0 + 600_000 + 12_000);
    r.undo?.();
    expect(c.workspace.getState().nowMs).toBe(before);
  });

  it('play_clip activates and plays, undo restores', async () => {
    const c = ctx();
    const r = await runRendererTool('play_clip', { clipId: 'v2', fromSeconds: 3 }, c);
    expect(c.workspace.getState()).toMatchObject({ activeClip: 'v2', playing: true });
    r.undo?.();
    expect(c.workspace.getState()).toMatchObject({ activeClip: 'v1', playing: false });
  });

  it('set_layer_visible hides a layer and undo shows it again', async () => {
    const c = ctx();
    const r = await runRendererTool('set_layer_visible', { layerId: 'm1', visible: false }, c);
    expect(c.workspace.getState().isLayerVisible('m1')).toBe(false);
    r.undo?.();
    expect(c.workspace.getState().isLayerVisible('m1')).toBe(true);
  });

  it('set_layer_visible names a missing layer', async () => {
    await expect(
      runRendererTool('set_layer_visible', { layerId: 'nope', visible: true }, ctx()),
    ).rejects.toThrow('No layer "nope"');
  });

  it('select and clear, with undo', async () => {
    const c = ctx();
    await runRendererTool('select', { kind: 'issue', id: 'i1' }, c);
    expect(c.workspace.getState().selection).toEqual({ kind: 'issue', id: 'i1' });
    const r = await runRendererTool('select', { clear: true }, c);
    expect(c.workspace.getState().selection).toBeNull();
    r.undo?.();
    expect(c.workspace.getState().selection).toEqual({ kind: 'issue', id: 'i1' });
  });

  it('fly_to an issue asks the camera to go to its location (the 3D view ignores issue selections)', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'issue', id: 'D01' } }, c);
    expect(c.workspace.getState().camera?.target).toMatchObject({ kind: 'point', p: [0, 70, 0] });
  });
});

describe('write and send tools', () => {
  it('create_issue_draft writes the kind the named layer needs', async () => {
    const c = ctx();
    await runRendererTool(
      'create_issue_draft',
      {
        title: 'On the cloud',
        severity: 2,
        classId: 'coating',
        layer: 'pc1',
        at: { kind: 'point', p: [4, 5, 6] },
      },
      c,
    );
    const created = c.workspace.getState().issues.find((i) => i.title === 'On the cloud');
    expect(created?.sightings).toEqual([
      { on: 'pointcloud', layer: 'pc1', geom: { type: 'point3', p: [4, 5, 6] } },
    ]);
    await expect(
      runRendererTool(
        'create_issue_draft',
        {
          title: 'x',
          severity: 2,
          classId: 'coating',
          layer: 'v1',
          at: { kind: 'point', p: [0, 0, 0] },
        },
        c,
      ),
    ).rejects.toThrow('no mesh or point cloud layer "v1"');
  });

  it('create_issue_draft adds a valid agent draft at a point, undo removes it', async () => {
    const c = ctx();
    const r = await runRendererTool(
      'create_issue_draft',
      {
        title: 'Coating loss',
        severity: 3,
        classId: 'coating',
        at: { kind: 'point', p: [1, 2, 3] },
      },
      c,
    );
    const created = c.workspace.getState().issues.find((i) => i.title === 'Coating loss');
    expect(created).toMatchObject({
      status: 'draft',
      source: 'agent',
      code: 'AG01',
      severityModelId: 'sev',
      sightings: [{ on: 'mesh', layer: 'm1', geom: { type: 'spoint', p: [1, 2, 3] } }],
    });
    expect(Issue.safeParse(created).success).toBe(true);
    r.undo?.();
    expect(c.workspace.getState().issues.some((i) => i.title === 'Coating loss')).toBe(false);
  });

  it('create_issue_draft at the selected issue reuses its location', async () => {
    const c = ctx();
    c.workspace.getState().select({ kind: 'issue', id: 'i1' });
    await runRendererTool('create_issue_draft', { title: 'Second look', severity: 2 }, c);
    const created = c.workspace.getState().issues.find((i) => i.title === 'Second look');
    expect(created?.classId).toBe('corrosion');
    expect(created?.sightings[0]).toMatchObject({ on: 'mesh', geom: { p: [0, 70, 0] } });
  });

  it('create_issue_draft checks severity against the model', async () => {
    await expect(
      runRendererTool(
        'create_issue_draft',
        { title: 'x', severity: 9, classId: 'coating', at: { kind: 'point', p: [0, 0, 0] } },
        ctx(),
      ),
    ).rejects.toThrow('severity 9');
  });

  it('create_issue_draft asks for a class when it cannot infer one', async () => {
    await expect(
      runRendererTool(
        'create_issue_draft',
        { title: 'x', severity: 2, at: { kind: 'point', p: [0, 0, 0] } },
        ctx(),
      ),
    ).rejects.toThrow('corrosion (Corrosion)');
  });

  it('capture_frame returns the image from the window', async () => {
    const r = await runRendererTool(
      'capture_frame',
      {},
      ctx({ window: 'video', captureFrame: () => Promise.resolve('data:image/jpeg;base64,AAAA') }),
    );
    expect(r.result).toMatchObject({ image: 'data:image/jpeg;base64,AAAA', window: 'video' });
  });

  it('capture_frame explains an empty window', async () => {
    await expect(runRendererTool('capture_frame', {}, ctx({ window: 'video' }))).rejects.toThrow(
      'Nothing to capture',
    );
  });
});
