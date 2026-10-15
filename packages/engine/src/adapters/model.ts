import {
  BufferAttribute,
  BufferGeometry,
  type InterleavedBufferAttribute,
  Matrix3,
  Matrix4,
  Mesh,
  Vector3,
  type Intersection,
  type Material,
  type Object3D,
  type Plane,
  type Raycaster,
} from 'three';
import type { ComponentDimension, ComponentInfo, ComponentQuality } from '../types';

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

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The engineering component record in a node's extras, or null for any other node. */
export function componentOf(node: Object3D): ComponentInfo | null {
  const ud = node.userData;
  const id = str(ud.component);
  if (id === undefined || id === '') return null;
  const info: ComponentInfo = { id, name: str(ud.name) ?? id };
  const category = str(ud.category);
  const description = str(ud.description);
  const tag = str(ud.tag);
  const basis = str(ud.basis);
  if (category !== undefined) info.category = category;
  if (description !== undefined) info.description = description;
  if (tag !== undefined) info.tag = tag;
  if (basis !== undefined) info.basis = basis;
  const status = str(ud.status);
  const parent = str(ud.parent);
  if (status !== undefined) info.status = status;
  if (parent !== undefined) info.parent = parent;
  if (Array.isArray(ud.unobserved)) {
    const sides = (ud.unobserved as unknown[]).filter((s): s is string => typeof s === 'string');
    if (sides.length) info.unobserved = sides;
  }
  const quality = qualityOf(ud.quality);
  if (quality) info.quality = quality;
  const dimensions = dimensionsOf(ud.dimensions);
  if (dimensions) info.dimensions = dimensions;
  return info;
}

/** The `{param: {value, unit}}` dimensions of node extras; malformed entries are left out. */
function dimensionsOf(v: unknown): Record<string, ComponentDimension> | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, ComponentDimension> = {};
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (!d || typeof d !== 'object') continue;
    const { value, unit } = d as { value?: unknown; unit?: unknown };
    if (typeof unit !== 'string') continue;
    if (num(value) !== undefined) out[k] = { value: value as number, unit };
    else if (Array.isArray(value) && value.length && value.every((x) => num(x) !== undefined))
      out[k] = { value: value as number[], unit };
  }
  return Object.keys(out).length ? out : null;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function qualityOf(v: unknown): ComponentQuality | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as { params?: unknown; residualM?: unknown; coverage?: unknown };
  const params: Record<string, string> = {};
  if (q.params && typeof q.params === 'object')
    for (const [k, b] of Object.entries(q.params as Record<string, unknown>))
      if (typeof b === 'string') params[k] = b;
  const out: ComponentQuality = { params };
  const residualM = num(q.residualM);
  const coverage = num(q.coverage);
  if (residualM !== undefined) out.residualM = residualM;
  if (coverage !== undefined) out.coverage = coverage;
  return out;
}

/**
 * The selection id of a node: its extras `component` id, else its name (node names are not unique
 * across files, so a selection also names its layer).
 */
export function nodeId(node: Object3D): string {
  return componentOf(node)?.id ?? node.name;
}

/** The node under `root` (or `root` itself) a selection id names: component id, else name. */
export function nodeById(root: Object3D, id: string): Object3D | null {
  let named: Object3D | undefined;
  const stack: Object3D[] = [root];
  for (let o = stack.pop(); o; o = stack.pop()) {
    if (o.userData.component === id) return o;
    if (!named && o.name === id) named = o;
    for (let i = o.children.length - 1; i >= 0; i--) {
      const c = o.children[i];
      if (c) stack.push(c);
    }
  }
  return named ?? null;
}

/**
 * The node a click on `hit` selects, walking up to (not including) `stopAt`:
 * 1. the nearest engineering component (a node with an extras `component` id), else
 * 2. the nearest node named in the manifest tags, else
 * 3. the nearest node with an extras `tag` or `id` (asset register rows), else
 * 4. nothing for terrain, else
 * 5. the glTF node that owns the mesh.
 */
export function selectableNode(
  hit: Object3D,
  stopAt: Object3D,
  tagged: ReadonlySet<string>,
): Object3D | null {
  const chain: Object3D[] = [];
  for (let o: Object3D | null = hit; o && o !== stopAt; o = o.parent) {
    if (componentOf(o)) return o;
    if (o.userData.aioNode === true) chain.push(o);
  }
  const manifestTagged = chain.find((o) => tagged.has(o.name));
  if (manifestTagged) return manifestTagged;
  const registered = chain.find(hasTag);
  if (registered) return registered;
  if (chain.some(isTerrain)) return null;
  return chain[0] ?? null;
}

