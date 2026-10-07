import { toWgs84 } from '@aio/geo';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { ecefToGeodetic, type SiteFrame } from './frame';
import { decodeTerrarium, lonLatToTileXY, type RasterTileSource } from './packs';

/**
 * Terrain and imagery around the site in the site view (Settings, decision 3): a height grid from
 * the terrain packs, draped with the imagery packs, in the project local frame and just under the
 * project's own ground, so a site sits in its landscape. Read once per project and radius; not
 * pickable (clicks pass to the ground like the street map's). Heights are the pack's (EGM2008 for
 * Copernicus) taken as project heights: a site whose heights are on another datum shows the
 * landscape offset by that difference, which the drop below the site hides for small offsets.
 */

/** Decoded tile pixels (RGBA). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface SurroundingsOptions {
  frame: SiteFrame;
  terrain: RasterTileSource | null;
  imagery: RasterTileSource | null;
  /** Half the side of the square around the origin, metres (default 3000). */
  radiusM?: number;
  /** Vertices per side (default 129). */
  grid?: number;
  /** How far under the project's heights the landscape sits, metres (default 0.3). */
  dropM?: number;
  /** Most pixels across the imagery texture (default 2048). */
  textureMaxPx?: number;
  /** Decode a tile image (browser: `createImageBitmap` and a canvas). */
  decode?: (data: ArrayBuffer) => Promise<Pixels>;
  /** Paint imagery tiles into one texture (browser default: a canvas). */
  compose?: (mosaic: Mosaic) => Texture | null;
  signal?: AbortSignal;
}

/** Tiles of one zoom laid side by side. */
export interface Mosaic {
  z: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  tileSize: number;
  /** Row-major tiles, null where no pack had one. */
  tiles: (Pixels | null)[];
}

/** The tile range covering a lon and lat box at a zoom. */
export function tileRange(
  [w, s, e, n]: readonly [number, number, number, number],
  z: number,
): { x0: number; y0: number; cols: number; rows: number } {
  const [ax, ay] = lonLatToTileXY(w, n, z);
  const [bx, by] = lonLatToTileXY(e, s, z);
  const x0 = Math.floor(ax);
  const y0 = Math.floor(ay);
  return { x0, y0, cols: Math.floor(bx) - x0 + 1, rows: Math.floor(by) - y0 + 1 };
}

async function fetchMosaic(
  source: RasterTileSource,
  bbox: [number, number, number, number],
  z: number,
  decode: (d: ArrayBuffer) => Promise<Pixels>,
  signal?: AbortSignal,
): Promise<Mosaic> {
  const { x0, y0, cols, rows } = tileRange(bbox, z);
  const jobs: Promise<Pixels | null>[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      jobs.push(
        source.getTile(z, x0 + c, y0 + r, signal).then(
          (t) => (t ? decode(t.data) : null),
          () => null,
        ),
      );
  const tiles = await Promise.all(jobs);
  const first = tiles.find((t) => t !== null);
  return { z, x0, y0, cols, rows, tileSize: first?.width ?? 256, tiles };
}

/** Bilinear height at a lon and lat from a Terrarium mosaic; NaN where no tile. */
export function heightAt(
  m: Mosaic,
  heights: (Float32Array | null)[],
  lon: number,
  lat: number,
): number {
  const [fx, fy] = lonLatToTileXY(lon, lat, m.z);
  const px = (fx - m.x0) * m.tileSize - 0.5;
  const py = (fy - m.y0) * m.tileSize - 0.5;
  const sample = (ix: number, iy: number): number => {
    const tx = Math.floor(ix / m.tileSize);
    const ty = Math.floor(iy / m.tileSize);
    if (tx < 0 || ty < 0 || tx >= m.cols || ty >= m.rows) return NaN;
    const h = heights[ty * m.cols + tx];
    if (!h) return NaN;
    const lx = ix - tx * m.tileSize;
    const ly = iy - ty * m.tileSize;
    return h[ly * m.tileSize + lx] ?? NaN;
  };
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const ax = px - x0;
  const ay = py - y0;
  const v00 = sample(x0, y0);
  const v10 = sample(x0 + 1, y0);
  const v01 = sample(x0, y0 + 1);
  const v11 = sample(x0 + 1, y0 + 1);
  const vals = [v00, v10, v01, v11];
  if (vals.every(Number.isFinite))
    return v00 * (1 - ax) * (1 - ay) + v10 * ax * (1 - ay) + v01 * (1 - ax) * ay + v11 * ax * ay;
  const known = vals.filter(Number.isFinite);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : NaN;
}

function defaultCompose(m: Mosaic): Texture | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(m.cols * m.tileSize, m.rows * m.tileSize);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  m.tiles.forEach((t, i) => {
    if (!t) return;
    const img = new ImageData(new Uint8ClampedArray(t.data), t.width, t.height);
    ctx.putImageData(img, (i % m.cols) * m.tileSize, Math.floor(i / m.cols) * m.tileSize);
  });
  const tex = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = false;
  return tex;
}

