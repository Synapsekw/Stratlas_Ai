import { BoxGeometry } from 'three';

/**
 * Test fixture: a GLB laid out like the engineering model writer (`@aio/modelling`
 * `buildEngineeringGlb`), which the engine may not depend on. One node per component, flat under
 * a model root, each with its own mesh of one primitive per material, materials shared across
 * components, and the component record in the node extras.
 */
export interface FixturePrim {
  material: number;
  /** Box size and centre, in the node frame. */
  size: [number, number, number];
  at?: [number, number, number];
}
export interface FixtureNode {
  name: string;
  translation?: [number, number, number];
  extras: Record<string, unknown>;
  prims: FixturePrim[];
}

/** Bytes of a GLB with the given nodes under one root and named materials. */
export function writeComponentGlb(
  root: string,
  nodes: readonly FixtureNode[],
  materials: readonly string[],
  assetExtras?: Record<string, unknown>,
): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const add = (data: Float32Array | Uint32Array, accessor: Record<string, unknown>) => {
    const bytes = new Uint8Array(data.buffer.slice(0));
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    offset += bytes.byteLength;
    return accessors.push({ bufferView: bufferViews.length - 1, ...accessor }) - 1;
  };
  const meshes = nodes.map((n) => ({
    name: n.name,
    primitives: n.prims.map((p) => {
      const g = new BoxGeometry(...p.size);
      const [x, y, z] = p.at ?? [0, 0, 0];
      g.translate(x, y, z);
      const pos = Float32Array.from(g.getAttribute('position').array);
      const nor = Float32Array.from(g.getAttribute('normal').array);
      const idx = Uint32Array.from(g.index?.array ?? []);
      g.computeBoundingBox();
      const box = g.boundingBox;
      const position = add(pos, {
        componentType: 5126,
        count: pos.length / 3,
        type: 'VEC3',
        min: box ? box.min.toArray() : [0, 0, 0],
        max: box ? box.max.toArray() : [0, 0, 0],
      });
      const normal = add(nor, { componentType: 5126, count: nor.length / 3, type: 'VEC3' });
      const indices = add(idx, { componentType: 5125, count: idx.length, type: 'SCALAR' });
      return { attributes: { POSITION: position, NORMAL: normal }, indices, material: p.material };
    }),
  }));
  const json = {
    asset: {
      version: '2.0',
      generator: 'engine test fixture',
      ...(assetExtras ? { extras: assetExtras } : {}),
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: root, children: nodes.map((_, i) => i + 1) },
      ...nodes.map((n, i) => ({
        name: n.name,
        mesh: i,
        ...(n.translation ? { translation: n.translation } : {}),
        extras: n.extras,
      })),
    ],
    meshes,
    materials: materials.map((name) => ({
      name,
      pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] },
    })),
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + offset;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.byteLength).set(jsonBytes);
  const b = 20 + jsonBytes.byteLength;
  dv.setUint32(b, offset, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  let at = b + 8;
  for (const c of chunks) {
    new Uint8Array(out, at, c.byteLength).set(c);
    at += c.byteLength;
  }
  return out;
}

const component = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  component: id,
  name,
  description: `${name} of the test chimney`,
  category: 'structure',
  kind: 'test',
  status: 'accepted',
  part: id,
  basis: 'measured',
  quality: { params: {} },
  ...extra,
});

/** Materials of `chimneyGlb`, by index. */
export const STEEL = 0;
export const LENS = 1;
export const PAINT = 2;

/**
 * A small chimney seen from +Z: `flue-2` stands in front of `flue-1` (same material), and
 * `light-l1-2` is a warning light of three primitives (housing in steel, lens, bracket in paint)
 * off to the side.
 */
export function chimneyGlb(marked = true): ArrayBuffer {
  return writeComponentGlb(
    'test-chimney',
    [
      {
        name: 'flue-1',
        translation: [0, 0, -5],
        extras: component('flue-1', 'Flue 1', {
          tag: 'F-1',
          dimensions: { height: { value: 10, unit: 'm' }, rOuter: { value: 1, unit: 'm' } },
        }),
        prims: [{ material: STEEL, size: [2, 10, 2] }],
      },
      {
        name: 'flue-2',
        translation: [0, 0, 5],
        extras: component('flue-2', 'Flue 2'),
        prims: [{ material: STEEL, size: [2, 10, 2] }],
      },
      {
        name: 'light-l1-2',
        translation: [10, 0, 0],
        extras: component('light-l1-2', 'Warning light 2', {
          category: 'lighting',
          parent: 'flue-1',
          unobserved: ['back'],
          quality: {
            params: { height: 'measured', lensDiameter: 'inferred' },
            residualM: 0.012,
            coverage: 0.6,
          },
        }),
        prims: [
          { material: STEEL, size: [1, 1, 1] },
          { material: LENS, size: [0.6, 0.6, 0.6], at: [0, 0, 0.8] },
          { material: PAINT, size: [0.2, 0.2, 1], at: [0, -0.6, -0.5] },
        ],
      },
    ],
    ['steel', 'lens', 'paint'],
    marked ? { aioEngineering: 1 } : undefined,
  );
}

/** A `/1` parts GLB: extras `{tag, type, part}` only, no component records. */
export function legacyGlb(): ArrayBuffer {
  return writeComponentGlb(
    'old-model',
    [
      {
        name: 'P-1',
        extras: { tag: 'P-1', type: 'pipe', part: 'P-1' },
        prims: [{ material: 0, size: [2, 2, 2] }],
      },
      {
        name: 'P-2',
        translation: [5, 0, 0],
        extras: { type: 'pipe', part: 'P-2' },
        prims: [{ material: 0, size: [2, 2, 2] }],
      },
    ],
    ['matte'],
  );
}
