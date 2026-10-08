import { TinHeader, type TinHeader as TinHeaderT } from '@aio/schema';

/**
 * `aio.tin/1` design surfaces in the renderer (data-conventions section 28; written by
 * `aio_pipelines/design/tin_io.py`). Layout, little-endian: a uint32 header length, the UTF-8 JSON
 * header, padding to 8 bytes, `vertexCount * 3` float64 (E, N, Z in the project CRS, metres, design
 * offset not applied), `triangleCount * 3` uint32 vertex indices and, when the header has
 * `chainsAt`, `breaklines` chains of uint32 `kind` (0 breakline, 1 outer boundary, 2 void, 3 other
 * boundary), uint32 `count` and `count` uint32 vertex indices.
 */

export const TIN_CHAIN = { breakline: 0, outer: 1, void: 2, otherBoundary: 3 } as const;

export interface TinChain {
  kind: number;
  indices: Uint32Array;
}

export interface Tin {
  header: TinHeaderT;
  /** E, N, Z per vertex; Z with the vertical offset given to `parseTin` added. */
  vertices: Float64Array;
  triangles: Uint32Array;
  chains: TinChain[];
}

export class TinError extends Error {}

const bytesOf = (data: ArrayBuffer | Uint8Array): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data);

/** Read a `.tin`; `verticalOffsetM` (the layer's `verticalOffsetM`) is added to every Z. */
export function parseTin(data: ArrayBuffer | Uint8Array, verticalOffsetM = 0): Tin {
  const bytes = bytesOf(data);
  if (bytes.byteLength < 4) throw new TinError('The surface file is empty or damaged.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  if (4 + n > bytes.byteLength) throw new TinError("The surface file's header is damaged.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
  } catch (e) {
    throw new TinError(`The surface file's header is not JSON: ${String(e)}`);
  }
  const parsed = TinHeader.safeParse(raw);
  if (!parsed.success) throw new TinError('The surface file is not an aio.tin/1 file.');
  const header = parsed.data;
  const { vertexCount: nv, triangleCount: nt, verticesAt: va, trianglesAt: ta } = header;
  if (va % 8 !== 0 || va + nv * 24 > bytes.byteLength || ta + nt * 12 > bytes.byteLength)
    throw new TinError('The surface file is shorter than its header says.');
  // copies, so the typed arrays are aligned whatever the source buffer's offset
  const vertices = new Float64Array(bytes.slice(va, va + nv * 24).buffer);
  if (verticalOffsetM !== 0)
    for (let i = 2; i < vertices.length; i += 3) vertices[i] = (vertices[i] ?? 0) + verticalOffsetM;
  const triangles = new Uint32Array(bytes.slice(ta, ta + nt * 12).buffer);
  const chains: TinChain[] = [];
  const chainsAt = (header as { chainsAt?: unknown }).chainsAt;
  if (typeof chainsAt === 'number' && header.breaklines) {
    let at = chainsAt;
    for (let c = 0; c < header.breaklines; c++) {
      if (at + 8 > bytes.byteLength)
        throw new TinError('The surface file is shorter than its header says.');
      const kind = view.getUint32(at, true);
      const count = view.getUint32(at + 4, true);
      at += 8;
      if (at + count * 4 > bytes.byteLength)
        throw new TinError('The surface file is shorter than its header says.');
      chains.push({ kind, indices: new Uint32Array(bytes.slice(at, at + count * 4).buffer) });
      at += count * 4;
    }
  }
  for (const index of triangles)
    if (index >= nv) throw new TinError('A surface triangle names a vertex that does not exist.');
  return { header, vertices, triangles, chains };
}

/**
 * Heights of a TIN at (E, N) by barycentric interpolation, with a uniform grid of triangle
 * buckets (about two triangles per cell). `null` outside every triangle.
 */
export class TinSampler {
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly minE: number;
  private readonly minN: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;

