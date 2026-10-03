import type { ProjectManifest } from '@aio/schema';
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

  it('toggles layer visibility', () => {
    const ws = createWorkspace();
    ws.getState().setLayerVisible('a', false);
    expect(ws.getState().isLayerVisible('a')).toBe(false);
    ws.getState().setLayerVisible('a', true);
    expect(ws.getState().isLayerVisible('a')).toBe(true);
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
