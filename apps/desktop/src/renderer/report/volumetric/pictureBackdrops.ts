/**
 * What a top-down report picture leaves out, so that ground without survey data is paper: the
 * stage's sky and studio backdrop (`packages/engine/src/stage/environment.ts`) and the offline
 * street map under the site (`workspace/siteBasemap.ts`, `SITE_BASEMAP_ID`), which stands in for
 * the plain ground and is dark all around the survey. A base map the project holds as a layer of
 * its own is the project's picture and stays.
 */
import type { Object3D } from 'three';

export const TOP_DOWN_HIDDEN: readonly string[] = [
  'env:physicalSky',
  'env:sky',
  'basemap:site-street-map',
];

/** Hide them for one render; returns the ones that were showing, to show again afterwards. */
export function hideForTopDown(scene: Object3D): Object3D[] {
  const hidden: Object3D[] = [];
  for (const name of TOP_DOWN_HIDDEN) {
    const o = scene.getObjectByName(name);
    if (o?.visible) {
      o.visible = false;
      hidden.push(o);
    }
  }
  return hidden;
}
