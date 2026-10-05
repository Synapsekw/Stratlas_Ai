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
