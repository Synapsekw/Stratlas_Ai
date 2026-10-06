// File writers of the demo builder: kit tile pyramids (data-conventions section 5), png-packed
// point clouds (packages/pointcloud/README.md) and JPEG photos with thumbnails. Images carry no
// metadata (sharp writes none unless asked): no EXIF, no GPS, no camera.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TILE = 512;

/**
 * Write a square-tiled pyramid of an RGB image whose size is TILE * 2^k on each side (cols and
 * rows), finest level last. Returns the tiles.json content (corners given by the caller).
 */
export async function writePyramid(root, rel, rgb, width, height, corners, { quality = 82 } = {}) {
  if (width % TILE || height % TILE)
    throw new Error(`pyramid ${rel}: ${width} x ${height} is not a multiple of ${TILE}`);
  let levels = 1;
  while (
    (width >> levels) % TILE === 0 &&
    (height >> levels) % TILE === 0 &&
    width >> levels >= TILE
  )
    levels++;
  const index = { schema: 'aio.tiles/1', levels: [], corners };
  let img = sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
    raw: { width, height, channels: 3 },
  });
  const full = await img.raw().toBuffer();
  for (let li = 0; li < levels; li++) {
    const z = li;
    const scale = 2 ** (levels - 1 - li);
    const w = width / scale;
    const h = height / scale;
    const level =
      scale === 1
        ? full
        : await sharp(full, { raw: { width, height, channels: 3 } })
            .resize(w, h, { kernel: 'lanczos3' })
            .raw()
            .toBuffer();
    const cols = w / TILE;
    const rows = h / TILE;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const file = join(root, rel, String(z), `${x}_${y}.webp`);
        await mkdir(dirname(file), { recursive: true });
        await sharp(level, { raw: { width: w, height: h, channels: 3 } })
          .extract({ left: x * TILE, top: y * TILE, width: TILE, height: TILE })
          .webp({ quality, effort: 5 })
          .toFile(file);
      }
    index.levels.push({ z, tileSize: TILE, cols, rows, pattern: `${rel}/{z}/{x}_{y}.webp` });
  }
  await writeFile(join(root, rel, 'tiles.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/**
 * Write a png-packed point cloud: positions (local frame) and sRGB colours (0..255). Chunk 0 is
 * the overview (lod 0), the rest refine it (lod 1), split by quadrant.
 */
export async function writePngCloud(root, rel, pos, col, rnd) {
  const n = pos.length / 3;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const overview = Math.round(n * 0.25);
  const groups = [Array.from(order.subarray(0, overview))];
  const quads = [[], [], [], []];
  for (let k = overview; k < n; k++) {
    const i = order[k];
    quads[(pos[3 * i] >= 0 ? 1 : 0) + (pos[3 * i + 2] >= 0 ? 2 : 0)].push(i);
  }
  groups.push(...quads.filter((q) => q.length));
  const all = bounds(pos, order);
  const chunks = [];
  for (let g = 0; g < groups.length; g++) {
    const ids = groups[g];
    const b = bounds(pos, ids);
    const N = ids.length;
    const stream = Buffer.alloc(9 * N);
    for (let k = 0; k < N; k++) {
      const i = ids[k];
      for (let a = 0; a < 3; a++) {
        const span = b.max[a] - b.min[a] || 1;
        const u = Math.max(
          0,
          Math.min(65535, Math.round(((pos[3 * i + a] - b.min[a]) / span) * 65535)),
        );
        stream[2 * a * N + k] = u & 0xff;
        stream[(2 * a + 1) * N + k] = u >> 8;
      }
      stream[6 * N + k] = col[3 * i];
      stream[7 * N + k] = col[3 * i + 1];
      stream[8 * N + k] = col[3 * i + 2];
    }
    const width = 1024;
    const height = Math.ceil(Math.ceil((9 * N) / 3) / width);
    const px = Buffer.alloc(width * height * 3);
    stream.copy(px);
    const file = `${rel}/c${String(g).padStart(3, '0')}.png`;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await sharp(px, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(join(root, file));
    chunks.push({ file, points: N, bounds: b, lod: g === 0 ? 0 : 1 });
  }
  const index = { schema: 'aio.pngcloud/1', bounds: all, spacing: 0.15, chunks };
  await writeFile(join(root, rel, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { index: `${rel}/index.json`, points: n };
}

function bounds(pos, ids) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of ids)
    for (let a = 0; a < 3; a++) {
      const v = pos[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  const r = (v) => Math.round(v * 1000) / 1000;
  return { min: min.map(r), max: max.map(r) };
}

/** A JPEG photo and its 320 px thumbnail beside it in thumbs/ (data-conventions section 2). */
export async function writePhoto(root, rel, rgb, width, height, { quality = 86 } = {}) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  const img = () =>
    sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
      raw: { width, height, channels: 3 },
    });
  await img().jpeg({ quality, mozjpeg: true }).toFile(file);
  const thumb = join(dirname(file), 'thumbs', rel.split('/').pop());
  await mkdir(dirname(thumb), { recursive: true });
  await img().resize(320).jpeg({ quality: 80 }).toFile(thumb);
}
