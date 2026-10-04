import { encodeGlb, type GlbMaterial, type GlbPrimitive } from '../import/glb';

/**
 * Wavefront OBJ (+ MTL) to GLB, so imported OBJ models load like any other mesh layer: polygons
 * are fan-triangulated, one primitive per material, diffuse colour and `map_Kd` texture (PNG or
 * JPEG next to the OBJ) kept, flat normals made when the file has none. Coordinates as given
 * (the alignment tool places the model).
 */
export interface ObjResult {
  glb: Uint8Array;
  triangles: number;
  warnings: string[];
}

interface Mtl {
  color?: [number, number, number];
  map?: string;
}

function parseMtl(text: string): Map<string, Mtl> {
  const out = new Map<string, Mtl>();
  let cur: Mtl | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('newmtl ')) {
      cur = {};
      out.set(t.slice(7).trim(), cur);
    } else if (cur && t.startsWith('Kd ')) {
      const [r = 1, g = 1, b = 1] = t.slice(3).trim().split(/\s+/).map(Number);
      cur.color = [r, g, b];
    } else if (cur && t.startsWith('map_Kd ')) {
      // options like -s 1 1 1 come before the file name
      const parts = t.slice(7).trim().split(/\s+/);
      const file = parts.at(-1);
      if (file) cur.map = file;
    }
  }
  return out;
}

const imageMime = (b: Uint8Array): 'image/png' | 'image/jpeg' | null =>
  b[0] === 0x89 && b[1] === 0x50
    ? 'image/png'
    : b[0] === 0xff && b[1] === 0xd8
      ? 'image/jpeg'
      : null;

/**
 * Convert OBJ text to GLB. `loadFile(name)` returns the bytes of a texture next to the OBJ, or
 * null when it is missing.
 */
