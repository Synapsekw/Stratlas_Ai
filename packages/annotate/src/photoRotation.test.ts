import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { rotatePhoto, setPhotoRotator, type PhotoRotateAnswer } from './runtime';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'rotation-a',
  name: 'Rotation fixture',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};
const open = (id: string) => {
  workspace.getState().openProject({ id, root: id, manifest: { ...manifest, id } }, []);
};

describe('photo rotation response ownership', () => {
  afterEach(() => {
    setPhotoRotator(null);
    workspace.getState().closeProject();
  });

  it.each(['another project', 'the same project reopened', 'closed'] as const)(
    'ignores a late result after %s',
    async (change) => {
      open('rotation-a');
      let finish: ((answer: PhotoRotateAnswer) => void) | undefined;
      setPhotoRotator(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = rotatePhoto('photos', 'p1');
      if (change === 'closed') workspace.getState().closeProject();
      else {
        open('rotation-b');
        if (change === 'the same project reopened') open('rotation-a');
      }
      const before = workspace.getState();
      finish?.({ ok: true, issues: [], manifest: { ...manifest, name: 'Late rotation' } });
      expect((await pending).ok).toBe(false);
      expect(workspace.getState().project).toBe(before.project);
      expect(workspace.getState().issues).toBe(before.issues);
    },
  );

  it('applies a successful response to the session that requested it', async () => {
    open('rotation-a');
    setPhotoRotator(() =>
      Promise.resolve({
        ok: true,
        issues: [],
        manifest: { ...manifest, name: 'Turned photo' },
      }),
    );
    expect((await rotatePhoto('photos', 'p1')).ok).toBe(true);
    expect(workspace.getState().project?.manifest.name).toBe('Turned photo');
  });
});
