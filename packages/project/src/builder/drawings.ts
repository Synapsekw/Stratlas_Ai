import type { ImportItem, Layer, ProjectManifest } from '@aio/schema';
import { copyFile, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { encodePng } from '../import/png';
import { slug, uniqueId } from './create';
import { updateManifestFile } from './manifestFile';
import {
  MAX_DRAWING_MP,
  MAX_DRAWING_PX,
  imageSize,
  placementFor,
  provisionalCorners,
  writePlacement,
} from './drawingPlacement';
import { decodeTiff, rasterToRgba, readTiffHeader } from './tiff';

/**
 * Drawings from pictures and PDF (data-conventions section 15): the original is copied to
 * `drawings/<stem>.<ext>` and drawn once as `drawings/<stem>/plan.png`, listed as a `raster` layer
 * with `role: 'plan'` and `format: 'image'` (id `sheet-<stem>`), as the plan of a DXF drawing is.
 * A new drawing is not placed: it lies on a provisional placement and is saved hidden.
 */

/** Pictures that are always drawings. */
const ALWAYS = new Set(['.png', '.pdf', '.webp', '.svg']);
/** Pictures that are drawings only through Add drawing (else a photo, an ortho). */
const ON_REQUEST = new Set(['.jpg', '.jpeg', '.tif', '.tiff']);
/** Types main has no decoder for: the app window draws them (`ImportItem.drawing`). */
const DRAWN_BY_WINDOW = new Set(['.pdf', '.webp', '.svg']);
const TIFF = new Set(['.tif', '.tiff']);

export const DRAWING_ADDED =
  'Added to Drawings, not placed yet. Open it side by side, or place it on the site to lay it over the model.';

/** Whether a file of this extension imports as a drawing (`asDrawings`: through Add drawing). */
export function isDrawingFile(ext: string, asDrawings: boolean): boolean {
  return ALWAYS.has(ext) || (asDrawings && ON_REQUEST.has(ext));
}

/** PNG copies of pictures (Electron's codec in the app). */
export interface DrawingImages {
  /** Write `dst` as a PNG no larger than `maxPx` on its long side; answers its size. */
  toPng?(src: string, dst: string, maxPx: number): Promise<{ width: number; height: number }>;
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const r = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, r.bytesRead);
  } finally {
    await fh.close();
  }
}

const sheetId = (stem: string) => `sheet-${stem}`;

/**
 * A folder name for a new drawing: the file name slugged, with `-2`, `-3` ... while a drawing, a
 * layer or a file of that name is there (pages of a PDF take `<stem>-p<N>`).
 */
async function newStem(root: string, m: ProjectManifest, name: string): Promise<string> {
  let files: string[] = [];
  try {
    files = await readdir(join(root, 'drawings'));
  } catch {
    // no drawings folder yet
  }
  const used = new Set(files.map((f) => f.replace(/\.[^.]+$/, '').toLowerCase()));
  const ids = m.layers.map((l) => l.id);
  const base = slug(name.slice(0, name.length - extname(name).length), 'drawing').slice(0, 60);
  return uniqueId(
    base.replace(/-+$/, '') || 'drawing',
    (s) =>
      used.has(s) ||
      [...used].some((u) => u.startsWith(`${s}-p`) && /^\d+$/.test(u.slice(s.length + 2))) ||
      ids.some((id) => id === sheetId(s) || id === `plan-${s}` || id.startsWith(`${sheetId(s)}-p`)),
  );
}

/** List `plan.png` of `stem` (already written) as a hidden, not placed plan raster. */
async function listDrawing(
  root: string,
  m: ProjectManifest,
  d: { stem: string; name: string; file: string; width: number; height: number; page?: number },
): Promise<string> {
  const corners = provisionalCorners(d.width, d.height);
  await writePlacement(
    root,
    d.stem,
    placementFor(d.file, corners, d.width, d.height, true, d.page),
  );
  const path = `drawings/${d.stem}/plan.png`;
  const layer: Extract<Layer, { kind: 'raster' }> = {
    kind: 'raster',
    id: sheetId(d.stem),
    name: d.name,
    // not placed: it would lie over the site in the wrong place and at the wrong size
    visible: false,
    src: { path },
    role: 'plan',
    format: 'image',
    corners,
  };
  const at = m.layers.findIndex(
    (l) => l.kind === 'raster' && 'path' in l.src && l.src.path === path,
  );
  if (at >= 0) {
    const old = m.layers[at];
    m.layers[at] = { ...layer, id: old?.id ?? layer.id };
    return old?.id ?? layer.id;
  }
  layer.id = uniqueId(layer.id, (id) => m.layers.some((l) => l.id === id));
  m.layers.push(layer);
  return layer.id;
}