export function objToGlb(
  objText: string,
  mtlText: string | null,
  loadFile: (name: string) => Uint8Array | null,
): ObjResult {
  const warnings: string[] = [];
  const v: number[] = [];
  const vt: number[] = [];
  const vn: number[] = [];
  interface Group {
    material: string;
    faces: string[][];
  }
  const groups = new Map<string, Group>();
  let current = '';
  const group = (name: string) => {
    let g = groups.get(name);
    if (!g) {
      g = { material: name, faces: [] };
      groups.set(name, g);
    }
    return g;
  };
  for (const line of objText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sp = t.indexOf(' ');
    const key = sp < 0 ? t : t.slice(0, sp);
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    if (key === 'v') {
      const [x = 0, y = 0, z = 0] = rest.split(/\s+/).map(Number);
      v.push(x, y, z);
    } else if (key === 'vt') {
      const [s = 0, tt = 0] = rest.split(/\s+/).map(Number);
      vt.push(s, 1 - tt);
    } else if (key === 'vn') {
      const [x = 0, y = 0, z = 0] = rest.split(/\s+/).map(Number);
      vn.push(x, y, z);
    } else if (key === 'usemtl') current = rest;
    else if (key === 'f') group(current).faces.push(rest.split(/\s+/));
  }
  const nv = v.length / 3;
  const nt = vt.length / 2;
  const nn = vn.length / 3;
  const idx = (s: string | undefined, n: number): number | null => {
    if (!s) return null;
    const i = Number(s);
    if (!Number.isInteger(i) || i === 0) return null;
    return i > 0 ? i - 1 : n + i;
  };
  const mtl = mtlText ? parseMtl(mtlText) : new Map<string, Mtl>();
  const images: { mimeType: 'image/jpeg' | 'image/png'; data: Uint8Array }[] = [];
  const imageIndex = new Map<string, number>();
  const materials: GlbMaterial[] = [];
  const primitives: GlbPrimitive[] = [];
  const hasUv = nt > 0;
  let triangles = 0;
  for (const g of groups.values()) {
    if (!g.faces.length) continue;
    const m = mtl.get(g.material);
    const mat: GlbMaterial = { name: g.material || 'default', doubleSided: true };
    if (m?.color) mat.color = [...m.color, 1];
    if (m?.map) {
      let ti = imageIndex.get(m.map);
      if (ti === undefined) {
        const bytes = loadFile(m.map);
        const mime = bytes ? imageMime(bytes) : null;
        if (bytes && mime) {
          ti = images.length;
          images.push({ mimeType: mime, data: bytes });
          imageIndex.set(m.map, ti);
          mat.color = [1, 1, 1, 1];
        } else
          warnings.push(
            bytes
              ? `Texture ${m.map} is not PNG or JPEG; the model keeps its plain colour.`
              : `Texture ${m.map} was not found next to the OBJ; the model keeps its plain colour.`,
          );
      }
      if (ti !== undefined) mat.texture = ti;
    }
    const matIndex = materials.length;
    materials.push(mat);
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const seen = new Map<string, number>();
    const vertex = (
      vi: number,
      ti: number | null,
      normal: [number, number, number],
      key: string,
    ) => {
      let k = seen.get(key);
      if (k === undefined) {
        k = pos.length / 3;
        seen.set(key, k);
        pos.push(v[vi * 3] ?? 0, v[vi * 3 + 1] ?? 0, v[vi * 3 + 2] ?? 0);
        nor.push(...normal);
        if (hasUv)
          uv.push(ti === null ? 0 : (vt[ti * 2] ?? 0), ti === null ? 0 : (vt[ti * 2 + 1] ?? 0));
      }
      return k;
    };
    for (const face of g.faces) {
      const corners = face.map((c) => {
        const [a, b, n] = c.split('/');
        return { v: idx(a, nv), t: idx(b, nt), n: idx(n, nn) };
      });
      if (corners.length < 3 || corners.some((c) => c.v === null || c.v >= nv)) continue;
      for (let i = 1; i + 1 < corners.length; i++) {
        const tri = [corners[0], corners[i], corners[i + 1]];
        const p = tri.map((c) => {
          const k = (c?.v ?? 0) * 3;
          return [v[k] ?? 0, v[k + 1] ?? 0, v[k + 2] ?? 0];
        });
        const [a = [0, 0, 0], b = [0, 0, 0], c3 = [0, 0, 0]] = p;
        const e1 = [
          (b[0] ?? 0) - (a[0] ?? 0),
          (b[1] ?? 0) - (a[1] ?? 0),
          (b[2] ?? 0) - (a[2] ?? 0),
        ];
        const e2 = [
          (c3[0] ?? 0) - (a[0] ?? 0),
          (c3[1] ?? 0) - (a[1] ?? 0),
          (c3[2] ?? 0) - (a[2] ?? 0),
        ];
        const fn: [number, number, number] = [
          (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
          (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
          (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
        ];
        const L = Math.hypot(...fn) || 1;
        const flat: [number, number, number] = [fn[0] / L, fn[1] / L, fn[2] / L];
        for (const c of tri) {
          if (c?.v == null) continue;
          const own = c.n !== null && c.n < nn;
          const normal: [number, number, number] = own
            ? [vn[(c.n ?? 0) * 3] ?? 0, vn[(c.n ?? 0) * 3 + 1] ?? 0, vn[(c.n ?? 0) * 3 + 2] ?? 0]
            : flat;
          const key = own
            ? `${String(c.v)}/${String(c.t)}/${String(c.n)}`
            : `${String(c.v)}/${String(c.t)}/f${String(triangles)}`;
          index.push(vertex(c.v, c.t !== null && c.t < nt ? c.t : null, normal, key));
        }
        triangles++;
      }
    }
    if (!index.length) continue;
    primitives.push({
      material: matIndex,
      positions: new Float32Array(pos),
      normals: new Float32Array(nor),
      ...(hasUv ? { uvs: new Float32Array(uv) } : {}),
      indices: new Uint32Array(index),
    });
  }
  if (!triangles) throw new Error('The OBJ file has no faces.');
  const glb = encodeGlb({
    generator: 'aio builder obj import',
    nodes: [{ name: 'model', mesh: 0 }],
    scene: [0],
    meshes: [{ name: 'model', primitives }],
    materials,
    images,
  });
  return { glb, triangles, warnings };
}
