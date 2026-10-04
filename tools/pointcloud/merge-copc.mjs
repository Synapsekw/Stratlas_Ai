// Merges COPC files whose cubes are cells of one octree into a single COPC file, copying the
// compressed node chunks byte for byte (no recompression):
//
// - `base`: a COPC file whose cube is the whole octree; its nodes down to `maxDepth` are kept.
// - `tiles`: COPC files whose cube is exactly the octree cell `key` [d, x, y, z]; every node is
//   re-keyed under that cell.
//
// All inputs must share the point format, record length, scale and offset (the chunks are LAZ
// encoded against them). PDAL's writers.copc makes the cube [min, min + max extent] of the data,
// so a tile gets its cell as cube when two points sit at the cell's minimum corner and at
// minimum + (cell size, 0, 0); alzour-copc.mjs adds them (class 7, low noise).
import { closeSync, openSync, readSync, writeSync, fstatSync } from 'node:fs';

const HEADER = 375;
const VLR_HEAD = 54;
const EVLR_HEAD = 60;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, b, off, len - off, pos + off);
    if (n === 0) throw new Error(`Unexpected end of file at ${pos + off}`);
    off += n;
  }
  return b;
}

const str = (b, at, len) => b.toString('latin1', at, at + len).replace(/\0.*$/s, '');

/** Header, VLRs, EVLRs and the full node hierarchy of one COPC file. */
export function readCopc(file) {
  const fd = openSync(file, 'r');
  const h = readAt(fd, 0, HEADER);
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error(`${file} is not a LAS file`);
  const headerSize = h.readUInt16LE(94);
  const pointOffset = h.readUInt32LE(96);
  const vlrCount = h.readUInt32LE(100);
  const evlrStart = Number(h.readBigUInt64LE(235));
  const evlrCount = h.readUInt32LE(243);
  const vlrBytes = readAt(fd, headerSize, pointOffset - headerSize);
  const vlrs = [];
  for (let p = 0, i = 0; i < vlrCount; i++) {
    const len = vlrBytes.readUInt16LE(p + 20);
    vlrs.push({ user: str(vlrBytes, p + 2, 16), id: vlrBytes.readUInt16LE(p + 18), at: p, len });
    p += VLR_HEAD + len;
  }
  const info = vlrs.find((v) => v.user === 'copc' && v.id === 1);
  if (!info || vlrs[0] !== info) throw new Error(`${file}: the COPC info VLR must come first`);
  const ib = vlrBytes.subarray(info.at + VLR_HEAD, info.at + VLR_HEAD + 160);
  const copc = {
    center: [ib.readDoubleLE(0), ib.readDoubleLE(8), ib.readDoubleLE(16)],
    halfsize: ib.readDoubleLE(24),
    spacing: ib.readDoubleLE(32),
    rootOffset: Number(ib.readBigUInt64LE(40)),
    rootSize: Number(ib.readBigUInt64LE(48)),
  };
  const evlrs = [];
  for (let p = evlrStart, i = 0; i < evlrCount; i++) {
    const eh = readAt(fd, p, EVLR_HEAD);
    const len = Number(eh.readBigUInt64LE(20));
    evlrs.push({ user: str(eh, 2, 16), id: eh.readUInt16LE(18), at: p, len, head: eh });
    p += EVLR_HEAD + len;
  }
  const nodes = new Map();
  const loadPage = (offset, size) => {
    const b = readAt(fd, offset, size);
    for (let p = 0; p < size; p += 32) {
      const key = [
        b.readInt32LE(p),
        b.readInt32LE(p + 4),
        b.readInt32LE(p + 8),
        b.readInt32LE(p + 12),
      ];
      const off = Number(b.readBigUInt64LE(p + 16));
      const bytes = b.readInt32LE(p + 24);
      const count = b.readInt32LE(p + 28);
      if (count === -1) loadPage(off, bytes);
      else nodes.set(key.join('-'), { key, offset: off, bytes, count });
    }
  };
  loadPage(copc.rootOffset, copc.rootSize);
  return {
    file,
    fd,
    header: h,
    headerSize,
    pointOffset,
    vlrBytes,
    vlrs,
    evlrs,
    copc,
    nodes,
    format: h.readUInt8(104),
    recordLength: h.readUInt16LE(105),
    scale: [h.readDoubleLE(131), h.readDoubleLE(139), h.readDoubleLE(147)],
    offset: [h.readDoubleLE(155), h.readDoubleLE(163), h.readDoubleLE(171)],
    bounds: {
      min: [h.readDoubleLE(187), h.readDoubleLE(203), h.readDoubleLE(219)],
      max: [h.readDoubleLE(179), h.readDoubleLE(195), h.readDoubleLE(211)],
    },
    close: () => closeSync(fd),
  };
}

const same = (a, b) => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 1e-9);

/**
 * Merge. `bounds` (optional) is written to the header (data bounds without helper points).
 * Returns { nodes, points, bytes }.
 */
