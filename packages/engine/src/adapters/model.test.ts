import type { Object3D } from 'three';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import {
  PICK_LAYER,
  attributeSignature,
  layerMatrix,
  markNodes,
  mergeByMaterial,
  selectableNode,
} from './model';

describe('layerMatrix', () => {
  it('reads the manifest transform in column-major order', () => {
    // HCl tank frame (X north, Y up, Z east) to the local frame (X east, Y up, Z south)
    const m = layerMatrix([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 0, 7, 1]);
    const north = new Vector3(1, 0, 0).applyMatrix4(m);
    expect(north.toArray().map((v) => Math.round(v))).toEqual([5, 0, 6]); // 1 m north = z - 1
    const east = new Vector3(0, 0, 1).applyMatrix4(m);
    expect(east.toArray().map((v) => Math.round(v))).toEqual([6, 0, 7]);
  });

  it('rejects a matrix that is not 16 numbers', () => {
    expect(() => layerMatrix([1, 2, 3])).toThrow('16');
  });
});

function node(name: string, userData: Record<string, unknown> = {}, ...children: Object3D[]) {
  const o = new Group();
  o.name = name;
  o.userData = userData;
  o.userData.aioNode = true;
  o.add(...children);
  return o;
}
function prim(name: string) {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  m.name = name;
  return m;
}

describe('selectableNode', () => {
  const pumpMesh = prim('20-P-0001A');
  const tankWall = prim('20-T-0001_Outer_Tank_1');
  const sea = prim('Sea');
  const shell = prim('Shell_Course_1_Outer');
  const plant = node(
    'KIPIC',
    {},
    node(
      'Area_20',
      {},
      node(
        '20-T-0001',
        { tag: '20-T-0001', type: 'tank_lng' },
        node('20-T-0001_Outer_Tank', { type: 'tank_structure' }, tankWall),
        node('20-P-0001A', { id: '20-P-0001A', tag: '20-P-0001A', type: 'pump' }, pumpMesh),
      ),
    ),
    node('Site_Terrain', {}, node('Sea', { type: 'terrain' }, sea)),
  );
  const tank = node('Shell', {}, node('Shell_Course_1_Outer', {}, shell));
  const root = new Group();
  root.add(plant, tank);

  it('selects the nearest tagged node', () => {
    expect(selectableNode(pumpMesh, root, new Set())?.name).toBe('20-P-0001A');
  });

  it('walks past untagged structural parts to the tagged parent', () => {
    expect(selectableNode(tankWall, root, new Set())?.name).toBe('20-T-0001');
  });

  it('never selects terrain', () => {
    expect(selectableNode(sea, root, new Set())).toBeNull();
  });

  it('falls back to the glTF node of the mesh when nothing is tagged', () => {
    expect(selectableNode(shell, root, new Set())?.name).toBe('Shell_Course_1_Outer');
  });

  it('prefers nodes named in the manifest tags', () => {
    expect(selectableNode(tankWall, root, new Set(['20-T-0001_Outer_Tank']))?.name).toBe(
      '20-T-0001_Outer_Tank',
    );
  });
});

describe('markNodes', () => {
  it('flags objects that came from glTF nodes', () => {
    const a = new Group();
    const b = new Mesh();
    a.add(b);
    markNodes(a, (o) => o === a);
    expect(a.userData.aioNode).toBe(true);
    expect(b.userData.aioNode).toBeUndefined();
  });
});

