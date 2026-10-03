import {
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  Vector3,
  type Material,
  type Object3D,
} from 'three';

/** Type guard; `isMesh` is typed as always true on Mesh, so check it on a partial. */
export const isMesh = (o: Object3D): o is Mesh => (o as Partial<Mesh>).isMesh === true;

/** Originals of merged meshes live on this layer: raycast, never rendered by the main camera. */
export const PICK_LAYER = 2;

/** The mesh layer `transform` (column-major, three.js `Matrix4.elements` order). */
export function layerMatrix(t: readonly number[]): Matrix4 {
  if (t.length !== 16) throw new Error(`A layer transform needs 16 numbers, got ${t.length}`);
  return new Matrix4().fromArray(t);
}

/** Flag the objects that correspond to glTF nodes (as opposed to primitives of a multi-primitive mesh). */
export function markNodes(root: Object3D, isNode: (o: Object3D) => boolean): void {
  root.traverse((o) => {
    if (isNode(o)) o.userData.aioNode = true;
  });
}

const isTerrain = (o: Object3D) => o.userData.type === 'terrain';
const hasTag = (o: Object3D) =>
  typeof o.userData.tag === 'string' || typeof o.userData.id === 'string';

/**
 * The node a click on `hit` selects, walking up to (not including) `stopAt`:
 * 1. the nearest node named in the manifest tags, else
 * 2. the nearest node with an extras `tag` or `id` (asset register rows), else
 * 3. nothing for terrain, else
 * 4. the glTF node that owns the mesh.
 */
export function selectableNode(
  hit: Object3D,
  stopAt: Object3D,
  tagged: ReadonlySet<string>,
): Object3D | null {
  const chain: Object3D[] = [];
  for (let o: Object3D | null = hit; o && o !== stopAt; o = o.parent) {
    if (o.userData.aioNode === true) chain.push(o);
  }
  const manifestTagged = chain.find((o) => tagged.has(o.name));
  if (manifestTagged) return manifestTagged;
  const registered = chain.find(hasTag);
  if (registered) return registered;
  if (chain.some(isTerrain)) return null;
  return chain[0] ?? null;
}

function visibleTo(o: Object3D, root: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return true;
}

const _m = new Matrix4();
const _inv = new Matrix4();
const _n = new Matrix3();
const _v = new Vector3();

/**
 * Merge every visible single-material mesh under `root` into one mesh per material (and shadow
 * flag), with geometry in the local space of `space`. Turns about 1 800 glTF primitives into a
 * few dozen draws. The originals move to PICK_LAYER: still raycast for picking, no longer drawn.
 */
export function mergeByMaterial(root: Object3D, space: Object3D): Mesh[] {
  root.updateMatrixWorld(true);
  space.updateMatrixWorld(true);
  _inv.copy(space.matrixWorld).invert();
  const buckets = new Map<string, { material: Material; cast: boolean; meshes: Mesh[] }>();
  root.traverse((o) => {
    if (!isMesh(o) || Array.isArray(o.material)) return;
    const mesh = o;
    if ((o as { isInstancedMesh?: boolean }).isInstancedMesh === true) return;
    if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) return;
    if (!visibleTo(o, root)) return;
    const material = mesh.material as Material;
    if (material.vertexColors || !mesh.geometry.hasAttribute('position')) return;
    const key = `${material.uuid}|${mesh.castShadow ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) {
      b = { material, cast: mesh.castShadow, meshes: [] };
      buckets.set(key, b);
    }
    b.meshes.push(mesh);
  });

  const out: Mesh[] = [];
  for (const { material, cast, meshes } of buckets.values()) {
    let vCount = 0;
    let iCount = 0;
    for (const m of meshes) {
      const g = m.geometry;
      const n = g.getAttribute('position').count;
      vCount += n;
      iCount += g.index ? g.index.count : n;
    }
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const idx = new Uint32Array(iCount);
    let vo = 0;
    let io = 0;
    for (const m of meshes) {
      const g = m.geometry;
      const p = g.getAttribute('position');
      const nAttr = g.getAttribute('normal') as BufferAttribute | undefined;
      _m.multiplyMatrices(_inv, m.matrixWorld);
      _n.getNormalMatrix(_m);
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i).applyMatrix4(_m);
        pos[(vo + i) * 3] = _v.x;
        pos[(vo + i) * 3 + 1] = _v.y;
        pos[(vo + i) * 3 + 2] = _v.z;
        if (nAttr) {
          _v.fromBufferAttribute(nAttr, i).applyMatrix3(_n).normalize();
          nor[(vo + i) * 3] = _v.x;
          nor[(vo + i) * 3 + 1] = _v.y;
          nor[(vo + i) * 3 + 2] = _v.z;
        }
      }
      if (g.index) {
        const src = g.index;
        for (let i = 0; i < src.count; i++) idx[io + i] = src.getX(i) + vo;
        io += src.count;
      } else {
        for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
        io += p.count;
      }
      vo += p.count;
      m.layers.set(PICK_LAYER);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setIndex(new BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const merged = new Mesh(geo, material);
    merged.name = `merged:${material.name || material.uuid}`;
    merged.castShadow = cast;
    merged.receiveShadow = true;
    merged.matrixAutoUpdate = false;
    merged.userData.aioMerged = true;
    // Picking goes through the originals, which keep per-node bounds for early outs.
    merged.raycast = () => undefined;
    out.push(merged);
  }
  return out;
}