export function mergeCopc({ base, maxDepth, tiles, out, bounds, log = () => undefined }) {
  const b = readCopc(base);
  const inputs = [{ src: b, map: (k) => (k[0] <= maxDepth ? k : null) }];
  const cube = b.copc.halfsize * 2;
  const cubeMin = b.copc.center.map((c) => c - b.copc.halfsize);
  for (const t of tiles) {
    const src = readCopc(t.file);
    const [d, x, y, z] = t.key;
    const cell = cube / 2 ** d;
    const want = [cubeMin[0] + x * cell, cubeMin[1] + y * cell, cubeMin[2] + z * cell];
    const got = src.copc.center.map((c) => c - src.copc.halfsize);
    if (!same(want, got) || Math.abs(src.copc.halfsize * 2 - cell) > 1e-6) {
      throw new Error(
        `${t.file}: cube ${got.join(',')} size ${src.copc.halfsize * 2} is not cell ${t.key.join('-')} (${want.join(',')} size ${cell})`,
      );
    }
    for (const s of [src]) {
      if (s.format !== b.format || s.recordLength !== b.recordLength) {
        throw new Error(`${t.file}: point format differs from the base`);
      }
      if (!same(s.scale, b.scale) || !same(s.offset, b.offset)) {
        throw new Error(`${t.file}: scale or offset differs from the base`);
      }
    }
    inputs.push({
      src,
      map: ([nd, nx, ny, nz]) => [nd + d, nx + x * 2 ** nd, ny + y * 2 ** nd, nz + z * 2 ** nd],
    });
  }

  const fd = openSync(out, 'w');
  let pos = 0;
  const write = (buf, at = pos) => {
    writeSync(fd, buf, 0, buf.length, at);
    if (at === pos) pos += buf.length;
  };
  // header and VLRs from the base; patched at the end
  const header = Buffer.from(b.header);
  write(Buffer.alloc(b.pointOffset)); // placeholder, rewritten below
  // LAZ point data starts with the offset of the chunk table
  const chunkTablePtrAt = pos;
  write(Buffer.alloc(8));
  const entries = [];
  const seen = new Set();
  let points = 0;
  const copyBuf = Buffer.alloc(16 << 20);
  for (const { src, map } of inputs) {
    const ordered = [...src.nodes.values()].sort((p, q) => p.key[0] - q.key[0]);
    for (const n of ordered) {
      const key = map(n.key);
      if (!key) continue;
      const id = key.join('-');
      if (seen.has(id)) throw new Error(`Node ${id} appears twice (${src.file})`);
      seen.add(id);
      const at = pos;
      for (let done = 0; done < n.bytes;) {
        const len = Math.min(copyBuf.length, n.bytes - done);
        const got = readSync(src.fd, copyBuf, 0, len, n.offset + done);
        writeSync(fd, copyBuf, 0, got, pos);
        pos += got;
        done += got;
      }
      entries.push({ key, offset: n.bytes ? at : 0, bytes: n.bytes, count: n.count });
      points += n.count;
    }
    log(`${src.file}: ${src.nodes.size} nodes`);
  }
  // an empty chunk table (version 0, no chunks): COPC readers find chunks through the hierarchy
  const chunkTableAt = pos;
  const ct = Buffer.alloc(8);
  write(ct);
  const ptr = Buffer.alloc(8);
  ptr.writeBigInt64LE(BigInt(chunkTableAt));
  write(ptr, chunkTablePtrAt);

  // EVLRs: the base's own (WKT and the like) except its hierarchy, then the new hierarchy
  const evlrStart = pos;
  let evlrCount = 0;
  for (const e of b.evlrs) {
    if (e.user === 'copc' && e.id === 1000) continue;
    write(readAt(b.fd, e.at, EVLR_HEAD + e.len));
    evlrCount++;
  }
  const page = Buffer.alloc(entries.length * 32);
  entries.forEach((e, i) => {
    const p = i * 32;
    page.writeInt32LE(e.key[0], p);
    page.writeInt32LE(e.key[1], p + 4);
    page.writeInt32LE(e.key[2], p + 8);
    page.writeInt32LE(e.key[3], p + 12);
    page.writeBigUInt64LE(BigInt(e.offset), p + 16);
    page.writeInt32LE(e.bytes, p + 24);
    page.writeInt32LE(e.count, p + 28);
  });
  const eh = Buffer.alloc(EVLR_HEAD);
  eh.write('copc', 2, 'latin1');
  eh.writeUInt16LE(1000, 18);
  eh.writeBigUInt64LE(BigInt(page.length), 20);
  eh.write('EPT hierarchy', 28, 'latin1');
  write(eh);
  const hierAt = pos;
  write(page);
  evlrCount++;

  // header: counts, bounds, EVLRs
  header.writeUInt32LE(0, 107); // legacy count: 0 for point formats 6 to 10
  for (let i = 0; i < 5; i++) header.writeUInt32LE(0, 111 + 4 * i);
  header.writeBigUInt64LE(BigInt(evlrStart), 235);
  header.writeUInt32LE(evlrCount, 243);
  header.writeBigUInt64LE(BigInt(points), 247);
  header.writeBigUInt64LE(BigInt(points), 255); // all first returns (photogrammetry)
  for (let i = 1; i < 15; i++) header.writeBigUInt64LE(0n, 255 + 8 * i);
  const bb = bounds ?? b.bounds;
  header.writeDoubleLE(bb.max[0], 179);
  header.writeDoubleLE(bb.min[0], 187);
  header.writeDoubleLE(bb.max[1], 195);
  header.writeDoubleLE(bb.min[1], 203);
  header.writeDoubleLE(bb.max[2], 211);
  header.writeDoubleLE(bb.min[2], 219);
  write(header.subarray(0, b.headerSize), 0);
  // VLRs, with the COPC info pointing at the new hierarchy
  const vlrs = Buffer.from(b.vlrBytes);
  const info = vlrs.subarray(VLR_HEAD, VLR_HEAD + 160);
  info.writeBigUInt64LE(BigInt(hierAt), 40);
  info.writeBigUInt64LE(BigInt(page.length), 48);
  write(vlrs, b.headerSize);
  closeSync(fd);
  for (const i of inputs) i.src.close();
  return { nodes: entries.length, points, bytes: fstatSafe(out) };
}

function fstatSafe(file) {
  const fd = openSync(file, 'r');
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}
