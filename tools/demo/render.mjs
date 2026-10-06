// A small deterministic software rasteriser for the demo project (no GPU, no WebGL): z-buffer,
// perspective-correct attributes, Lambert sun with a shadow map, textured ground, distance haze.
// It renders the drone video frames, the issue photos, the thumbnail and the top-down ortho and
// DSM of the synthetic site, so every image in the demo shows exactly the geometry in its GLB.
//
// Frame conventions follow docs/architecture/data-conventions.md: local metres, Y up, X east,
// Z south; a camera looks along its local -Z with +Y up in the image (three.js).

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** An RGB float texture (0..1, sRGB) with a box-filtered mip chain, sampled bilinearly. */
export class Texture {
  /**
   * @param {number} w
   * @param {number} h
   * @param {Float32Array} rgb  w * h * 3
   * @param {{ x0: number, z0: number, x1: number, z1: number, wrap?: boolean }} place  world bounds
   */
  constructor(w, h, rgb, place) {
    this.place = place;
    this.levels = [{ w, h, rgb }];
    let cur = this.levels[0];
    while (cur.w > 1 && cur.h > 1) {
      const nw = cur.w >> 1;
      const nh = cur.h >> 1;
      const out = new Float32Array(nw * nh * 3);
      for (let y = 0; y < nh; y++)
        for (let x = 0; x < nw; x++) {
          const o = (y * nw + x) * 3;
          const a = (2 * y * cur.w + 2 * x) * 3;
          const b = a + cur.w * 3;
          for (let k = 0; k < 3; k++)
            out[o + k] =
              0.25 * (cur.rgb[a + k] + cur.rgb[a + 3 + k] + cur.rgb[b + k] + cur.rgb[b + 3 + k]);
        }
      cur = { w: nw, h: nh, rgb: out };
      this.levels.push(cur);
    }
    this.texel = (place.x1 - place.x0) / w;
  }

  /** Colour at world (x, z) for a pixel footprint of `foot` metres, into out[0..2]. */
  sample(x, z, foot, out) {
    const p = this.place;
    let u = (x - p.x0) / (p.x1 - p.x0);
    let v = (z - p.z0) / (p.z1 - p.z0);
    if (p.wrap) {
      u -= Math.floor(u);
      v -= Math.floor(v);
    }
    let li = foot > this.texel ? Math.floor(Math.log2(foot / this.texel)) : 0;
    if (li >= this.levels.length) li = this.levels.length - 1;
    const L = this.levels[li];
    let fx = u * L.w - 0.5;
    let fy = v * L.h - 0.5;
    let x0 = Math.floor(fx);
    let y0 = Math.floor(fy);
    fx -= x0;
    fy -= y0;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    if (p.wrap) {
      x0 = ((x0 % L.w) + L.w) % L.w;
      x1 = ((x1 % L.w) + L.w) % L.w;
      y0 = ((y0 % L.h) + L.h) % L.h;
      y1 = ((y1 % L.h) + L.h) % L.h;
    } else {
      x0 = x0 < 0 ? 0 : x0 >= L.w ? L.w - 1 : x0;
      x1 = x1 < 0 ? 0 : x1 >= L.w ? L.w - 1 : x1;
      y0 = y0 < 0 ? 0 : y0 >= L.h ? L.h - 1 : y0;
      y1 = y1 < 0 ? 0 : y1 >= L.h ? L.h - 1 : y1;
    }
    const a = (y0 * L.w + x0) * 3;
    const b = (y0 * L.w + x1) * 3;
    const c = (y1 * L.w + x0) * 3;
    const d = (y1 * L.w + x1) * 3;
    const r = L.rgb;
    for (let k = 0; k < 3; k++) {
      const top = r[a + k] + (r[b + k] - r[a + k]) * fx;
      const bot = r[c + k] + (r[d + k] - r[c + k]) * fx;
      out[k] = top + (bot - top) * fy;
    }
  }