  constructor(
    private readonly tin: Tin,
    private readonly offsetM = 0,
  ) {
    const [minE, minN, , maxE, maxN] = tin.header.bounds;
    const nt = tin.triangles.length / 3;
    const w = Math.max(maxE - minE, 1e-9);
    const h = Math.max(maxN - minN, 1e-9);
    this.cell = Math.max(Math.sqrt((w * h) / Math.max(1, nt / 2)), 1e-6);
    this.cols = Math.min(4096, Math.max(1, Math.ceil(w / this.cell)));
    this.rows = Math.min(4096, Math.max(1, Math.ceil(h / this.cell)));
    this.cell = Math.max(w / this.cols, h / this.rows);
    this.minE = minE;
    this.minN = minN;
    const counts = new Uint32Array(this.cols * this.rows + 1);
    const visit = (t: number, fn: (cell: number) => void) => {
      const [c0, r0, c1, r1] = this.span(t);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * this.cols + c);
    };
    for (let t = 0; t < nt; t++)
      visit(t, (k) => {
        counts[k + 1] = (counts[k + 1] ?? 0) + 1;
      });
    for (let k = 1; k < counts.length; k++) counts[k] = (counts[k] ?? 0) + (counts[k - 1] ?? 0);
    this.start = counts;
    this.items = new Uint32Array(counts[counts.length - 1] ?? 0);
    const fill = counts.slice(0, -1);
    for (let t = 0; t < nt; t++)
      visit(t, (k) => {
        this.items[fill[k] ?? 0] = t;
        fill[k] = (fill[k] ?? 0) + 1;
      });
  }

  private corner(i: number): [number, number, number] {
    const v = this.tin.vertices;
    return [v[i * 3] ?? 0, v[i * 3 + 1] ?? 0, v[i * 3 + 2] ?? 0];
  }

  private span(t: number): [number, number, number, number] {
    const tr = this.tin.triangles;
    let e0 = Infinity;
    let n0 = Infinity;
    let e1 = -Infinity;
    let n1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const [e, n] = this.corner(tr[t * 3 + k] ?? 0);
      e0 = Math.min(e0, e);
      n0 = Math.min(n0, n);
      e1 = Math.max(e1, e);
      n1 = Math.max(n1, n);
    }
    return [this.col(e0), this.row(n0), this.col(e1), this.row(n1)];
  }

  private col(e: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((e - this.minE) / this.cell)));
  }

  private row(n: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((n - this.minN) / this.cell)));
  }

  /** The height at (E, N) plus the sampler's offset, or null outside the surface. */
  sample(e: number, n: number): number | null {
    const [minE, minN, , maxE, maxN] = this.tin.header.bounds;
    const pad = 1e-9 * Math.max(1, Math.abs(maxE), Math.abs(maxN));
    if (e < minE - pad || e > maxE + pad || n < minN - pad || n > maxN + pad) return null;
    const k = this.row(n) * this.cols + this.col(e);
    const tr = this.tin.triangles;
    for (let i = this.start[k] ?? 0; i < (this.start[k + 1] ?? 0); i++) {
      const t = this.items[i] ?? 0;
      const [ae, an, az] = this.corner(tr[t * 3] ?? 0);
      const [be, bn, bz] = this.corner(tr[t * 3 + 1] ?? 0);
      const [ce, cn, cz] = this.corner(tr[t * 3 + 2] ?? 0);
      const d = (bn - cn) * (ae - ce) + (ce - be) * (an - cn);
      if (d === 0) continue;
      const l1 = ((bn - cn) * (e - ce) + (ce - be) * (n - cn)) / d;
      const l2 = ((cn - an) * (e - ce) + (ae - ce) * (n - cn)) / d;
      const l3 = 1 - l1 - l2;
      const eps = -1e-12;
      if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * az + l2 * bz + l3 * cz + this.offsetM;
    }
    return null;
  }
}
