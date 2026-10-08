/**
 * The Delaunay triangulation both executors compute the same way (`delaunay` in
 * `aio_pipelines/survey/tin.py`): a sweep-hull (after Delaunator, ISC) whose hull walks use the
 * exact sign of the orientation and whose flips use the same floating-point in-circle test, in
 * the same order. A `smart` or `custom` base is therefore the same TIN in TypeScript and Python
 * even where points are cocircular (a densified rectangle has many).
 */

const EPSILON = 2 ** -52;

const BUF = new DataView(new ArrayBuffer(8));

/** `x` as an integer mantissa and a power of two. */
function parts(x: number): [bigint, number] {
  if (x === 0) return [0n, 0];
  BUF.setFloat64(0, x);
  const hi = BUF.getUint32(0);
  const lo = BUF.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (expBits === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  return [hi >>> 31 ? -mant : mant, e];
}

function exactNegative(vals: readonly number[]): boolean {
  const ps = vals.map(parts);
  const emin = Math.min(...ps.map((p) => p[1]));
  const v = ps.map(([m, e]) => m << BigInt(e - emin));
  const [a = 0n, b = 0n, c = 0n, d = 0n, e = 0n, f = 0n] = v;
  return (d - b) * (e - c) - (c - a) * (f - d) < 0n;
}

/** True when `(qy - py) (rx - qx) - (qx - px) (ry - qy) < 0` exactly. */
export function orient(
  px: number,
  py: number,
  qx: number,
  qy: number,
  rx: number,
  ry: number,
): boolean {
  const left = (qy - py) * (rx - qx);
  const right = (qx - px) * (ry - qy);
  const det = left - right;
  const bound = 1e-15 * (Math.abs(left) + Math.abs(right));
  if (det > bound) return false;
  if (-det > bound) return true;
  if (left === 0 && right === 0) return false;
  return exactNegative([px, py, qx, qy, rx, ry]);
}

function inCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  const dx = ax - px;
  const dy = ay - py;
  const ex = bx - px;
  const ey = by - py;
  const fx = cx - px;
  const fy = cy - py;
  const ap = dx * dx + dy * dy;
  const bp = ex * ex + ey * ey;
  const cp = fx * fx + fy * fy;
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0;
}

function circumradius(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const den = dx * ey - dy * ex;
  if (den === 0) return Infinity;
  const d = 0.5 / den;
  const x = (ey * bl - dy * cl) * d;
  const y = (dx * cl - ex * bl) * d;
  return x * x + y * y;
}

function circumcenter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);
  return [ax + (ey * bl - dy * cl) * d, ay + (dx * cl - ex * bl) * d] as const;
}

function pseudoAngle(dx: number, dy: number): number {
  const s = Math.abs(dx) + Math.abs(dy);
  if (s === 0) return 0;
  const p = dx / s;
  return (dy > 0 ? 3 - p : 1 + p) / 4;
}

function quicksort(ids: Uint32Array, dists: Float64Array, left0: number, right0: number): void {
  const stack: [number, number][] = [[left0, right0]];
  const at = (k: number) => dists[ids[k] ?? 0] ?? 0;
  const swap = (i: number, j: number) => {
    const t = ids[i] ?? 0;
    ids[i] = ids[j] ?? 0;
    ids[j] = t;
  };
  while (stack.length) {
    const top = stack.pop();
    if (!top) break;
    const [left, right] = top;
    if (right - left <= 20) {
      for (let i = left + 1; i <= right; i++) {
        const temp = ids[i] ?? 0;
        const tempDist = dists[temp] ?? 0;
        let j = i - 1;
        while (j >= left && at(j) > tempDist) {
          ids[j + 1] = ids[j] ?? 0;
          j--;
        }
        ids[j + 1] = temp;
      }
      continue;
    }
    const median = (left + right) >> 1;
    let i = left + 1;
    let j = right;
    swap(median, i);
    if (at(left) > at(right)) swap(left, right);
    if (at(i) > at(right)) swap(i, right);
    if (at(left) > at(i)) swap(left, i);
    const temp = ids[i] ?? 0;
    const tempDist = dists[temp] ?? 0;
    for (;;) {
      do i++;
      while (at(i) < tempDist);
      do j--;
      while (at(j) > tempDist);
      if (j < i) break;
      swap(i, j);
    }
    ids[left + 1] = ids[j] ?? 0;
    ids[j] = temp;
    stack.push([left, j - 1]);
    stack.push([i, right]);
  }
}

