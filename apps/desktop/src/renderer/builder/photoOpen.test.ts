// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { stagePrefs } from '../workspace/stagePrefs';
import { openPhoto } from './photoOpen';

const id = 'photo-split-click-test';

function open(): void {
  workspace.getState().openProject({
    id,
    root: 'x',
    manifest: {
      layers: [{ kind: 'photos', id: 'photos', name: 'Photos', visible: true, items: [] }],
    } as unknown as ProjectManifest,
  });
}

afterEach(() => {
  stagePrefs.getState().update(id, { split: undefined });
  workspace.getState().closeProject();
});

describe('openPhoto', () => {
  it('puts the map on the left and the photo on the right, and stays on the scene', () => {
    open();
    shell.setState({ screen: 'inspect', stageMode: 'map', stageAuto: true });
    openPhoto('photos', 'p1', 'map');
    expect(shell.getState()).toMatchObject({ screen: 'scene', stageMode: 'split' });
    expect(stagePrefs.getState().byProject[id]?.split).toMatchObject({
      left: 'map',
      right: 'photo',
    });
    expect(workspace.getState().selection).toEqual({ kind: 'photo', id: 'p1', layer: 'photos' });
  });

  it('keeps the 3D view and gives the photo the other side', () => {
    open();
    stagePrefs.getState().update(id, { split: { left: 'raster', right: '3d', raster: 'ortho' } });
    shell.setState({ screen: 'scene', stageMode: '3d', stageAuto: true });
    openPhoto('photos', 'p2', '3d');
    expect(shell.getState().stageMode).toBe('split');
    expect(shell.getState().screen).toBe('scene');
    expect(stagePrefs.getState().byProject[id]?.split).toEqual({
      left: 'photo',
      right: '3d',
      raster: 'ortho',
    });
    expect(workspace.getState().selection).toEqual({ kind: 'photo', id: 'p2', layer: 'photos' });
  });
});