  contains(x, z) {
    const p = this.place;
    return p.wrap || (x >= p.x0 && x < p.x1 && z >= p.z0 && z < p.z1);
  }
}

/**
 * A draw item: world positions, normals and sRGB colours per vertex, triangle indices. `ground`
 * items take their colour from the ground textures instead of the vertex colours.
 * @typedef {{ pos: Float32Array, nrm: Float32Array, col: Float32Array, idx: Uint32Array, ground?: boolean }} Item
 */

/** Rotate a vector by a unit quaternion [x, y, z, w]. */
export function rotate(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** The camera quaternion (three.js: looks along local -Z, +Y up) looking from eye to target. */
export function lookAtQuat(eye, target, up = [0, 1, 0]) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz);
  zx /= l;
  zy /= l;
  zz /= l;
  // looking straight down or up: image up is north
  if (Math.abs(zx * up[0] + zy * up[1] + zz * up[2]) > 0.999) up = [0, 0, -1];
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  xx /= l;
  xy /= l;
  xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  // rotation matrix columns: X, Y, Z -> quaternion
  const m00 = xx,
    m01 = yx,
    m02 = zx,
    m10 = xy,
    m11 = yy,
    m12 = zy,
    m20 = xz,
    m21 = yz,
    m22 = zz;
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const n = Math.hypot(qx, qy, qz, qw);
  return [qx / n, qy / n, qz / n, qw / n];
}

/**
 * A camera. Perspective: `{ pos, q, hfovDeg, width, height }` (pinhole). Orthographic top-down:
 * `{ ortho: { x0, z0, x1, z1 }, width, height }` looking straight down (+X right, -Z up in the
 * image, so north is up).
 * @typedef {{ pos?: number[], q?: number[], hfovDeg?: number, ortho?: { x0: number, z0: number, x1: number, z1: number }, width: number, height: number }} Camera
 */

/** Camera-space basis: rows are the camera X, Y, Z axes in world coordinates, and the eye. */
function basis(cam) {
  if (cam.ortho) {
    // looking down: camera X = world +X, camera Y = world -Z (north up), camera Z = world +Y
    return { r: [1, 0, 0], u: [0, 0, -1], b: [0, 1, 0], eye: [0, 10000, 0] };
  }
  return {
    r: rotate(cam.q, [1, 0, 0]),
    u: rotate(cam.q, [0, 1, 0]),
    b: rotate(cam.q, [0, 0, 1]),
    eye: cam.pos,
  };
}

/** Project a world point; returns [sx, sy, depth] or null behind the camera. */
export function projectPoint(cam, p) {
  const B = basis(cam);
  const dx = p[0] - B.eye[0];
  const dy = p[1] - B.eye[1];
  const dz = p[2] - B.eye[2];
  const xc = dx * B.r[0] + dy * B.r[1] + dz * B.r[2];
  const yc = dx * B.u[0] + dy * B.u[1] + dz * B.u[2];
  const zc = dx * B.b[0] + dy * B.b[1] + dz * B.b[2];
  if (cam.ortho) {
    const o = cam.ortho;
    return [
      ((xc - o.x0) / (o.x1 - o.x0)) * cam.width,
      ((-yc - o.z0) / (o.z1 - o.z0)) * cam.height,
      -zc,
    ];
  }
  if (zc > -0.01) return null;
  const f = cam.width / 2 / Math.tan((cam.hfovDeg * Math.PI) / 360);
  return [cam.width / 2 + (f * xc) / -zc, cam.height / 2 - (f * yc) / -zc, -zc];
}

const NEAR = 0.3;

