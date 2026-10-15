import { Box3, type Object3D } from 'three';

/** Tags a layer's scene objects carry: models and clouds `layerId`, photo sets `photosLayer`. */
const owns = (o: Object3D, id: string) =>
  o.userData.layerId === id || o.userData.photosLayer === id || o.userData.aioLayer === id;

/** The world box of the visible objects of one layer under `root`, or null when none is drawn. */
export function layerBox(root: Object3D, layerId: string): Box3 | null {
  const box = new Box3();
  const visit = (o: Object3D) => {
    if (!o.visible) return;
    if (owns(o, layerId)) {
      box.expandByObject(o);
      return;
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return box.isEmpty() ? null : box;
}