function checkSize(name: string, size: { width: number; height: number } | null): void {
  if (size && (size.width * size.height) / 1e6 > MAX_DRAWING_MP) {
    throw new Error(
      `${name} is ${String(size.width)} x ${String(size.height)} pixels, too large to open. Save it smaller (at most ${String(MAX_DRAWING_MP)} megapixels), then import it.`,
    );
  }
}

/**
 * Import one picture as a drawing into the manifest `m` (the caller saves it). PNG and JPEG go
 * through `images.toPng`, TIFF through the builder's reader; PDF, WebP and SVG are only copied in
 * and answer `drawing`, for the app window to draw (`addDrawingPage`).
 */
export async function importDrawingFile(
  root: string,
  m: ProjectManifest,
  file: string,
  images: DrawingImages,
): Promise<ImportItem> {
  const name = basename(file);
  const ext = extname(file).toLowerCase();
  const tiff = TIFF.has(ext);
  // sizes are read from the file head, so a picture too large to open is refused before any work
  if (tiff) {
    const head = readTiffHeader(await readHead(file, 65536));
    if (head.bigTiff)
      throw new Error(
        `${name} is a BigTIFF, too large for a drawing. Save it smaller, as TIFF or PNG.`,
      );
    checkSize(name, head);
  } else if (!DRAWN_BY_WINDOW.has(ext)) checkSize(name, imageSize(await readHead(file, 65536)));
  const stem = await newStem(root, m, name);
  const src = `drawings/${stem}${ext}`;
  await mkdir(join(root, 'drawings'), { recursive: true });
  await copyFile(file, join(root, src));
  if (DRAWN_BY_WINDOW.has(ext)) {
    return {
      file: name,
      kind: 'drawing',
      status: 'queued',
      message: 'Reading the pages.',
      drawing: { stem, src, name },
    };
  }
  await mkdir(join(root, 'drawings', stem), { recursive: true });
  const plan = join(root, 'drawings', stem, 'plan.png');
  let size: { width: number; height: number };
  if (tiff) {
    const t = decodeTiff(new Uint8Array(await readFile(file)));
    const img = rasterToRgba(t, 'ortho', MAX_DRAWING_PX);
    await writeFile(
      plan,
      encodePng({ width: img.width, height: img.height, channels: 4, data: img.data }),
    );
    size = { width: img.width, height: img.height };
  } else {
    if (!images.toPng) throw new Error('Picture drawings are not available in this build.');
    size = await images.toPng(file, plan, MAX_DRAWING_PX);
  }
  const layerId = await listDrawing(root, m, { stem, name, file: name, ...size });
  return { file: name, kind: 'drawing', status: 'imported', layerId, message: DRAWING_ADDED };
}

export interface DrawingPage {
  /** The staged drawing (`ImportItem.drawing.stem`). */
  stem: string;
  /** The original's file name. */
  name: string;
  /** 1-based page and the page count of the original; absent for a one page drawing. */
  page?: number | undefined;
  pages?: number | undefined;
  png: Uint8Array;
}

/**
 * One page the app window drew for a staged drawing (`builder:addDrawingPage`): written as
 * `drawings/<stem>/plan.png`, or `drawings/<stem>-p<page>/plan.png` when the original has several
 * pages, and listed. The same page again replaces its picture and keeps its layer.
 */
export async function addDrawingPage(
  root: string,
  p: DrawingPage,
): Promise<{ manifest: ProjectManifest; layerId: string; backup: string }> {
  const size = imageSize(p.png);
  if (!size || p.png[1] !== 0x50) throw new Error('The page is not a PNG picture.');
  checkSize(p.name, size);
  let files: string[] = [];
  try {
    files = await readdir(join(root, 'drawings'));
  } catch {
    // no drawings folder: nothing was staged
  }
  const original = files.find(
    (f) => f.slice(0, f.length - extname(f).length) === p.stem && extname(f) !== '',
  );
  if (!original) throw new Error(`The drawing "${p.stem}" was not imported into this project.`);
  const many = (p.pages ?? 1) > 1 && p.page !== undefined;
  const stem = many ? `${p.stem}-p${String(p.page)}` : p.stem;
  const name = many ? `${p.name}, page ${String(p.page)}` : p.name;
  // read, list and save in one turn, so pages added one after another never lose each other
  const r = await updateManifestFile(root, async (read) => {
    const m = structuredClone(read);
    await mkdir(join(root, 'drawings', stem), { recursive: true });
    await writeFile(join(root, 'drawings', stem, 'plan.png'), p.png);
    const layerId = await listDrawing(root, m, {
      stem,
      name,
      file: p.name,
      ...size,
      ...(many && p.page !== undefined ? { page: p.page } : {}),
    });
    return { manifest: m, layerId };
  });
  return { manifest: r.manifest, layerId: r.layerId, backup: r.backup };
}
