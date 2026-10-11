import type { ImportItem, Layer, ProjectManifest } from '@aio/schema';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { encodePng } from '../import/png';
import { slug } from './create';
import { updateManifestFile } from './manifestFile';
import {
  MAX_DRAWING_BYTES,
  MAX_DRAWING_PIXELS,
  MAX_DRAWING_PX,
  imageSize,
  placementFor,
  provisionalCorners,
  writePlacement,
} from './drawingPlacement';
import { decodeTiff, rasterToRgba } from './tiff';
import { readTiffHeaderFile } from './tiffFile';

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
/** How far into a picture its size is looked for when the first 64 KB do not hold it. */
const SIZE_SEARCH_BYTES = 8 * 1024 * 1024;
/** Names Windows keeps for devices: no file or folder can carry one, with any extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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

/** One name for a project folder however it is spelled (Windows ignores case). */
const rootKey = (root: string) => resolve(root).toLowerCase();

/**
 * Drawings main copied in and the app window is still drawing (PDF, WebP, SVG), by project: only
 * these take pages (`addDrawingPage`), and only until the window closes them (`closeDrawing`).
 * Kept in memory: an import that is cut off by closing the app is not picked up again.
 */
const staged = new Map<string, Map<string, { src: string; pages: number }>>();

/**
 * The stems one import has given out or handed to the DXF pipeline, lower case: a picture and a
 * DXF of one name picked together must not take the same folder, whichever comes first.
 */
export type ClaimedStems = Set<string>;

/** What already carries a name in `drawings/`, lower case: files (without ending) and folders. */
async function namesInUse(root: string): Promise<{ all: Set<string>; pictures: Set<string> }> {
  let files: string[] = [];
  try {
    files = await readdir(join(root, 'drawings'));
  } catch {
    // no drawings folder yet
  }
  const all = new Set<string>();
  const pictures = new Set<string>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const name = (ext ? f.slice(0, f.length - ext.length) : f).toLowerCase();
    all.add(name);
    // the original of a picture drawing (a DXF's own copy is not one)
    if (ext && ext !== '.dxf') pictures.add(name);
  }
  return { all, pictures };
}

/** `name` is `stem` itself or one of its pages (`<stem>-p<N>`). */
const isStemOrPage = (name: string, stem: string) =>
  name === stem || (name.startsWith(`${stem}-p`) && /^\d+$/.test(name.slice(stem.length + 2)));

/** The first of `base`, `base-2`, `base-3` ... that `taken` does not hold. */
function freeStem(base: string, taken: (stem: string) => boolean): string {
  let stem = base;
  for (let n = 2; taken(stem); n++) stem = `${base}-${String(n)}`;
  return stem;
}

/** Whether a stem (lower case) is in use by a file, a folder, a layer or this import. */
function stemTaken(
  s: string,
  m: ProjectManifest,
  used: ReadonlySet<string>,
  claimed: ClaimedStems,
): boolean {
  if (claimed.has(s) || [...used].some((u) => isStemOrPage(u, s))) return true;
  return m.layers.some((l) => {
    const id = l.id.toLowerCase();
    return id === `plan-${s}` || (id.startsWith('sheet-') && isStemOrPage(id.slice(6), s));
  });
}

/**
 * A folder name for a new drawing: the file name slugged, with `-2`, `-3` ... while a drawing, a
 * layer or a file of that name is there (pages of a PDF take `<stem>-p<N>`), whatever its case.
 */
async function newStem(
  root: string,
  m: ProjectManifest,
  name: string,
  claimed: ClaimedStems,
): Promise<string> {
  const bare = name.slice(0, name.length - extname(name).length);
  if (RESERVED.test(bare.trim())) {
    throw new Error(
      `"${name}" has a name Windows keeps for a device (${bare.trim()}). Rename the file, then import it.`,
    );
  }
  const base = slug(bare, 'drawing').slice(0, 60).replace(/-+$/, '') || 'drawing';
  const { all } = await namesInUse(root);
  const stem = freeStem(base, (s) => stemTaken(s, m, all, claimed));
  claimed.add(stem);
  return stem;
}

/** The folder the DXF pipeline files a drawing under (python `stem_of` of `drawing.import`). */
export function dxfStem(file: string): string {
  const name = basename(file.replace(/\\/g, '/'));
  const bare = name.slice(0, name.length - extname(name).length);
  const s = bare
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
  return s && /^[A-Za-z0-9]/.test(s) ? s : `drawing${s ? `-${s}` : ''}`.slice(0, 80);
}

