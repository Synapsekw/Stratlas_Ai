import type { Issue, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { assetUrl, createWorkspace } from './index';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl Tank 710-D-130335',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'video',
      id: 'f110',
      name: 'Flight 110',
      visible: true,
      src: { path: 'video/f110.mp4' },
      flight: { src: { path: 'flights/f110.json' }, startUtcMs: 1_700_000_000_000 },
      lens: { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 },
      offsetMs: 250,
    },
    {
      kind: 'mesh',
      id: 'tank',
      name: 'Tank',
      visible: false,
      src: { path: 'tank.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
  severityModels: [],
  classCatalogues: [],
};

describe('workspace store', () => {
  it('opens a project on its first clip and hides layers saved as hidden', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'hcl', root: 'E:/x', manifest });
    const s = ws.getState();
    expect(s.activeClip).toBe('f110');
    expect(s.nowMs).toBe(1_700_000_000_250);
    expect(s.isLayerVisible('tank')).toBe(false);
    expect(s.isLayerVisible('f110')).toBe(true);
  });

  it('counts opens in openSeq, not manifest replacements, issue edits or closes', () => {
    const ws = createWorkspace();
    expect(ws.getState().openSeq).toBe(0);
    ws.getState().openProject({ id: 'hcl', root: 'E:/x', manifest });
    expect(ws.getState().openSeq).toBe(1);
    ws.getState().replaceManifest({ ...manifest });
    ws.getState().upsertIssue({ id: 'i1' } as unknown as Issue);
    ws.getState().removeIssue('i1');
    expect(ws.getState().openSeq).toBe(1);
    ws.getState().closeProject();
    expect(ws.getState().openSeq).toBe(1);
    ws.getState().openProject({ id: 'hcl', root: 'E:/x', manifest });
    expect(ws.getState().openSeq).toBe(2);
    ws.getState().openProject({ id: 'hcl', root: 'E:/x', manifest });
    expect(ws.getState().openSeq).toBe(3);
  });

  it('toggles layer visibility', () => {
    const ws = createWorkspace();
    ws.getState().setLayerVisible('a', false);
    expect(ws.getState().isLayerVisible('a')).toBe(false);
    ws.getState().setLayerVisible('a', true);
    expect(ws.getState().isLayerVisible('a')).toBe(true);
  });

  it('shows and hides many layers in one update', () => {
    const ws = createWorkspace();
    ws.getState().setLayerVisible('c', false);
    let updates = 0;
    const off = ws.subscribe(() => {
      updates += 1;
    });
    ws.getState().setLayersVisible(['a', 'b', 'c'], false);
    expect(updates).toBe(1);
    expect(ws.getState().hidden).toEqual({ a: true, b: true, c: true });
    ws.getState().setLayersVisible(['a', 'b', 'c'], false);
    expect(updates).toBe(1);
    ws.getState().setLayersVisible(['a', 'c'], true);
    expect(updates).toBe(2);
    expect(ws.getState().hidden).toEqual({ b: true });
    off();
  });

  it('rejects an absurd playback rate', () => {
    expect(() => {
      createWorkspace().getState().setRate(0);
    }).toThrow('between 0 and 16');
  });

  it('issues camera requests with increasing sequence numbers and consumes them', () => {
    const ws = createWorkspace();
    ws.getState().flyTo({ kind: 'home' });
    const first = ws.getState().camera?.seq ?? 0;
    ws.getState().flyTo({ kind: 'home' });
    expect(ws.getState().camera?.seq).toBe(first + 1);
    ws.getState().consumeCamera(first + 1);
    expect(ws.getState().camera).toBeNull();
  });

  it('keeps the last camera request after the 3D view consumes it, so the map can follow', () => {
    const ws = createWorkspace();
    const seen: (number | undefined)[] = [];
    // the 3D view consumes inside its listener, before later listeners run
    ws.subscribe((s) => {
      if (s.camera) s.consumeCamera(s.camera.seq);
    });
    ws.subscribe((s, prev) => {
      if (s.lastCamera !== prev.lastCamera) seen.push(s.lastCamera?.seq);
    });
    ws.getState().flyTo({ kind: 'point', p: [1, 0, 2] });
    expect(ws.getState().camera).toBeNull();
    expect(ws.getState().lastCamera?.target).toEqual({ kind: 'point', p: [1, 0, 2] });
    expect(seen).toHaveLength(1);
  });
});

describe('replaceManifest', () => {
  it('swaps the manifest of the open project and keeps clock, selection and visibility', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'hcl', root: 'R', manifest });
    ws.getState().setTime(123);
    ws.getState().select({ kind: 'layer', id: 'tank' });
    const hidden = ws.getState().hidden;
    const next = { ...manifest, name: 'Renamed' };
    ws.getState().replaceManifest(next);
    const s = ws.getState();
    expect(s.project).toEqual({ id: 'hcl', root: 'R', manifest: next });
    expect(s.nowMs).toBe(123);
    expect(s.selection?.id).toBe('tank');
    expect(s.hidden).toBe(hidden);
  });

  it('shows layers that are new in the manifest unless they are saved hidden', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'hcl', root: 'R', manifest });
    const extra = {
      ...manifest,
      layers: [...manifest.layers, { ...manifest.layers[1], id: 'new', visible: false }],
    };
    ws.getState().replaceManifest(extra as typeof manifest);
    expect(ws.getState().hidden).toEqual({ tank: true, new: true });
  });

  it('makes the first imported clip active when none was', () => {
    const ws = createWorkspace();
    const noClips = { ...manifest, layers: manifest.layers.filter((l) => l.kind !== 'video') };
    ws.getState().openProject({ id: 'hcl', root: 'R', manifest: noClips });
    expect(ws.getState().activeClip).toBeNull();
    ws.getState().replaceManifest(manifest);
    expect(ws.getState().activeClip).toBe('f110');
    expect(ws.getState().nowMs).toBe(1_700_000_000_250);
  });

  it('does nothing without an open project', () => {
    const ws = createWorkspace();
    ws.getState().replaceManifest(manifest);
    expect(ws.getState().project).toBeNull();
  });
});

describe('assetUrl', () => {
  it('builds project asset urls', () => {
    expect(assetUrl('al-zour', { path: 'video/DJI 0789.mp4' })).toBe(
      'aio://project/al-zour/video/DJI%200789.mp4',
    );
  });

  it('refuses paths that leave the project', () => {
    expect(() => assetUrl('p', { path: '../secret.txt' })).toThrow('may not leave the project');
  });
});
