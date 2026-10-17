import type { SceneHandle } from '@aio/engine';
import type { Box3 } from 'three';
import { Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { REACH_KEY, SCENE_GROUP, arrowSegments, attachCoverageScene } from './coverageScene';

/** Enough of the engine stage: `isEngineStage` and the reach. */
function stage() {
  const setReach = vi.fn<(key: string, box: Box3 | null) => void>();
  const h = {
    scene: new Scene(),
    requestRender: vi.fn(),
    setViewPreset: vi.fn(),
    setTool: vi.fn(),
    setReach,
  };
  return { h: h as unknown as SceneHandle, setReach, scene: h.scene };
}

const sheet = {
  image: { width: 2, height: 2, scale: 1, data: new Uint8ClampedArray(16) },
  key: 'k',
  centre: [10, -5] as [number, number],
  sizeM: [200, 100] as [number, number],
  groundY: 2,
};

describe('the 3D drape', () => {
  it('lets the camera back off over the whole sheet while it shows, and not once it is hidden', () => {
    const { h, setReach, scene } = stage();
    const v = attachCoverageScene(h);
    expect(scene.getObjectByName(SCENE_GROUP)).toBe(v.group);
    v.draw({ sheet, arrows: [], visible: true, opacity: 0.6 });
    const box = setReach.mock.calls.at(-1)?.[1];
    expect(setReach.mock.calls.at(-1)?.[0]).toBe(REACH_KEY);
    expect(box?.min.toArray()).toEqual([-90, 2, -55]);
    expect(box?.max.toArray()).toEqual([110, 3, 45]);
    v.draw({ sheet, arrows: [], visible: false, opacity: 0.6 });
    expect(setReach.mock.calls.at(-1)?.[1]).toBeNull();
    expect(v.group.visible).toBe(false);
    v.dispose();
    expect(setReach.mock.calls.at(-1)).toEqual([REACH_KEY, null]);
    expect(scene.getObjectByName(SCENE_GROUP)).toBeUndefined();
  });

  it('draws an arrow as a shaft and a two-line head', () => {
    const s = arrowSegments({ from: [0, 30, 0], dir: [1, 0, 0], lengthM: 20, colour: '#fff' });
    expect(s).toHaveLength(18);
    expect(s.slice(3, 6)).toEqual([20, 30, 0]);
  });
});
