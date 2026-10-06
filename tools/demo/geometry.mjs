// Mesh building blocks for the demo asset: boxes, cylinders, cones and decals (flat patches laid
// on a surface, used for the rust, cracks and coating damage the demo issues point at).

/** One named part of the model: a glTF node with one mesh, vertex colours in sRGB 0..1. */
export class Part {
  constructor(name, tag, area) {
    this.name = name;
    this.tag = tag;
    this.area = area;
    this.p = [];
    this.n = [];
    this.c = [];
    this.i = [];
  }

  v(p, n, c) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.c.push(c[0], c[1], c[2]);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c) {
    this.i.push(a, b, c);
  }

  /** Arrays for the renderer and the GLB writer. */
  arrays() {
    return {
      pos: new Float32Array(this.p),
      nrm: new Float32Array(this.n),
      col: new Float32Array(this.c),
      idx: new Uint32Array(this.i),
    };
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const vec = { sub, add, scale, cross, norm };

/** Two unit vectors perpendicular to `axis`. */
function frame(axis) {
  const a = norm(axis);
  const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(ref, a));
  const w = cross(a, u);
  return { a, u, w };
}

/** A box centred at `c` with size [sx, sy, sz], turned `rotY` radians about +Y. */
export function box(part, c, size, color, rotY = 0) {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const cs = Math.cos(rotY);
  const sn = Math.sin(rotY);
  const tr = (x, y, z) => [c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs];
  const rn = (x, y, z) => [x * cs + z * sn, y, -x * sn + z * cs];
  const faces = [
    [
      [1, 0, 0],
      [hx, -hy, hz],
      [hx, -hy, -hz],
      [hx, hy, -hz],
      [hx, hy, hz],
    ],
    [
      [-1, 0, 0],
      [-hx, -hy, -hz],
      [-hx, -hy, hz],
      [-hx, hy, hz],
      [-hx, hy, -hz],
    ],
    [
      [0, 1, 0],
      [-hx, hy, hz],
      [hx, hy, hz],
      [hx, hy, -hz],
      [-hx, hy, -hz],
    ],
    [
      [0, -1, 0],
      [-hx, -hy, -hz],
      [hx, -hy, -hz],
      [hx, -hy, hz],
      [-hx, -hy, hz],
    ],
    [
      [0, 0, 1],
      [-hx, -hy, hz],
      [hx, -hy, hz],
      [hx, hy, hz],
      [-hx, hy, hz],
    ],
    [
      [0, 0, -1],
      [hx, -hy, -hz],
      [-hx, -hy, -hz],
      [-hx, hy, -hz],
      [hx, hy, -hz],
    ],
  ];
  for (const [n, ...q] of faces) {
    const nn = rn(...n);
    const ids = q.map((v) =>
      part.v(tr(...v), nn, typeof color === 'function' ? color(tr(...v)) : color),
    );
    part.tri(ids[0], ids[1], ids[2]);
    part.tri(ids[0], ids[2], ids[3]);
  }
}

/**
 * A cylinder from `a` to `b` with radius r, smooth sides, `rows` rings along its length;
 * `color` is a colour or a function of (world point, along 0..1, angle).
 */
export function cylinder(part, a, b, r, segs, color, { caps = true, rows = 1, r1 = r } = {}) {
  const axis = sub(b, a);
  const { a: ax, u, w } = frame(axis);
  const col = (p, s, t) => (typeof color === 'function' ? color(p, s, t) : color);
  const ring = [];
  for (let j = 0; j <= rows; j++) {
    const s = j / rows;
    const rr = r + (r1 - r) * s;
    const cpt = add(a, scale(axis, s));
    const row = [];
    for (let k = 0; k <= segs; k++) {
      const t = (k / segs) * Math.PI * 2;
      const dir = add(scale(u, Math.cos(t)), scale(w, Math.sin(t)));
      const p = add(cpt, scale(dir, rr));
      const slope = (r - r1) / Math.hypot(...axis);
      row.push(part.v(p, norm(add(dir, scale(ax, slope))), col(p, s, t)));
    }
    ring.push(row);
  }
  for (let j = 0; j < rows; j++)
    for (let k = 0; k < segs; k++) {
      const p00 = ring[j][k],
        p01 = ring[j][k + 1],
        p10 = ring[j + 1][k],
        p11 = ring[j + 1][k + 1];
      part.tri(p00, p10, p11);
      part.tri(p00, p11, p01);
    }
  if (caps) {
    for (const [end, s, rr, dirn] of [
      [a, 0, r, scale(ax, -1)],
      [b, 1, r1, ax],
    ]) {
      const ci = part.v(end, dirn, col(end, s, 0));
      const ids = [];
      for (let k = 0; k <= segs; k++) {
        const t = (k / segs) * Math.PI * 2;
        const p = add(end, add(scale(u, Math.cos(t) * rr), scale(w, Math.sin(t) * rr)));
        ids.push(part.v(p, dirn, col(p, s, t)));
      }
      for (let k = 0; k < segs; k++) part.tri(ci, ids[k], ids[k + 1]);
    }
  }
}

