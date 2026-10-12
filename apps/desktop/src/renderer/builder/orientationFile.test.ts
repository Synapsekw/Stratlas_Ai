import type { DirectionKey, OrientationFile, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Saving orientation.json never drops other clips' keyframes because the file was not loaded. */

const call = vi.fn();
vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
}));

import {
  loadOrientation,
  retryOrientation,
  saveOrientationEdit,
  withClipKeys,
} from './orientationFile';

const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
} as unknown as ProjectManifest;

const key = (t: number, yaw: number): DirectionKey => ({
  t,
  yaw,
  pitch: -10,
  roll: 0,
  fill: 'hold',
});

const onDisk: OrientationFile = {
  schema: 'aio.orientation/1',
  clips: { a: { keys: [key(0, 10)] } },
  photos: {},
};

function written(): OrientationFile | undefined {
  const w = call.mock.calls.find(([name]) => name === 'orientation:write');
  return (w?.[1] as { file: OrientationFile } | undefined)?.file;
}

describe('saveOrientationEdit', () => {
  beforeEach(() => {
    call.mockReset();
    workspace.getState().closeProject();
    workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest });
  });

  it('reads the file from disk first when the workspace has none loaded', async () => {
    call.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'orientation:read'
          ? { ok: true, value: { ok: true, file: onDisk, readOnly: false } }
          : { ok: true, value: { ok: true } },
      ),
    );
    expect(workspace.getState().orientation).toBeNull();
    const err = await saveOrientationEdit((f) => withClipKeys(f, 'b', [key(0, 50)]));
    expect(err).toBeNull();
    expect(Object.keys(written()?.clips ?? {}).sort()).toEqual(['a', 'b']);
    expect(Object.keys(workspace.getState().orientation?.clips ?? {}).sort()).toEqual(['a', 'b']);
  });

  it('writes nothing when the file on disk cannot be read', async () => {
    call.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'orientation:read'
          ? { ok: true, value: { ok: false, error: 'Could not read the camera directions' } }
          : { ok: true, value: { ok: true } },
      ),
    );
    const err = await saveOrientationEdit((f) => withClipKeys(f, 'b', [key(0, 50)]));
    expect(err).toMatch(/camera directions/);
    expect(written()).toBeUndefined();
  });

  it('edits the loaded file without reading it again', async () => {
    call.mockResolvedValue({ ok: true, value: { ok: true } });
    workspace.getState().setOrientation(onDisk);
    const err = await saveOrientationEdit((f) => withClipKeys(f, 'b', [key(0, 50)]));
    expect(err).toBeNull();
    expect(call.mock.calls.map(([n]) => n as string)).toEqual(['orientation:write']);
    expect(Object.keys(written()?.clips ?? {}).sort()).toEqual(['a', 'b']);
  });

  it('drops a read that was under way when a save wrote the file', async () => {
    let giveFirst: () => void = () => undefined;
    let reads = 0;
    call.mockImplementation((name: string) => {
      if (name !== 'orientation:read') return Promise.resolve({ ok: true, value: { ok: true } });
      reads += 1;
      const reply = { ok: true, value: { ok: true, file: onDisk, readOnly: false } };
      if (reads > 1) return Promise.resolve(reply);
      return new Promise((resolve) => {
        giveFirst = () => {
          resolve(reply);
        };
      });
    });
    const load = loadOrientation();
    const err = await saveOrientationEdit((f) => withClipKeys(f, 'b', [key(0, 50)]));
    expect(err).toBeNull();
    giveFirst();
    await load;
    expect(Object.keys(workspace.getState().orientation?.clips ?? {}).sort()).toEqual(['a', 'b']);
  });

  it('reads again after a failed read, not while a read is under way', async () => {
    let give: (v: unknown) => void = () => undefined;
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          give = resolve;
        }),
    );
    const load = loadOrientation();
    retryOrientation();
    expect(call).toHaveBeenCalledTimes(1);
    give({ ok: true, value: { ok: false, error: 'Could not read the camera directions' } });
    await load;
    expect(workspace.getState().orientationLoaded).toBe(false);
    retryOrientation();
    expect(call).toHaveBeenCalledTimes(2);
    give({ ok: true, value: { ok: true, file: onDisk, readOnly: false } });
    await vi.waitFor(() => {
      expect(workspace.getState().orientationLoaded).toBe(true);
    });
    retryOrientation();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('builds each of two overlapping saves on the one before', async () => {
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, value: { ok: true } });
          }, 5);
        }),
    );
    workspace.getState().setOrientation(onDisk);
    const [e1, e2] = await Promise.all([
      saveOrientationEdit((f) => withClipKeys(f, 'b', [key(0, 50)])),
      saveOrientationEdit((f) => withClipKeys(f, 'c', [key(0, 60)])),
    ]);
    expect([e1, e2]).toEqual([null, null]);
    expect(Object.keys(workspace.getState().orientation?.clips ?? {}).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
