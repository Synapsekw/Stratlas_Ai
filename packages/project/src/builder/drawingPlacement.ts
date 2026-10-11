import type { Layer, RasterCorners } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where a picture drawing lies (data-conventions section 15). A PDF page, a scan or a screenshot
 * has no position and no scale, so it starts on a provisional placement and stays "not placed"
 * until someone places it by point pairs (the corners patch of `builder:updateLayers`).
 */

/** Long side of a drawing that is not placed yet, metres. */
export const DRAWING_LONG_M = 100;
/** Long side of a drawing's `plan.png`, pixels: larger pictures are scaled down to it. */
export const MAX_DRAWING_PX = 8192;
/** Pictures above this are refused before they are decoded (megapixels). */
export const MAX_DRAWING_MP = 400;

/** `drawings/<stem>/plan.png`: the plan raster of one drawing. */
export const DRAWING_PLAN = /^drawings\/([A-Za-z0-9][A-Za-z0-9_-]{0,80})\/plan\.png$/;

/**
 * `drawings/<stem>/placement.json` of a picture drawing (`aio.drawingplacement/1`, the file the
 * DXF pipeline writes too): a pixel (px right, py down) lies at `x = a*px + b*py + tx`,
 * `z = c*px + d*py + tz` in the local frame, at height `baseY`.
 */
export interface DrawingPlacementFile {
  schema: 'aio.drawingplacement/1';
  /** The original's file name. */
  file: string;
  units: 'px';
  /** Metres per pixel. */
  unitM: number;
  matrix: [number, number, number, number, number, number];
  baseY: number;
  /** True until the drawing is placed by point pairs. */
  provisional: boolean;
  /** Width and height of `plan.png`. */
  sizePx: [number, number];
  /** The page of the original this drawing is (PDF with several pages). */
  page?: number;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Centred on the project origin, north up, `DRAWING_LONG_M` on the long side, on the base. */
export function provisionalCorners(width: number, height: number): RasterCorners {
  const k = DRAWING_LONG_M / Math.max(width, height, 1);
  const w = r6((width * k) / 2);
  const h = r6((height * k) / 2);
  return { tl: [-w, 0, -h], tr: [w, 0, -h], bl: [-w, 0, h] };
}

/** The placement file of a picture whose `plan.png` (width x height pixels) lies on `corners`. */
export function placementFor(
  file: string,
  corners: RasterCorners,
  width: number,
  height: number,
  provisional: boolean,
  page?: number,
): DrawingPlacementFile {
  const { tl, tr, bl } = corners;
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const a = (tr[0] - tl[0]) / w;
  const c = (tr[2] - tl[2]) / w;
  const b = (bl[0] - tl[0]) / h;
  const d = (bl[2] - tl[2]) / h;
  return {
    schema: 'aio.drawingplacement/1',
    file,
    units: 'px',
    unitM: r6(Math.sqrt(Math.abs(a * d - b * c))),
    matrix: [r6(a), r6(b), r6(c), r6(d), r6(tl[0]), r6(tl[2])],
    baseY: r6(tl[1]),
    provisional,
    sizePx: [width, height],
    ...(page !== undefined ? { page } : {}),
  };
}

/** Width and height from the head of a PNG or JPEG file; null for anything else. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a) {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // JPEG: walk the segments to the frame header (SOF0 to SOF15, not DHT, JPG or DAC)
  let p = 2;
  while (p + 9 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1] ?? 0;
    if (marker === 0xff) {
      p++;
      continue;
    }
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frame) return { width: v.getUint16(p + 7), height: v.getUint16(p + 5) };
    p += 2 + v.getUint16(p + 2);
  }
  return null;
}

/** The stem of a layer that is a drawing's plan raster, else null. */
export function drawingStemOf(l: Layer): string | null {
  if (l.kind !== 'raster' || l.role !== 'plan' || !('path' in l.src)) return null;
  return DRAWING_PLAN.exec(l.src.path.replace(/\\/g, '/'))?.[1] ?? null;
}

/** A drawing a save places: its folder, its name for messages and where it now lies. */
export interface PlacedDrawing {
  stem: string;
  name: string;
  corners: RasterCorners;
}

export async function writePlacement(
  root: string,
  stem: string,
  placement: DrawingPlacementFile,
): Promise<void> {
  const file = join(root, 'drawings', stem, 'placement.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(placement, null, 2)}\n`);
}

/**
 * After a picture drawing got new corners: its placement file follows them and is no longer
 * provisional. A drawing placed in its own units (a DXF) is placed by its pipeline, which moves
 * its vector layers and parts with it, so its corners are refused here.
 */
export async function markDrawingPlaced(
  root: string,
  stem: string,
  name: string,
  corners: RasterCorners,
): Promise<void> {
  let old: Partial<DrawingPlacementFile> & { units?: string };
  try {
    old = JSON.parse(
      await readFile(join(root, 'drawings', stem, 'placement.json'), 'utf8'),
    ) as typeof old;
  } catch {
    // a drawing without its placement file: the manifest corners are the placement
    return;
  }
  const size = old.sizePx;
  if (old.units !== 'px' || !Array.isArray(size)) {
    throw new Error(
      `"${name}" is a DXF drawing: place it in the Model builder, which moves its line work too.`,
    );
  }
  await writePlacement(
    root,
    stem,
    placementFor(old.file ?? name, corners, size[0], size[1], false, old.page),
  );
}
