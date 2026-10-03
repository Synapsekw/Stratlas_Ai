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
import { describe, expect, it } from 'vitest';
import { PICK_LAYER, layerMatrix, markNodes, mergeByMaterial, selectableNode } from './model';

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
});
