import { Group, Mesh, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { hideForTopDown, TOP_DOWN_HIDDEN } from './pictureBackdrops';

describe('what a top-down report picture leaves out', () => {
  const sceneWith = (...names: string[]) => {
    const scene = new Scene();
    for (const name of names) {
      const o = name.startsWith('basemap:') ? new Group() : new Mesh();
      o.name = name;
      scene.add(o);
    }
    return scene;
  };

  it('hides the sky and the offline street map, so ground without survey data is paper', () => {
    // the street map stands in for the plain ground: dark, and drawn all around the survey
    expect(TOP_DOWN_HIDDEN).toContain('basemap:site-street-map');
    const scene = sceneWith('env:sky', 'env:physicalSky', 'basemap:site-street-map', 'layer:ortho');
    const hidden = hideForTopDown(scene);
    expect(hidden.map((o) => o.name).sort()).toEqual([
      'basemap:site-street-map',
      'env:physicalSky',
      'env:sky',
    ]);
    expect(scene.getObjectByName('basemap:site-street-map')?.visible).toBe(false);
    expect(scene.getObjectByName('layer:ortho')?.visible).toBe(true);
  });

  it('leaves alone what was hidden already, so it is not shown afterwards', () => {
    const scene = sceneWith('env:sky', 'basemap:site-street-map');
    const map = scene.getObjectByName('basemap:site-street-map');
    if (map) map.visible = false;
    expect(hideForTopDown(scene).map((o) => o.name)).toEqual(['env:sky']);
  });

  it('keeps a base map the project holds as a layer of its own', () => {
    const scene = sceneWith('basemap:imagery-1');
    expect(hideForTopDown(scene)).toEqual([]);
    expect(scene.getObjectByName('basemap:imagery-1')?.visible).toBe(true);
  });
});
