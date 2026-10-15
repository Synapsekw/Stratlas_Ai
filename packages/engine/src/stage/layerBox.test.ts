import { BoxGeometry, Group, Mesh, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { layerBox } from './layerBox';

const cube = (x: number) => {
  const m = new Mesh(new BoxGeometry(2, 2, 2));
  m.position.set(x, 1, 0);
  m.updateMatrixWorld(true);
  return m;
};

describe('layerBox', () => {
  it('frames the visible scene objects tagged with the layer (mesh, cloud, tiles, photos)', () => {
    const scene = new Scene();
    const a = new Group();
    a.userData.layerId = 'm';
    a.add(cube(10));
    const photos = new Group();
    photos.userData.photosLayer = 'p';
    photos.add(cube(-10));
    const hidden = new Group();
    hidden.userData.layerId = 'm';
    hidden.visible = false;
    hidden.add(cube(100));
    scene.add(a, photos, hidden);
    scene.updateMatrixWorld(true);
    expect(layerBox(scene, 'm')?.min.toArray()).toEqual([9, 0, -1]);
    expect(layerBox(scene, 'm')?.max.toArray()).toEqual([11, 2, 1]);
    expect(layerBox(scene, 'p')?.min.x).toBe(-11);
    expect(layerBox(scene, 'none')).toBeNull();
  });
});