/**
 * Before a DXF goes to `drawing.import`: the pipeline files it under `drawings/<stem>/` whatever
 * is there, so a picture drawing of the same name (in any case) would lose its picture and its
 * placement. When one owns the stem, the DXF is copied to `drawings/<free>.dxf` and the job reads
 * that copy, which makes the pipeline file it under the free name. Otherwise the stem is kept for
 * the DXF: for the rest of this import, and for later ones through its (still empty) folder.
 * Nothing is copied or made without the processing tools (`run` false).
 */
export async function dxfSource(
  root: string,
  m: ProjectManifest,
  file: string,
  claimed: ClaimedStems,
  run: boolean,
): Promise<{ src: string; copy?: string; note?: string }> {
  if (!run) return { src: file };
  const stem = dxfStem(file).toLowerCase();
  const { all, pictures } = await namesInUse(root);
  const owned =
    claimed.has(stem) ||
    [...pictures].some((p) => isStemOrPage(p, stem)) ||
    [...(staged.get(rootKey(root))?.keys() ?? [])].some((s) => s === stem) ||
    m.layers.some(
      (l) =>
        l.id.toLowerCase().startsWith('sheet-') && isStemOrPage(l.id.toLowerCase().slice(6), stem),
    );
  await mkdir(join(root, 'drawings'), { recursive: true });
  if (!owned) {
    claimed.add(stem);
    await mkdir(join(root, 'drawings', dxfStem(file)), { recursive: true });
    return { src: file };
  }
  const free = freeStem(stem, (s) => stemTaken(s, m, all, claimed));
  claimed.add(free);
  const copy = join(root, 'drawings', `${free}.dxf`);
  await copyFile(file, copy);
  return {
    src: copy,
    copy,
    note: `A picture drawing is already called ${stem}, so this drawing comes in as ${free}.`,
  };
}

/**
 * For a `drawing.import` job that is started outside an import (the Processing form, the model
 * builder): the refusal when a picture drawing has the folder the pipeline would file `src`
 * under, else null. The pipeline writes `drawings/<stem>/` whatever is there, and such a job
 * cannot be given another name. Says nothing when the project cannot be read.
 */
export async function dxfClash(root: string, src: string): Promise<string | null> {
  const stem = dxfStem(src);
  const s = stem.toLowerCase();
  const { pictures } = await namesInUse(root);
  let layers: ProjectManifest['layers'] = [];
  try {
    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      layers?: ProjectManifest['layers'];
    };
    if (Array.isArray(m.layers)) layers = m.layers;
  } catch {
    // no manifest to read: the job itself reports that
  }
  const owned =
    [...pictures].some((p) => isStemOrPage(p, s)) ||
    (staged.get(rootKey(root))?.has(s) ?? false) ||
    layers.some((l) => {
      const id = typeof l.id === 'string' ? l.id.toLowerCase() : '';
      return id.startsWith('sheet-') && isStemOrPage(id.slice(6), s);
    });
  return owned
    ? `A picture drawing is already called ${stem}. Rename the DXF file, then import it.`
    : null;
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
  layer.id = freeStem(layer.id, (id) => m.layers.some((l) => l.id === id));
  m.layers.push(layer);
  return layer.id;
}

const megapixels = (px: number) => String(Math.round(px / 1e6));

function checkPixels(name: string, size: { width: number; height: number } | null): void {
  if (size && size.width * size.height > MAX_DRAWING_PIXELS) {
    throw new Error(
      `${name} is ${String(size.width)} x ${String(size.height)} pixels, too large to open. Save it smaller (at most ${megapixels(MAX_DRAWING_PIXELS)} megapixels), then import it.`,
    );
  }
}

/**
 * Refuse a picture too large to open, from its file size and its header, before anything is
 * decoded or copied. An SVG and a PDF have no pixels of their own; they are sized when drawn.
 */
async function checkPicture(file: string, name: string, ext: string): Promise<void> {
  const bytes = (await stat(file)).size;
  if (bytes > MAX_DRAWING_BYTES) {
    throw new Error(
      `${name} is ${String(Math.round(bytes / (1024 * 1024)))} MB, too large for a drawing. Save it smaller (at most ${String(MAX_DRAWING_BYTES / (1024 * 1024))} MB), then import it.`,
    );
  }
  if (TIFF.has(ext)) {
    const head = await readTiffHeaderFile(file);
    if (head.bigTiff)
      throw new Error(
        `${name} is a BigTIFF, too large for a drawing. Save it smaller, as TIFF or PNG.`,
      );
    checkPixels(name, head);
  } else if (ext !== '.pdf' && ext !== '.svg') {
    // The size stands at the start of the file, but a JPEG may carry a preview or a colour
    // profile of megabytes before it. A picture whose size cannot be found is not decoded: it
    // could be larger than any limit.
    const size =
      imageSize(await readHead(file, 65536)) ?? imageSize(await readHead(file, SIZE_SEARCH_BYTES));
    if (!size || !(size.width > 0) || !(size.height > 0)) {
      throw new Error(
        `The size of ${name} could not be read from the file, so it was not opened. Save it again as PNG or JPEG, then import it.`,
      );
    }
    checkPixels(name, size);
  }
}