export async function browserDecode(data: ArrayBuffer): Promise<Pixels> {
  const bmp = await createImageBitmap(new Blob([data]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Choose the deepest zoom whose span stays within `maxPx` pixels (and within the source). */
export function zoomFor(spanDeg: number, maxPx: number, source: RasterTileSource): number {
  for (let z = Math.min(source.maxZoom, 18); z > source.minZoom; z--) {
    if ((spanDeg / 360) * 2 ** z * 256 <= maxPx) return z;
  }
  return source.minZoom;
}

export async function buildSurroundings(opts: SurroundingsOptions): Promise<Mesh | null> {
  const { frame, terrain, imagery } = opts;
  if (!terrain?.packs.length && !imagery?.packs.length) return null;
  const radius = opts.radiusM ?? 3000;
  const n = Math.max(3, opts.grid ?? 129);
  const drop = opts.dropM ?? 0.3;
  const decode = opts.decode ?? browserDecode;
  const [ox, oy, oz] = frame.origin;
  const [clon, clat] = ecefToGeodetic(frame.localToEcef([0, 0, 0]));
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.cos((clat * Math.PI) / 180));
  const bbox: [number, number, number, number] = [
    clon - dLon,
    clat - dLat,
    clon + dLon,
    clat + dLat,
  ];

  // heights
  let tMosaic: Mosaic | null = null;
  let heights: (Float32Array | null)[] = [];
  if (terrain?.packs.length) {
    const z = zoomFor(2 * dLon, 1024, terrain);
    tMosaic = await fetchMosaic(terrain, bbox, z, decode, opts.signal);
    heights = tMosaic.tiles.map((t) => (t ? decodeTerrarium(t.data, 4) : null));
  }
  // imagery
  let iMosaic: Mosaic | null = null;
  if (imagery?.packs.length) {
    const z = zoomFor(2 * dLon, opts.textureMaxPx ?? 2048, imagery);
    iMosaic = await fetchMosaic(imagery, bbox, z, decode, opts.signal);
    if (!iMosaic.tiles.some(Boolean)) iMosaic = null;
  }
  if (opts.signal?.aborted) return null;
  if (!tMosaic?.tiles.some(Boolean) && !iMosaic) return null;

  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -radius + (2 * radius * i) / (n - 1);
      const z = -radius + (2 * radius * j) / (n - 1);
      const [lon, lat] = toWgs84([ox + x, oy - z, 0], frame.epsg);
      const h = tMosaic ? heightAt(tMosaic, heights, lon, lat) : NaN;
      const k = j * n + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = (Number.isFinite(h) ? h - oz : 0) - drop;
      pos[k * 3 + 2] = z;
      if (iMosaic) {
        const [fx, fy] = lonLatToTileXY(lon, lat, iMosaic.z);
        uv[k * 2] = (fx - iMosaic.x0) / iMosaic.cols;
        uv[k * 2 + 1] = (fy - iMosaic.y0) / iMosaic.rows;
      }
    }
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      index.set([a, c, b, b, c, d], p);
      p += 6;
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  geom.setAttribute('uv', new BufferAttribute(uv, 2));
  geom.setIndex(new BufferAttribute(index, 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox();

  const map = iMosaic ? (opts.compose ?? defaultCompose)(iMosaic) : null;
  const material = new MeshStandardMaterial({
    color: map ? new Color(0xffffff) : new Color(0xb9a888),
    map,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const mesh = new Mesh(geom, material);
  mesh.name = 'site-surroundings';
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  // never pickable: a click on the landscape is a click on empty ground
  mesh.raycast = () => undefined;
  mesh.userData.credits = [...(terrain?.credits() ?? []), ...(imagery?.credits() ?? [])];
  return mesh;
}
