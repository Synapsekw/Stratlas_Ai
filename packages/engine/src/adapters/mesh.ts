import {
  Box3,
  Group,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { engineConfig } from '../config';
import type { LayerAdapter, LayerHandle, SceneHandle } from '../types';
import { isMesh, layerMatrix, markNodes, mergeByMaterial } from './model';

/** Extra hooks the engine's own stage offers; other SceneHandle implementations may lack them. */
interface StageHooks {
  setWaterLevel(level: number | null): void;
  invalidateShadows(): void;
}
const hooks = (s: SceneHandle): Partial<StageHooks> => s as Partial<StageHooks>;

let draco: DRACOLoader | null = null;

function loader(): GLTFLoader {
  const l = new GLTFLoader();
  l.setMeshoptDecoder(MeshoptDecoder);
  const path = engineConfig().dracoDecoderPath;
  if (path) {
    draco ??= new DRACOLoader().setDecoderPath(path);
    l.setDRACOLoader(draco);
  }
  return l;
}

const GROUNDISH = /^(Ground|Ground_Mainland|Paving|Asphalt|Laydown|Slope|Concrete)/;

function disposeTree(root: Object3D) {
  const geos = new Set<BufferGeometry>();
  const mats = new Set<Material>();
  root.traverse((m) => {
    if (!isMesh(m)) return;
    geos.add(m.geometry);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) {
    for (const v of Object.values(m))
      if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
    m.dispose();
  }
}

/**
 * GLB / glTF mesh layers: Meshopt and quantized meshes, optional DRACO. Applies the layer
 * transform, keeps node names and extras (as userData), casts and receives shadows, shares the
 * stage clipping planes, merges static geometry per material for draw-call count, and registers
 * the result for picking and video projection.
 */
export const meshAdapter: LayerAdapter<'mesh'> = {
  kind: 'mesh',
  async create(layer, ctx) {
    const gltf = await loader().loadAsync(ctx.url(layer.src));
    const stage = ctx.scene;
    const group = new Group();
    group.name = `layer:${layer.id}`;
    group.userData.aioLayer = layer.id;
    group.matrixAutoUpdate = false;
    group.matrix.copy(layerMatrix(layer.transform));

    const root = gltf.scene;
    markNodes(root, (o) => gltf.parser.associations.get(o)?.nodes !== undefined);
    group.add(root);

    // the animated water replaces a modelled sea
    let seaTop: number | null = null;
    const sea = root.getObjectByName('Sea');
    if (sea?.userData.type === 'terrain') {
      group.updateMatrixWorld(true);
      seaTop = new Box3().setFromObject(sea).max.y;
      sea.visible = false;
    }

    const materials = new Set<Material>();
    root.traverse((o) => {
      if (!isMesh(o)) return;
      const m = o;
      const terrain = o.userData.type === 'terrain' || o.parent?.userData.type === 'terrain';
      m.castShadow = !terrain;
      m.receiveShadow = true;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
    });
    for (const mat of materials) {
      mat.clippingPlanes = stage.clippingPlanes;
      mat.clipShadows = true;
      const std = mat as MeshStandardMaterial;
      if ('envMapIntensity' in std) std.envMapIntensity = GROUNDISH.test(mat.name) ? 0.3 : 0.6;
      if (mat.name === 'Zone_Line') mat.visible = false;
    }

    const merged = mergeByMaterial(root, group);
    for (const m of merged) group.add(m);

    // static content: compute world matrices once and skip them in the per-frame update
    stage.scene.add(group);
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      o.matrixAutoUpdate = false;
    });

    root.userData.aioTags = layer.tags ?? [];
    root.userData.aioTagged = new Set((layer.tags ?? []).map((t) => t.node));

    const unregister = [
      stage.addRaycastTarget(root, layer.id),
      ...merged.map((m) => stage.addProjectionReceiver(m)),
    ];
    // unmerged meshes (multi-material, skinned) are drawn as they are and receive too
    root.traverse((o) => {
      if (isMesh(o) && o.layers.isEnabled(0)) unregister.push(stage.addProjectionReceiver(o));
    });
    if (seaTop !== null) hooks(stage).setWaterLevel?.(seaTop);
    hooks(stage).invalidateShadows?.();
    stage.requestRender();

    let disposed = false;
    const handle: LayerHandle = {
      setVisible(v) {
        if (group.visible === v) return;
        group.visible = v;
        if (seaTop !== null) hooks(stage).setWaterLevel?.(v ? seaTop : null);
        hooks(stage).invalidateShadows?.();
        stage.requestRender();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const u of unregister) u();
        stage.scene.remove(group);
        if (seaTop !== null) hooks(stage).setWaterLevel?.(null);
        for (const m of merged) m.geometry.dispose();
        disposeTree(root);
        hooks(stage).invalidateShadows?.();
        stage.requestRender();
      },
    };
    return handle;
  },
};