/**
 * Import one picture as a drawing into the manifest `m` (the caller saves it). PNG and JPEG go
 * through `images.toPng`, TIFF through the builder's reader; PDF, WebP and SVG are only copied in
 * and answer `drawing`, for the app window to draw (`addDrawingPage`, then `closeDrawing`). A
 * picture that cannot be decoded leaves nothing behind: the copy made here is removed again.
 */
export async function importDrawingFile(
  root: string,
  m: ProjectManifest,
  file: string,
  images: DrawingImages,
  claimed: ClaimedStems = new Set(),
): Promise<ImportItem> {
  const name = basename(file);
  const ext = extname(file).toLowerCase();
  const stem = await newStem(root, m, name, claimed);
  await checkPicture(file, name, ext);
  const src = `drawings/${stem}${ext}`;
  await mkdir(join(root, 'drawings'), { recursive: true });
  await copyFile(file, join(root, src));
  if (DRAWN_BY_WINDOW.has(ext)) {
    const key = rootKey(root);
    const waiting = staged.get(key) ?? new Map<string, { src: string; pages: number }>();
    waiting.set(stem, { src, pages: 0 });
    staged.set(key, waiting);
    return {
      file: name,
      kind: 'drawing',
      status: 'queued',
      message: 'Reading the pages.',
      drawing: { stem, src, name },
    };
  }
  const folder = join(root, 'drawings', stem);
  const plan = join(folder, 'plan.png');
  let size: { width: number; height: number };
  try {
    await mkdir(folder, { recursive: true });
    if (TIFF.has(ext)) {
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
  } catch (e) {
    // only what this import just made: its copy, and its folder when that is empty again
    await rm(join(root, src), { force: true }).catch(() => undefined);
    await rm(plan, { force: true }).catch(() => undefined);
    await rmdir(folder).catch(() => undefined);
    throw e;
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
 * pages, and listed. Only a drawing an import of this session staged and the window has not
 * closed takes pages: any other stem (a DXF's, a picture that is already a drawing) is refused,
 * so a page can never replace a drawing that is there. The same page again, while its drawing is
 * still open, replaces its picture and keeps its layer.
 */
export async function addDrawingPage(
  root: string,
  p: DrawingPage,
): Promise<{ manifest: ProjectManifest; layerId: string; backup: string }> {
  const size = imageSize(p.png);
  if (!size || p.png[1] !== 0x50) throw new Error('The page is not a PNG picture.');
  if (size.width > MAX_DRAWING_PX || size.height > MAX_DRAWING_PX) {
    throw new Error(
      `The page is ${String(size.width)} x ${String(size.height)} pixels; a drawing is at most ${String(MAX_DRAWING_PX)} pixels on a side.`,
    );
  }
  const open = staged.get(rootKey(root))?.get(p.stem);
  if (!open) throw new Error(`The drawing "${p.stem}" is not waiting for pages. Import it again.`);
  const many = (p.pages ?? 1) > 1 && p.page !== undefined;
  const stem = many ? `${p.stem}-p${String(p.page)}` : p.stem;
  const name = many ? `${p.name}, page ${String(p.page)}` : p.name;
  // read, list and save in one turn, on the manifest as it is by then (as an import's own save
  // does): a page is appended by its id, and pages added one after another never lose each other
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
  open.pages += 1;
  return { manifest: r.manifest, layerId: r.layerId, backup: r.backup };
}

/**
 * The app window is done with a staged drawing (`builder:closeDrawing`): every page asked for is
 * in, the person cancelled the page question, or the file could not be drawn. No more pages are
 * taken for it. When it got none, the copy the import made (`drawings/<stem>.<ext>`) is removed,
 * and only that copy; a stem that is not staged removes nothing.
 */
export async function closeDrawing(root: string, stem: string): Promise<{ removed: boolean }> {
  const waiting = staged.get(rootKey(root));
  const open = waiting?.get(stem);
  if (!waiting || !open) return { removed: false };
  waiting.delete(stem);
  if (waiting.size === 0) staged.delete(rootKey(root));
  if (open.pages > 0) return { removed: false };
  await rm(join(root, open.src), { force: true });
  return { removed: true };
}
