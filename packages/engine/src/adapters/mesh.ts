import {
  Box3,
  Group,
  type BufferGeometry,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { engineConfig } from '../config';
import type { LayerAdapter, LayerHandle, SceneHandle } from '../types';
import { MASK_LAYER, maskTerrainMaterial, type GroundUniforms } from '../stage/groundShading';
import { isMesh, layerMatrix, markNodes, mergeByMaterial } from './model';
import { SharedAssets } from './shared';

/** Extra hooks the engine's own stage offers; other SceneHandle implementations may lack them. */
interface StageHooks {
  setWaterLevel(level: number | null): void;
  invalidateShadows(): void;
  groundUniforms(): GroundUniforms;
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
/** Ground surfaces whose modelled outline may overhang the real shore (cut where imagery shows sea). */
const SHORE = /^(Ground|Ground_Mainland|Paving|Asphalt|Laydown|Slope|Rock_Armour)$/;

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
 * A parsed GLB ready to place, shared by every stage that shows it: the layer group (transform,
 * nodes, merged draw meshes, shadow and mask flags) with stage-independent materials. Each stage
 * draws its own clone of the group: geometry and textures are shared, materials are copied
 * (clipping planes and the land mask belong to one stage).
 */
export interface MeshTemplate {
  group: Group;
  /** Top of a modelled sea (the stage's animated water replaces it), or null. */
  seaTop: number | null;
  /** Terrain and shore materials: their sea is cut out where the imagery shows water. */
  terrain: Set<Material>;
}

/** Build a template from a parsed glTF scene (exported for tests, which have no loader). */
export function buildTemplate(
  root: Object3D,
  transform: readonly number[],
  isNode: (o: Object3D) => boolean,
): MeshTemplate {
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.matrix.copy(layerMatrix(transform));
  markNodes(root, isNode);
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
  const terrain = new Set<Material>();
  group.updateMatrixWorld(true);
  const box = new Box3();
  root.traverse((o) => {
    if (!isMesh(o)) return;
    const m = o;
    const isTerrain = o.userData.type === 'terrain' || o.parent?.userData.type === 'terrain';
    // pavements, slabs and roads lie on the ground: their shadow is invisible there, and where
    // an indicative outline overhangs the real shore it would darken the water
    box.setFromObject(o);
    const flat = box.max.y - box.min.y < 1 && box.max.y < 1.5;
    m.castShadow = !isTerrain && !flat;
    m.receiveShadow = true;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      materials.add(mat);
      if ((isTerrain && o !== sea) || SHORE.test(mat.name)) terrain.add(mat);
    }
  });
  for (const mat of materials) {
    mat.clipShadows = true;
    const std = mat as MeshStandardMaterial;
    if ('envMapIntensity' in std) std.envMapIntensity = GROUNDISH.test(mat.name) ? 0.3 : 0.6;
    if (mat.name === 'Zone_Line') mat.visible = false;
  }

  const merged = mergeByMaterial(root, group);
  for (const m of merged) group.add(m);
  // what stands on land: the land mask that lets animated water show through photographed sea
  group.traverse((o) => {
    if (isMesh(o) && o.layers.isEnabled(0)) o.layers.enable(MASK_LAYER);
  });
  root.userData.aioLandMask = true;
  // static content: compute world matrices once and skip them in the per-frame update
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
  return { group, seaTop, terrain };
}

async function loadTemplate(url: string, transform: readonly number[]): Promise<MeshTemplate> {
  const gltf = await loader().loadAsync(url);
  return buildTemplate(
    gltf.scene,
    transform,
    (o) => gltf.parser.associations.get(o)?.nodes !== undefined,
  );
}

/** Parsed GLBs by URL and transform, shared between stages (the last release frees one). */
export const meshTemplates = new SharedAssets<MeshTemplate>((t) => {
  disposeTree(t.group);
});

/** One stage's copy of a template: shared geometry and textures, its own materials. */
export function instantiate(t: MeshTemplate): {
  group: Group;
  root: Object3D;
  merged: Mesh[];
  materials: Material[];
  terrain: Material[];
} {
  const group = t.group.clone(true);
  const copies = new Map<Material, Material>();
  const copy = (m: Material) => {
    let c = copies.get(m);
    if (!c) {
      c = m.clone();
      copies.set(m, c);
    }
    return c;
  };
  const merged: Mesh[] = [];
  group.traverse((o) => {
    if (!isMesh(o)) return;
    o.material = Array.isArray(o.material) ? o.material.map(copy) : copy(o.material);
    if (o.userData.aioMerged === true) {
      // merged draw meshes are never picked (a clone drops the override)
      o.raycast = () => undefined;
      merged.push(o);
    }
  });
  const root = group.children[0] ?? group;
  const terrain = [...copies].filter(([orig]) => t.terrain.has(orig)).map(([, c]) => c);
  return { group, root, merged, materials: [...copies.values()], terrain };
}

/**
 * GLB / glTF mesh layers: Meshopt and quantized meshes, optional DRACO. Applies the layer
 * transform, keeps node names and extras (as userData), casts and receives shadows, shares the
 * stage clipping planes, merges static geometry per material for draw-call count, and registers
 * the result for picking and video projection. A file is parsed once however many stages show it
 * (`meshTemplates`); each stage gets its own materials.
 */
export const meshAdapter: LayerAdapter<'mesh'> = {
  kind: 'mesh',
  async create(layer, ctx) {
    const url = ctx.url(layer.src);
    const lease = await meshTemplates.acquire(`${url}#${layer.transform.join(',')}`, () =>
      loadTemplate(url, layer.transform),
    );
    const t = lease.value;
    const stage = ctx.scene;
    const { group, root, merged, materials, terrain } = instantiate(t);
    group.name = `layer:${layer.id}`;
    group.userData.aioLayer = layer.id;
    // annotation sightings and back-projection name their layer from the nearest layerId
    group.userData.layerId = layer.id;

    // modelled shores are indicative: where the imagery shows sea, the water wins
    const ground = hooks(stage).groundUniforms?.();
    if (ground) for (const mat of terrain) maskTerrainMaterial(mat, ground);
    for (const mat of materials) mat.clippingPlanes = stage.clippingPlanes;

    stage.scene.add(group);
    group.updateMatrixWorld(true);

    root.userData.aioTags = layer.tags ?? [];
    root.userData.aioTagged = new Set((layer.tags ?? []).map((tag) => tag.node));

    const unregister = [
      stage.addRaycastTarget(root, layer.id),
      ...merged.map((m) => stage.addProjectionReceiver(m)),
    ];
    // unmerged meshes (multi-material, skinned) are drawn as they are and receive too
    root.traverse((o) => {
      if (isMesh(o) && o.layers.isEnabled(0)) unregister.push(stage.addProjectionReceiver(o));
    });
    if (t.seaTop !== null) hooks(stage).setWaterLevel?.(t.seaTop);
    hooks(stage).invalidateShadows?.();
    stage.requestRender();

    let disposed = false;
    const handle: LayerHandle = {
      setVisible(v) {
        if (group.visible === v) return;
        group.visible = v;
        hooks(stage).invalidateShadows?.();
        stage.requestRender();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const u of unregister) u();
        stage.scene.remove(group);
        if (t.seaTop !== null) hooks(stage).setWaterLevel?.(null);
        // this stage's materials only: geometry and textures belong to the shared template
        for (const m of materials) m.dispose();
        lease.release();
        hooks(stage).invalidateShadows?.();
        stage.requestRender();
      },
    };
    return handle;
  },
};