describe('mergeByMaterial', () => {
  it('merges meshes that share a material into one draw, in layer space', () => {
    const mat = new MeshStandardMaterial({ name: 'Steel' });
    const other = new MeshStandardMaterial({ name: 'Concrete' });
    const root = new Group();
    const a = new Mesh(new BoxGeometry(1, 1, 1), mat);
    a.position.set(10, 0, 0);
    const b = new Mesh(new BoxGeometry(1, 1, 1), mat);
    b.position.set(-10, 0, 0);
    const c = new Mesh(new BoxGeometry(2, 2, 2), other);
    root.add(a, b, c);
    root.updateMatrixWorld(true);

    const merged = mergeByMaterial(root, root);
    expect(merged).toHaveLength(2);
    const steel = merged.find((m) => m.material === mat);
    if (!steel) throw new Error('missing steel');
    const pos = steel.geometry.getAttribute('position');
    expect(pos.count).toBe(48);
    steel.geometry.computeBoundingBox();
    expect(steel.geometry.boundingBox?.min.x).toBeCloseTo(-10.5);
    expect(steel.geometry.boundingBox?.max.x).toBeCloseTo(10.5);
    expect(steel.geometry.index?.count).toBe(72);
    // texture coordinates survive the merge
    expect(steel.geometry.getAttribute('uv').count).toBe(48);
    // originals stay for picking, on the pick layer only
    expect(a.layers.mask).toBe(1 << PICK_LAYER);
  });

  it('decodes quantized normals and skips invisible meshes', () => {
    const mat = new MeshStandardMaterial();
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    g.setAttribute(
      'normal',
      new BufferAttribute(new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), 3, true),
    );
    const root = new Group();
    const visible = new Mesh(g, mat);
    const hiddenParent = new Group();
    hiddenParent.visible = false;
    hiddenParent.add(new Mesh(g, mat));
    root.add(visible, hiddenParent);
    root.updateMatrixWorld(true);
    const [m] = mergeByMaterial(root, root);
    if (!m) throw new Error('no merge');
    expect(m.geometry.getAttribute('position').count).toBe(3);
    expect(m.geometry.getAttribute('normal').getZ(0)).toBeCloseTo(1, 5);
  });

  it('keeps texture coordinates and merges only geometries with the same attributes', () => {
    const mat = new MeshStandardMaterial();
    const tri = (uv: boolean) => {
      const g = new BufferGeometry();
      g.setAttribute(
        'position',
        new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
      );
      g.setAttribute(
        'normal',
        new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
      );
      // quantised UVs (KHR_mesh_quantization) come back as floats
      if (uv)
        g.setAttribute(
          'uv',
          new BufferAttribute(new Uint16Array([0, 0, 65535, 0, 0, 65535]), 2, true),
        );
      return g;
    };
    expect(attributeSignature(tri(true))).toBe('normal:3,position:3,uv:2');
    const root = new Group();
    const a = new Mesh(tri(true), mat);
    const b = new Mesh(tri(true), mat);
    b.position.set(5, 0, 0);
    const plain = new Mesh(tri(false), mat);
    root.add(a, b, plain);
    root.updateMatrixWorld(true);
    const merged = mergeByMaterial(root, root);
    expect(merged).toHaveLength(2);
    const textured = merged.find((m) => m.geometry.hasAttribute('uv'));
    if (!textured) throw new Error('uv dropped');
    const uv = textured.geometry.getAttribute('uv');
    expect(uv.count).toBe(6);
    expect([uv.getX(1), uv.getY(1), uv.getX(5), uv.getY(5)]).toEqual([1, 0, 0, 1]);
    expect(textured.geometry.getAttribute('position').getX(4)).toBeCloseTo(6);
  });

  it('keeps the UVs of a textured GLB', async () => {
    const glb = texturedGlb();
    // no DOM here: the image does not decode (the loader logs it), the geometry loads as is
    vi.stubGlobal('self', globalThis);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      if ((o as Partial<Mesh>).isMesh === true) meshes.push(o as Mesh);
    });
    expect(meshes).toHaveLength(2);
    const merged = mergeByMaterial(root, root);
    expect(merged).toHaveLength(1);
    const geo = merged[0]?.geometry;
    if (!geo) throw new Error('no merge');
    const uv = geo.getAttribute('uv');
    expect(uv.count).toBe(6);
    expect([uv.getX(2), uv.getY(2)]).toEqual([0.25, 0.75]);
    expect([uv.getX(5), uv.getY(5)]).toEqual([0.25, 0.75]);
  });
});

/** A GLB with one textured triangle drawn by two nodes (one material, POSITION, NORMAL, UV). */
function texturedGlb(): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nor = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0.25, 0.75]);
  const bin = new Uint8Array(pos.byteLength + nor.byteLength + uv.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pos.byteLength);
  bin.set(new Uint8Array(uv.buffer), pos.byteLength + nor.byteLength);
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0] }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: png }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength },
      { buffer: 0, byteOffset: pos.byteLength + nor.byteLength, byteLength: uv.byteLength },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
    ],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.byteLength).set(jsonBytes);
  const b = 20 + jsonBytes.byteLength;
  dv.setUint32(b, bin.byteLength, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  new Uint8Array(out, b + 8, bin.byteLength).set(bin);
  return out;
}