/** Triangles (vertex index triples) of the Delaunay triangulation; empty when all are collinear. */
export function delaunay(x: ArrayLike<number>, y: ArrayLike<number>): Uint32Array {
  const n = x.length;
  if (n < 3) return new Uint32Array(0);
  const X = (i: number) => x[i] ?? 0;
  const Y = (i: number) => y[i] ?? 0;
  const maxTri = Math.max(2 * n - 5, 0);
  const tris = new Uint32Array(maxTri * 3);
  const halfedges = new Int32Array(maxTri * 3).fill(-1);
  const hashSize = Math.ceil(Math.sqrt(n));
  const hullPrev = new Uint32Array(n);
  const hullNext = new Uint32Array(n);
  const hullTri = new Uint32Array(n);
  const hullHash = new Int32Array(hashSize).fill(-1);
  const ids = new Uint32Array(n);
  const dists = new Float64Array(n);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = X(i);
    const py = Y(i);
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    ids[i] = i;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dist = (ax: number, ay: number, bx: number, by: number) => {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  };

  let i0 = 0;
  let i1 = 0;
  let i2 = 0;
  let minDist = Infinity;
  for (let i = 0; i < n; i++) {
    const d = dist(cx, cy, X(i), Y(i));
    if (d < minDist) {
      i0 = i;
      minDist = d;
    }
  }
  const i0x = X(i0);
  const i0y = Y(i0);
  minDist = Infinity;
  for (let i = 0; i < n; i++) {
    if (i === i0) continue;
    const d = dist(i0x, i0y, X(i), Y(i));
    if (d < minDist && d > 0) {
      i1 = i;
      minDist = d;
    }
  }
  let i1x = X(i1);
  let i1y = Y(i1);
  let minRadius = Infinity;
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1) continue;
    const r = circumradius(i0x, i0y, i1x, i1y, X(i), Y(i));
    if (r < minRadius) {
      i2 = i;
      minRadius = r;
    }
  }
  let i2x = X(i2);
  let i2y = Y(i2);
  if (minRadius === Infinity) return new Uint32Array(0);
  if (orient(i0x, i0y, i1x, i1y, i2x, i2y)) {
    [i1, i2] = [i2, i1];
    [i1x, i1y, i2x, i2y] = [i2x, i2y, i1x, i1y];
  }
  const [ccx, ccy] = circumcenter(i0x, i0y, i1x, i1y, i2x, i2y);
  for (let i = 0; i < n; i++) dists[i] = dist(X(i), Y(i), ccx, ccy);
  quicksort(ids, dists, 0, n - 1);

  const hashKey = (px: number, py: number) =>
    Math.floor(pseudoAngle(px - ccx, py - ccy) * hashSize) % hashSize;

  let hullStart = i0;
  hullNext[i0] = hullPrev[i2] = i1;
  hullNext[i1] = hullPrev[i0] = i2;
  hullNext[i2] = hullPrev[i1] = i0;
  hullTri[i0] = 0;
  hullTri[i1] = 1;
  hullTri[i2] = 2;
  hullHash[hashKey(i0x, i0y)] = i0;
  hullHash[hashKey(i1x, i1y)] = i1;
  hullHash[hashKey(i2x, i2y)] = i2;

  let tlen = 0;
  const edgeStack: number[] = [];
  const H = (k: number) => halfedges[k] ?? -1;
  const T = (k: number) => tris[k] ?? 0;
  const link = (a: number, b: number) => {
    halfedges[a] = b;
    if (b !== -1) halfedges[b] = a;
  };
  const addTriangle = (a0: number, a1: number, a2: number, a: number, b: number, c: number) => {
    const t = tlen;
    tris[t] = a0;
    tris[t + 1] = a1;
    tris[t + 2] = a2;
    link(t, a);
    link(t + 1, b);
    link(t + 2, c);
    tlen += 3;
    return t;
  };
  const legalize = (a0in: number): number => {
    let a = a0in;
    edgeStack.length = 0;
    let ar: number;
    for (;;) {
      const b = H(a);
      const a0 = a - (a % 3);
      ar = a0 + ((a + 2) % 3);
      if (b === -1) {
        const next = edgeStack.pop();
        if (next === undefined) break;
        a = next;
        continue;
      }
      const b0 = b - (b % 3);
      const al = a0 + ((a + 1) % 3);
      const bl = b0 + ((b + 2) % 3);
      const p0 = T(ar);
      const pr = T(a);
      const pl = T(al);
      const p1 = T(bl);
      if (inCircle(X(p0), Y(p0), X(pr), Y(pr), X(pl), Y(pl), X(p1), Y(p1))) {
        tris[a] = p1;
        tris[b] = p0;
        const hbl = H(bl);
        if (hbl === -1) {
          let e = hullStart;
          for (;;) {
            if (hullTri[e] === bl) {
              hullTri[e] = a;
              break;
            }
            e = hullPrev[e] ?? 0;
            if (e === hullStart) break;
          }
        }
        link(a, hbl);
        link(b, H(ar));
        link(ar, bl);
        const br = b0 + ((b + 1) % 3);
        if (edgeStack.length < 512) edgeStack.push(br);
      } else {
        const next = edgeStack.pop();
        if (next === undefined) break;
        a = next;
      }
    }
    return ar;
  };

  addTriangle(i0, i1, i2, -1, -1, -1);
  let xp = 0;
  let yp = 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k] ?? 0;
    const px = X(i);
    const py = Y(i);
    if (k > 0 && Math.abs(px - xp) <= EPSILON && Math.abs(py - yp) <= EPSILON) continue;
    xp = px;
    yp = py;
    if (i === i0 || i === i1 || i === i2) continue;
    let start = -1;
    const key = hashKey(px, py);
    for (let j = 0; j < hashSize; j++) {
      const probe = hullHash[(key + j) % hashSize] ?? -1;
      if (probe !== -1 && probe !== hullNext[probe]) {
        start = probe;
        break;
      }
    }
    start = hullPrev[start === -1 ? hullStart : start] ?? 0;
    let e = start;
    for (;;) {
      const q = hullNext[e] ?? 0;
      if (orient(px, py, X(e), Y(e), X(q), Y(q))) break;
      e = q;
      if (e === start) {
        e = -1;
        break;
      }
    }
    if (e === -1) continue;
    let t = addTriangle(e, i, hullNext[e] ?? 0, -1, -1, hullTri[e] ?? 0);
    hullTri[i] = legalize(t + 2);
    hullTri[e] = t;
    let nn = hullNext[e] ?? 0;
    for (;;) {
      const q = hullNext[nn] ?? 0;
      if (!orient(px, py, X(nn), Y(nn), X(q), Y(q))) break;
      t = addTriangle(nn, i, q, hullTri[i] ?? 0, -1, hullTri[nn] ?? 0);
      hullTri[i] = legalize(t + 2);
      hullNext[nn] = nn;
      nn = q;
    }
    if (e === start) {
      for (;;) {
        const q = hullPrev[e] ?? 0;
        if (!orient(px, py, X(q), Y(q), X(e), Y(e))) break;
        t = addTriangle(q, i, e, -1, hullTri[e] ?? 0, hullTri[q] ?? 0);
        legalize(t + 2);
        hullTri[q] = t;
        hullNext[e] = e;
        e = q;
      }
    }
    hullStart = hullPrev[i] = e;
    hullNext[e] = hullPrev[nn] = i;
    hullNext[i] = nn;
    hullHash[hashKey(px, py)] = i;
    hullHash[hashKey(X(e), Y(e))] = e;
  }
  return tris.slice(0, tlen);
}
