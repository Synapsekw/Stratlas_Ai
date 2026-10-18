import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bridge } from '../bridge';
import { ipcRunIpc } from './runStore';

const manifest = (id = 'p') =>
  ({
    schema: 'aio.project/1',
    id,
    name: id,
    crs: { epsg: 32640 },
    origin: [0, 0, 0],
    layers: [],
    captures: [],
    severityModels: [],
    classCatalogues: [],
  }) as ProjectManifest;
const builtManifest = {
  ...manifest(),
  layers: [
    {
      kind: 'mesh',
      id: 'model-draft-tower',
      name: 'Tower draft',
      visible: true,
      src: { path: 'models/tower-draft.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
} as ProjectManifest;

function bridge(build?: Promise<unknown>): Bridge {
  return {
    call: async (channel: string) => {
      if (channel === 'model:build' || channel === 'engineer:accept') {
        if (build) await build;
        return {
          ok: true,
          value: {
            ok: true,
            layer: 'model-draft-tower',
            glb: 'models/tower-draft.glb',
            triangles: 12,
          },
        };
      }
      if (channel === 'project:open')
        return { ok: true, value: { ok: true, manifest: builtManifest } };
      throw new Error(`Unexpected ${channel}`);
    },
  } as Bridge;
}

afterEach(() => {
  workspace.getState().closeProject();
});

describe('engineering layer visibility after writing a GLB', () => {
  it.each(['build', 'accept'])(
    'refreshes the active manifest after %s without resetting view state',
    async (action) => {
      workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest: manifest() });
      workspace.getState().setTime(1234);
      workspace.getState().setLayerVisible('unrelated', false);
      const ipc = ipcRunIpc(bridge(), 'p', 'E:/p');
      if (action === 'build') await ipc.modelBuild('tower', true);
      else await ipc.accept('tower');
      expect(workspace.getState().project?.manifest.layers.map((l) => l.id)).toContain(
        'model-draft-tower',
      );
      expect(workspace.getState().nowMs).toBe(1234);
      expect(workspace.getState().hidden.unrelated).toBe(true);
    },
  );

  it('does not install a completed draft into a project opened while it was building', async () => {
    workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest: manifest() });
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const built = ipcRunIpc(bridge(pending), 'p', 'E:/p').modelBuild('tower', true);
    workspace
      .getState()
      .openProject({ id: 'other', root: 'E:/other', manifest: manifest('other') });
    finish?.();
    await built;
    expect(workspace.getState().project?.id).toBe('other');
    expect(workspace.getState().project?.manifest.layers).toEqual([]);
  });
});
