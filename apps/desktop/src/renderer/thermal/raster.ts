import { ThermalRasterIndex, ThermalRasterMeta } from '@aio/schema';

/** A decoded thermal photo: degrees Celsius, row-major, NaN where the decoder had no value. */
export interface ThermalRaster {
  width: number;
  height: number;
  data: Float32Array;
  meta: ThermalRasterMeta;
}

const projectFile = (projectId: string, path: string): string =>
  `aio://project/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Read `thermal/rasters/<layerId>/<photoId>.json` and `.f32` over `aio://project/...`. Null when
 * either is missing, the sidecar is not `aio.thermalRaster/1`, or the data length does not match
 * the size: never throws.
 */
export async function loadRaster(
  projectId: string,
  layerId: string,
  photoId: string,
): Promise<ThermalRaster | null> {
  try {
    const stem = `thermal/rasters/${layerId}/${photoId}`;
    const metaRes = await fetch(projectFile(projectId, `${stem}.json`));
    if (!metaRes.ok) return null;
    const meta = ThermalRasterMeta.safeParse(await metaRes.json());
    if (!meta.success) return null;
    const binRes = await fetch(projectFile(projectId, `${stem}.f32`));
    if (!binRes.ok) return null;
    const buf = await binRes.arrayBuffer();
    const { width, height } = meta.data;
    if (buf.byteLength !== width * height * 4) return null;
    return { width, height, data: new Float32Array(buf), meta: meta.data };
  } catch {
    return null;
  }
}

/** Read `thermal/rasters/<layerId>/index.json`; null when missing or not valid. */
export async function loadRasterIndex(
  projectId: string,
  layerId: string,
): Promise<ThermalRasterIndex | null> {
  try {
    const res = await fetch(projectFile(projectId, `thermal/rasters/${layerId}/index.json`));
    if (!res.ok) return null;
    const index = ThermalRasterIndex.safeParse(await res.json());
    return index.success ? index.data : null;
  } catch {
    return null;
  }
}

/** The temperature at photo pixel (x, y), nearest pixel; null outside the raster or on NaN. */
export function tempAt(r: ThermalRaster, x: number, y: number): number | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (!(px >= 0 && py >= 0 && px < r.width && py < r.height)) return null;
  const v = r.data[py * r.width + px];
  return v === undefined || Number.isNaN(v) ? null : v;
}