export class Renderer {
  /**
   * @param {Item[]} items
   * @param {{ ground: (x: number, z: number, foot: number, out: Float32Array) => void, sun: number[], shadow?: { x0: number, z0: number, x1: number, z1: number, size: number } }} env
   */
  constructor(items, env) {
    this.items = items;
    this.env = env;
    const s = env.sun; // direction towards the sun
    const l = Math.hypot(s[0], s[1], s[2]);
    this.sun = [s[0] / l, s[1] / l, s[2] / l];
    this.shadow = env.shadow ? this.buildShadow(env.shadow) : null;
  }

  /** Depth map seen from the sun (orthographic), for shadow tests. */
  buildShadow(box) {
    const L = this.sun;
    // light basis: forward = -L, right = normalize(up x forward)
    const fwd = [-L[0], -L[1], -L[2]];
    let rx = fwd[2],
      rz = -fwd[0];
    const rl = Math.hypot(rx, rz);
    rx /= rl;
    rz /= rl;
    const right = [rx, 0, rz];
    const upv = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    // extent of the box corners in light space
    let a0 = Infinity,
      a1 = -Infinity,
      b0 = Infinity,
      b1 = -Infinity;
    for (const x of [box.x0, box.x1])
      for (const z of [box.z0, box.z1])
        for (const y of [-2, 40]) {
          const a = x * right[0] + y * right[1] + z * right[2];
          const b = x * upv[0] + y * upv[1] + z * upv[2];
          a0 = Math.min(a0, a);
          a1 = Math.max(a1, a);
          b0 = Math.min(b0, b);
          b1 = Math.max(b1, b);
        }
    const size = box.size;
    const depth = new Float32Array(size * size).fill(Infinity);
    const sh = { right, upv, fwd, a0, a1, b0, b1, size, depth };
    for (const it of this.items) {
      if (it.noShadow) continue;
      const n = it.pos.length / 3;
      const sx = new Float32Array(n);
      const sy = new Float32Array(n);
      const sd = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = it.pos[3 * i],
          y = it.pos[3 * i + 1],
          z = it.pos[3 * i + 2];
        sx[i] = ((x * right[0] + y * right[1] + z * right[2] - a0) / (a1 - a0)) * size;
        sy[i] = ((b1 - (x * upv[0] + y * upv[1] + z * upv[2])) / (b1 - b0)) * size;
        sd[i] = x * fwd[0] + y * fwd[1] + z * fwd[2];
      }
      const idx = it.idx;
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t],
          i1 = idx[t + 1],
          i2 = idx[t + 2];
        rasterDepth(
          depth,
          size,
          size,
          sx[i0],
          sy[i0],
          sd[i0],
          sx[i1],
          sy[i1],
          sd[i1],
          sx[i2],
          sy[i2],
          sd[i2],
        );
      }
    }
    return sh;
  }

  /** 1 when the world point sees the sun, 0 in shadow (2 x 2 percentage-closer filter). */
  lit(x, y, z) {
    const sh = this.shadow;
    if (!sh) return 1;
    const { right, upv, fwd, a0, a1, b0, b1, size, depth } = sh;
    const fx = ((x * right[0] + y * right[1] + z * right[2] - a0) / (a1 - a0)) * size - 0.5;
    const fy = ((b1 - (x * upv[0] + y * upv[1] + z * upv[2])) / (b1 - b0)) * size - 0.5;
    const d = x * fwd[0] + y * fwd[1] + z * fwd[2] - 0.08;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= size - 1 || iy >= size - 1) return 1;
    const tx = fx - ix;
    const ty = fy - iy;
    const o = iy * size + ix;
    const s00 = depth[o] < d ? 0 : 1;
    const s10 = depth[o + 1] < d ? 0 : 1;
    const s01 = depth[o + size] < d ? 0 : 1;
    const s11 = depth[o + size + 1] < d ? 0 : 1;
    return (s00 * (1 - tx) + s10 * tx) * (1 - ty) + (s01 * (1 - tx) + s11 * tx) * ty;
  }

  /**
   * Render a camera into 8-bit RGB (width * height * 3). `ss` supersamples (2 = 4 samples per
   * pixel). `heights` (optional) receives the world height of each pixel (orthographic DSM).
   */
  render(cam, { ss = 1, heights = null, haze = true } = {}) {
    const W = cam.width * ss;
    const H = cam.height * ss;
    const NPX = W * H;
    // G-buffer: depth, world position, normal, colour, ground flag; shaded once per pixel after
    const zbuf = new Float32Array(NPX).fill(Infinity);
    const gpos = new Float32Array(NPX * 3);
    const gnrm = new Float32Array(NPX * 3);
    const gcol = new Float32Array(NPX * 3);
    const gflag = new Uint8Array(NPX);
    const color = new Float32Array(NPX * 3);
    const B = basis(cam);
    const ortho = cam.ortho;
    const f = ortho ? 0 : W / 2 / Math.tan((cam.hfovDeg * Math.PI) / 360);
    const oxs = ortho ? W / (ortho.x1 - ortho.x0) : 0;
    const ozs = ortho ? H / (ortho.z1 - ortho.z0) : 0;
    // one triangle's vertices: sx, sy, w, d, then 9 attributes
    const V = new Float64Array(3 * 13);

    const rasterTri = (ground) => {
      const x0 = V[0],
        y0 = V[1],
        x1 = V[13],
        y1 = V[14],
        x2 = V[26],
        y2 = V[27];
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) return;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) return;
      const ia = 1 / area;
      const w0v = V[2],
        w1v = V[15],
        w2v = V[28];
      const d0 = V[3],
        d1 = V[16],
        d2 = V[29];
      // edge function gradients
      const e0dx = -(y2 - y1) * ia,
        e0dy = (x2 - x1) * ia;
      const e1dx = -(y0 - y2) * ia,
        e1dy = (x0 - x2) * ia;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        const px0 = minX + 0.5;
        let w0 = ((x1 - px0) * (y2 - py) - (x2 - px0) * (y1 - py)) * ia;
        let w1 = ((x2 - px0) * (y0 - py) - (x0 - px0) * (y2 - py)) * ia;
        for (let x = minX; x <= maxX; x++, w0 += e0dx, w1 += e1dx) {
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
          let p0, p1, p2, depth;
          if (ortho) {
            p0 = w0;
            p1 = w1;
            p2 = w2;
            depth = w0 * d0 + w1 * d1 + w2 * d2;
          } else {
            p0 = w0 * w0v;
            p1 = w1 * w1v;
            p2 = w2 * w2v;
            const ps = 1 / (p0 + p1 + p2);
            p0 *= ps;
            p1 *= ps;
            p2 *= ps;
            depth = p0 * d0 + p1 * d1 + p2 * d2;
          }
          const o = y * W + x;
          if (depth >= zbuf[o]) continue;
          zbuf[o] = depth;
          const o3 = o * 3;
          gpos[o3] = p0 * V[4] + p1 * V[17] + p2 * V[30];
          gpos[o3 + 1] = p0 * V[5] + p1 * V[18] + p2 * V[31];
          gpos[o3 + 2] = p0 * V[6] + p1 * V[19] + p2 * V[32];
          gnrm[o3] = p0 * V[7] + p1 * V[20] + p2 * V[33];
          gnrm[o3 + 1] = p0 * V[8] + p1 * V[21] + p2 * V[34];
          gnrm[o3 + 2] = p0 * V[9] + p1 * V[22] + p2 * V[35];
          if (!ground) {
            gcol[o3] = p0 * V[10] + p1 * V[23] + p2 * V[36];
            gcol[o3 + 1] = p0 * V[11] + p1 * V[24] + p2 * V[37];
            gcol[o3 + 2] = p0 * V[12] + p1 * V[25] + p2 * V[38];
          }
          gflag[o] = ground ? 2 : 1;
        }
        void e0dy;
        void e1dy;
      }
    };

    const toScreen = (k, cxv, cyv, czv) => {
      const b = k * 13;
      if (ortho) {
        V[b] = (cxv - ortho.x0) * oxs;
        V[b + 1] = (-cyv - ortho.z0) * ozs;
        V[b + 2] = 1;
      } else {
        const iz = 1 / -czv;
        V[b] = W / 2 + f * cxv * iz;
        V[b + 1] = H / 2 - f * cyv * iz;
        V[b + 2] = iz;
      }
      V[b + 3] = -czv;
    };

    for (const it of this.items) {
      if (ortho && it.noOrtho) continue;
      const n = it.pos.length / 3;
      const P = it.pos,
        N = it.nrm,
        C = it.col;
      const cx = new Float32Array(n);
      const cy = new Float32Array(n);
      const cz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const dx = P[3 * i] - B.eye[0];
        const dy = P[3 * i + 1] - B.eye[1];
        const dz = P[3 * i + 2] - B.eye[2];
        cx[i] = dx * B.r[0] + dy * B.r[1] + dz * B.r[2];
        cy[i] = dx * B.u[0] + dy * B.u[1] + dz * B.u[2];
        cz[i] = dx * B.b[0] + dy * B.b[1] + dz * B.b[2];
      }
      const idx = it.idx;
      const ground = !!it.ground;
      const setAttr = (k, i) => {
        const b = k * 13 + 4;
        V[b] = P[3 * i];
        V[b + 1] = P[3 * i + 1];
        V[b + 2] = P[3 * i + 2];
        V[b + 3] = N[3 * i];
        V[b + 4] = N[3 * i + 1];
        V[b + 5] = N[3 * i + 2];
        V[b + 6] = C[3 * i];
        V[b + 7] = C[3 * i + 1];
        V[b + 8] = C[3 * i + 2];
      };
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t],
          i1 = idx[t + 1],
          i2 = idx[t + 2];
        const inFront = ortho || (cz[i0] <= -NEAR && cz[i1] <= -NEAR && cz[i2] <= -NEAR);
        if (inFront) {
          toScreen(0, cx[i0], cy[i0], cz[i0]);
          toScreen(1, cx[i1], cy[i1], cz[i1]);
          toScreen(2, cx[i2], cy[i2], cz[i2]);
          setAttr(0, i0);
          setAttr(1, i1);
          setAttr(2, i2);
          rasterTri(ground);
          continue;
        }
        if (cz[i0] > -NEAR && cz[i1] > -NEAR && cz[i2] > -NEAR) continue;
        const poly = clipNear(
          [i0, i1, i2].map((i) => ({
            x: cx[i],
            y: cy[i],
            z: cz[i],
            a: [
              P[3 * i],
              P[3 * i + 1],
              P[3 * i + 2],
              N[3 * i],
              N[3 * i + 1],
              N[3 * i + 2],
              C[3 * i],
              C[3 * i + 1],
              C[3 * i + 2],
            ],
          })),
        );
        for (let k = 1; k + 1 < poly.length; k++) {
          [poly[0], poly[k], poly[k + 1]].forEach((v, j) => {
            toScreen(j, v.x, v.y, v.z);
            for (let a = 0; a < 9; a++) V[j * 13 + 4 + a] = v.a[a];
          });
          rasterTri(ground);
        }
      }
    }

    // shading pass
    const env = this.env;
    const sun = this.sun;
    const tmp = new Float32Array(3);
    const pxAngle = ortho ? 0 : 1 / f;
    const orthoFoot = ortho ? (ortho.x1 - ortho.x0) / W : 0;
    for (let o = 0; o < NPX; o++) {
      const o3 = o * 3;
      const flag = gflag[o];
      if (!flag) {
        const t = clamp01(1 - Math.floor(o / W) / H);
        color[o3] = 0.72 - 0.25 * t;
        color[o3 + 1] = 0.8 - 0.18 * t;
        color[o3 + 2] = 0.9 - 0.05 * t;
        continue;
      }
      const wx = gpos[o3],
        wy = gpos[o3 + 1],
        wz = gpos[o3 + 2];
      let nx = gnrm[o3],
        ny = gnrm[o3 + 1],
        nz = gnrm[o3 + 2];
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const depth = zbuf[o];
      let cr, cg, cb;
      if (flag === 2) {
        env.ground(wx, wz, ortho ? orthoFoot : depth * pxAngle, tmp);
        cr = tmp[0];
        cg = tmp[1];
        cb = tmp[2];
      } else {
        cr = gcol[o3];
        cg = gcol[o3 + 1];
        cb = gcol[o3 + 2];
      }
      let ndl = nx * sun[0] + ny * sun[1] + nz * sun[2];
      if (ndl < 0) ndl = 0;
      const shadow = ndl > 0 ? this.lit(wx + nx * 0.3, wy + ny * 0.3, wz + nz * 0.3) : 0;
      const skyL = 0.5 + 0.5 * ny; // hemisphere light
      const lr = 0.3 * skyL + 0.12 + 0.78 * ndl * shadow;
      let r = cr * lr * 1.02,
        g = cg * lr,
        b = cb * lr * 1.03 + 0.012 * skyL;
      if (haze && !ortho) {
        const t = 1 - Math.exp(-depth / 900);
        r += (0.82 - r) * t;
        g += (0.8 - g) * t;
        b += (0.78 - b) * t;
      }
      color[o3] = r;
      color[o3 + 1] = g;
      color[o3 + 2] = b;
    }
    const hbuf = heights ? gpos : null;

    // downsample and encode (simple filmic shoulder)
    const out = new Uint8Array(cam.width * cam.height * 3);
    const inv = 1 / (ss * ss);
    for (let y = 0; y < cam.height; y++)
      for (let x = 0; x < cam.width; x++) {
        let r = 0,
          g = 0,
          b = 0;
        for (let j = 0; j < ss; j++)
          for (let i = 0; i < ss; i++) {
            const o = ((y * ss + j) * W + x * ss + i) * 3;
            r += color[o];
            g += color[o + 1];
            b += color[o + 2];
          }
        const q = (y * cam.width + x) * 3;
        out[q] = tone(r * inv);
        out[q + 1] = tone(g * inv);
        out[q + 2] = tone(b * inv);
      }
    let h = null;
    if (hbuf) {
      h = new Float32Array(cam.width * cam.height);
      for (let y = 0; y < cam.height; y++)
        for (let x = 0; x < cam.width; x++) {
          let m = -Infinity;
          for (let j = 0; j < ss; j++)
            for (let i = 0; i < ss; i++) {
              const q = (y * ss + j) * W + x * ss + i;
              const v = gflag[q] ? hbuf[q * 3 + 1] : -Infinity;
              if (v > m) m = v;
            }
          h[y * cam.width + x] = m === -Infinity ? NaN : m;
        }
    }
    return { rgb: out, heights: h };
  }
}

function tone(v) {
  const s = v < 0.85 ? v : 0.85 + (1 - Math.exp(-(v - 0.85) * 4)) * 0.15;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** Clip a polygon (camera space) to z <= -NEAR. */
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ain = a.z <= -NEAR;
    const bin = b.z <= -NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (-NEAR - a.z) / (b.z - a.z);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: -NEAR,
        a: a.a.map((v, k) => v + (b.a[k] - v) * t),
      });
    }
  }
  return out;
}

function rasterDepth(buf, W, H, x0, y0, d0, x1, y1, d1, x2, y2, d2) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) return;
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return;
  const ia = 1 / area;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * ia;
      const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * ia;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const d = w0 * d0 + w1 * d1 + w2 * d2;
      const o = y * W + x;
      if (d < buf[o]) buf[o] = d;
    }
  }
}