/** A cone roof: base circle at `base` (radius r), apex `rise` above. */
export function cone(part, base, r, rise, segs, color) {
  const apex = [base[0], base[1] + rise, base[2]];
  const slope = rise / r;
  const rows = 4;
  const rings = [];
  for (let j = 0; j <= rows; j++) {
    const s = j / rows;
    const rr = r * (1 - s);
    const row = [];
    for (let k = 0; k <= segs; k++) {
      const t = (k / segs) * Math.PI * 2;
      const p = [base[0] + Math.cos(t) * rr, base[1] + rise * s, base[2] + Math.sin(t) * rr];
      const n = norm([Math.cos(t) * slope, 1, Math.sin(t) * slope]);
      row.push(part.v(j === rows ? apex : p, n, typeof color === 'function' ? color(p) : color));
    }
    rings.push(row);
  }
  for (let j = 0; j < rows; j++)
    for (let k = 0; k < segs; k++) {
      part.tri(rings[j][k], rings[j + 1][k + 1], rings[j + 1][k]);
      part.tri(rings[j][k], rings[j][k + 1], rings[j + 1][k + 1]);
    }
}

/**
 * A flat patch with an irregular outline, laid on a surface: `at(u, v)` maps patch coordinates
 * (metres) to a world point and `normalAt(u, v)` to the surface normal; the patch is lifted
 * `lift` metres off the surface. `outline` is a list of radii (one per angle step).
 */
export function decal(part, at, normalAt, outline, color, lift = 0.012) {
  const rings = 5;
  const n = outline.length;
  const pt = (u, v) => add(at(u, v), scale(normalAt(u, v), lift));
  const c = part.v(pt(0, 0), normalAt(0, 0), typeof color === 'function' ? color(0, 0) : color);
  const ids = [];
  for (let r = 1; r <= rings; r++) {
    const row = [];
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2;
      const rad = (outline[k] * r) / rings;
      const u = Math.cos(t) * rad;
      const v = Math.sin(t) * rad;
      row.push(part.v(pt(u, v), normalAt(u, v), typeof color === 'function' ? color(u, v) : color));
    }
    ids.push(row);
  }
  for (let k = 0; k < n; k++) part.tri(c, ids[0][k], ids[0][(k + 1) % n]);
  for (let r = 0; r + 1 < rings; r++)
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      part.tri(ids[r][k], ids[r + 1][k], ids[r + 1][k1]);
      part.tri(ids[r][k], ids[r + 1][k1], ids[r][k1]);
    }
}

/** A thin strip along a polyline of patch points [[u, v], ...] (cracks, rust streaks). */
export function strip(part, at, normalAt, pts, width, color, lift = 0.014) {
  const ids = [];
  for (let k = 0; k < pts.length; k++) {
    const [u, v] = pts[k];
    const [u0, v0] = pts[Math.max(0, k - 1)];
    const [u1, v1] = pts[Math.min(pts.length - 1, k + 1)];
    let du = u1 - u0;
    let dv = v1 - v0;
    const l = Math.hypot(du, dv) || 1;
    du /= l;
    dv /= l;
    const w = typeof width === 'function' ? width(k / (pts.length - 1)) : width;
    const side = [-dv * w * 0.5, du * w * 0.5];
    const a = [u + side[0], v + side[1]];
    const b = [u - side[0], v - side[1]];
    ids.push([
      part.v(add(at(...a), scale(normalAt(...a), lift)), normalAt(...a), color),
      part.v(add(at(...b), scale(normalAt(...b), lift)), normalAt(...b), color),
    ]);
  }
  for (let k = 0; k + 1 < ids.length; k++) {
    part.tri(ids[k][0], ids[k + 1][0], ids[k + 1][1]);
    part.tri(ids[k][0], ids[k + 1][1], ids[k][1]);
  }
}

/** Patch mapping on the outside of a vertical cylinder (tank shell): u along the arc, v up. */
export function onShell(cx, cz, R, theta0, y0) {
  return {
    at: (u, v) => {
      const t = theta0 + u / R;
      return [cx + Math.cos(t) * R, y0 + v, cz + Math.sin(t) * R];
    },
    normalAt: (u) => {
      const t = theta0 + u / R;
      return [Math.cos(t), 0, Math.sin(t)];
    },
    centre: [cx + Math.cos(theta0) * R, y0, cz + Math.sin(theta0) * R],
    normal: [Math.cos(theta0), 0, Math.sin(theta0)],
  };
}

/** Patch mapping on the outside of a cylinder along an axis (a pipe): u along, v around. */
export function onPipe(a, b, r, s0, angle0) {
  const axis = sub(b, a);
  const { a: ax, u, w } = frame(axis);
  const len = Math.hypot(...axis);
  const dirAt = (t) => add(scale(u, Math.cos(t)), scale(w, Math.sin(t)));
  return {
    at: (uu, vv) => {
      const t = angle0 + vv / r;
      return add(add(a, scale(ax, s0 * len + uu)), scale(dirAt(t), r));
    },
    normalAt: (_uu, vv) => dirAt(angle0 + vv / r),
    centre: add(add(a, scale(ax, s0 * len)), scale(dirAt(angle0), r)),
    normal: dirAt(angle0),
  };
}

/** Patch mapping on a plane: origin, unit u and v axes. */
export function onPlane(origin, uAxis, vAxis) {
  const n = norm(cross(uAxis, vAxis));
  return {
    at: (u, v) => add(origin, add(scale(uAxis, u), scale(vAxis, v))),
    normalAt: () => n,
    centre: origin,
    normal: n,
  };
}
