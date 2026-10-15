/**
 * Load finer point-cloud nodes inside a photo's view before a finding is projected from it
 * (findings on a model): the octree refines for the photo frustum instead of the camera until
 * `release`, and the promise resolves when loading settles or after `timeoutMs`.
 */
import type { SceneHandle } from '@aio/engine';
import { getCloudManager } from './adapter';
import type { LodFocus } from './manager';

export type { LodFocus } from './manager';

export interface RefineResult {
  /** Deepest octree depth loaded inside the frustum. */
  depth: number;
  /** False when the timeout ended the wait. */
  settled: boolean;
  /** Hand the level of detail back to the camera. Safe to call more than once. */
  release(): void;
}

export function refineAround(
  handle: SceneHandle,
  focus: LodFocus,
  timeoutMs = 3000,
): Promise<RefineResult> {
  const manager = getCloudManager(handle);
  if (!manager) return Promise.resolve({ depth: 0, settled: true, release: () => undefined });
  const seq = manager.setFocus(focus);
  const hold = (handle as Partial<SceneHandle>).holdContinuous?.('pointcloud-refine');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    hold?.();
    manager.clearFocus(seq);
  };
  return new Promise((resolve) => {
    const started = performance.now();
    let done = false;
    let off: () => void = () => undefined;
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve({ depth: manager.deepestLoaded(focus.planes), settled, release });
    };
    // frames may stop (a hidden window): the timeout still ends the wait
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    off = handle.onFrame(() => {
      if (manager.settled(seq)) finish(true);
      else if (performance.now() - started >= timeoutMs) finish(false);
    });
  });
}