const shown = (o: Object3D | null): boolean => {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

/**
 * Hits of the raycaster's ray on `roots` (drawn and pick-layer meshes alike, per its layer mask),
 * nearest first, leaving out anything hidden (a hidden layer, a hidden component) and anything a
 * section plane cuts away: those never steal a pick from what is drawn behind them.
 */
export function visibleHits(
  raycaster: Raycaster,
  roots: Iterable<Object3D>,
  planes: readonly Plane[],
): Intersection[] {
  const hits: Intersection[] = [];
  for (const root of roots) {
    if (!shown(root)) continue;
    raycaster.intersectObject(root, true, hits);
  }
  return hits
    .filter((h) => shown(h.object) && planes.every((p) => p.distanceToPoint(h.point) >= 0))
    .sort((a, b) => a.distance - b.distance);
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

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

/**
 * The vertex attributes a geometry brings, as `name:itemSize` sorted: only geometries with the
 * same set merge, so texture coordinates, tangents and colours are never dropped or misaligned.
 */
export function attributeSignature(g: BufferGeometry): string {
  return Object.entries(g.attributes)
    .map(([name, a]) => `${name}:${String(a.itemSize)}`)
    .sort()
    .join(',');
}

/** Component `k` of vertex `i`, denormalised (quantised UVs come back as floats). */
function component(a: AnyAttribute, i: number, k: number): number {
  return k === 0 ? a.getX(i) : k === 1 ? a.getY(i) : k === 2 ? a.getZ(i) : a.getW(i);
}

/**
 * Merge every visible single-material mesh under `root` into one mesh per material, shadow flag
 * and vertex attribute set, with geometry in the local space of `space`. Turns about 1 800 glTF
 * primitives into a few dozen draws. Every attribute is kept: positions and normals (and tangent
 * directions) move into `space`, texture coordinates and the rest are copied. The originals move
 * to PICK_LAYER: still raycast for picking, no longer drawn. Meshes `separate` accepts are left
 * out and drawn as they are (engineering components, which hide one by one).
 */
export function mergeByMaterial(
  root: Object3D,
  space: Object3D,
  separate?: (mesh: Mesh) => boolean,
): Mesh[] {
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
    if (separate?.(mesh)) return;
    const material = mesh.material as Material;
    const g = mesh.geometry;
    if (material.vertexColors || !g.hasAttribute('position')) return;
    // morph targets animate per mesh: leave those meshes as they are
    if (Object.keys(g.morphAttributes).length > 0) return;
    const key = `${material.uuid}|${mesh.castShadow ? 1 : 0}|${attributeSignature(g)}`;
    let b = buckets.get(key);
    if (!b) {
      b = { material, cast: mesh.castShadow, meshes: [] };
      buckets.set(key, b);
    }
    b.meshes.push(mesh);
  });

  const out: Mesh[] = [];
  for (const { material, cast, meshes } of buckets.values()) {
    const first = meshes[0];
    if (!first) continue;
    const layout = Object.entries(first.geometry.attributes).map(([name, a]) => ({
      name,
      size: a.itemSize,
    }));
    let vCount = 0;
    let iCount = 0;
    for (const m of meshes) {
      const g = m.geometry;
      const n = g.getAttribute('position').count;
      vCount += n;
      iCount += g.index ? g.index.count : n;
    }
    const arrays = new Map(layout.map((l) => [l.name, new Float32Array(vCount * l.size)]));
    const idx = new Uint32Array(iCount);
    let vo = 0;
    let io = 0;
    for (const m of meshes) {
      const g = m.geometry;
      const count = g.getAttribute('position').count;
      _m.multiplyMatrices(_inv, m.matrixWorld);
      _n.getNormalMatrix(_m);
      for (const { name, size } of layout) {
        const src: AnyAttribute = g.getAttribute(name);
        const dst = arrays.get(name);
        if (!dst) continue;
        for (let i = 0; i < count; i++) {
          const at = (vo + i) * size;
          if (name === 'position') {
            _v.fromBufferAttribute(src, i).applyMatrix4(_m);
            dst[at] = _v.x;
            dst[at + 1] = _v.y;
            dst[at + 2] = _v.z;
          } else if (name === 'normal') {
            _v.fromBufferAttribute(src, i).applyMatrix3(_n).normalize();
            dst[at] = _v.x;
            dst[at + 1] = _v.y;
            dst[at + 2] = _v.z;
          } else if (name === 'tangent') {
            _v.set(src.getX(i), src.getY(i), src.getZ(i)).transformDirection(_m);
            dst[at] = _v.x;
            dst[at + 1] = _v.y;
            dst[at + 2] = _v.z;
            // the handedness flips with a mirroring transform
            if (size > 3) dst[at + 3] = src.getW(i) * (_m.determinant() < 0 ? -1 : 1);
          } else {
            for (let k = 0; k < size; k++) dst[at + k] = component(src, i, k);
          }
        }
      }
      if (g.index) {
        const src = g.index;
        for (let i = 0; i < src.count; i++) idx[io + i] = src.getX(i) + vo;
        io += src.count;
      } else {
        for (let i = 0; i < count; i++) idx[io + i] = vo + i;
        io += count;
      }
      vo += count;
      m.layers.set(PICK_LAYER);
    }
    const geo = new BufferGeometry();
    for (const { name, size } of layout) {
      const arr = arrays.get(name);
      if (arr) geo.setAttribute(name, new BufferAttribute(arr, size));
    }
    geo.setIndex(new BufferAttribute(idx, 1));
    if (!geo.hasAttribute('normal')) geo.computeVertexNormals();
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
