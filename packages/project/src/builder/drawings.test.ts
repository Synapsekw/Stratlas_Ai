import { parseManifest, type ProjectManifest } from '@aio/schema';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng } from '../import/png';
import { createProject, updateLayers } from './create';
import {
  DRAWING_LONG_M,
  imageSize,
  placementFor,
  provisionalCorners,
  type DrawingPlacementFile,
} from './drawingPlacement';
import { addDrawingPage } from './drawings';
import { NO_PIPELINE, importRawFiles, type ImportDeps } from './raw';
import { makeTiff, withExif } from './testing';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-drawings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = (width: number, height: number): Uint8Array =>
  encodePng({ width, height, channels: 4, data: new Uint8Array(width * height * 4).fill(200) });

/** The image step of the tests: PNG in, PNG out (the app decodes with Electron). */
const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
  images: {
    resizeJpeg: (src, dst) => copyFile(src, dst),
    toPng: async (src, dst) => {
      const size = imageSize(new Uint8Array(await readFile(src)));
      await writeFile(dst, png(size?.width ?? 8, size?.height ?? 6));
      return size ?? { width: 8, height: 6 };
    },
  },
  jobs: NO_PIPELINE,
  utcOffsetMin: 180,
  ...over,
});

async function project(): Promise<string> {
  const r = await createProject(dir, {
    name: 'Drawings',
    type: 'inspection',
    epsg: 32639,
    origin: [221000, 3214000, 30],
    severityTemplate: null,
  });
  return r.root;
}

const manifest = async (root: string): Promise<ProjectManifest> => {
  const r = parseManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const placement = async (root: string, stem: string) =>
  JSON.parse(
    await readFile(join(root, 'drawings', stem, 'placement.json'), 'utf8'),
  ) as DrawingPlacementFile;

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('provisional placement of a picture', () => {
  it('centres the sheet on the origin, north up, 100 m on its long side', () => {
    const c = provisionalCorners(4000, 2000);
    expect(c.tl).toEqual([-50, 0, -25]);
    expect(c.tr).toEqual([50, 0, -25]);
    expect(c.bl).toEqual([-50, 0, 25]);
    const tall = provisionalCorners(1000, 4000);
    expect(tall.bl[2] - tall.tl[2]).toBe(DRAWING_LONG_M);
    expect(tall.tr[0] - tall.tl[0]).toBe(25);
  });

  it('writes a placement whose matrix takes pixels to the corners', () => {
    const c = provisionalCorners(4000, 2000);
    const p = placementFor('plan.png', c, 4000, 2000, true);
    expect(p).toMatchObject({
      schema: 'aio.drawingplacement/1',
      file: 'plan.png',
      units: 'px',
      unitM: 0.025,
      baseY: 0,
      provisional: true,
      sizePx: [4000, 2000],
    });
    const [a, b, cc, d, tx, tz] = p.matrix;
    const at = (x: number, y: number) => [a * x + b * y + tx, cc * x + d * y + tz];
    expect(at(0, 0)).toEqual([-50, -25]);
    expect(at(4000, 0)).toEqual([50, -25]);
    expect(at(0, 2000)).toEqual([-50, 25]);
  });

  it('reads the size of a PNG and of a JPEG from the file head', () => {
    expect(imageSize(png(31, 17))).toEqual({ width: 31, height: 17 });
    // SOI, APP0 (2 byte body), SOF0 with height 300 and width 400
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c,
      0x01, 0x90, 0x03,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('drawings from pictures (raw import)', () => {
  it('a PNG lands under drawings/ as a hidden plan raster with its placement', async () => {
    const root = await project();
    const file = join(dir, 'Site Layout.png');
    await writeFile(file, png(40, 20));
    const r = await importRawFiles(root, [file], deps());
    expect(r.items).toEqual([
      expect.objectContaining({
        file: 'Site Layout.png',
        kind: 'drawing',
        status: 'imported',
        layerId: 'sheet-site-layout',
      }),
    ]);
    expect(r.items[0]?.message).toContain('not placed');
    const layer = (await manifest(root)).layers.find((l) => l.id === 'sheet-site-layout');
    expect(layer).toMatchObject({
      kind: 'raster',
      name: 'Site Layout.png',
      visible: false,
      role: 'plan',
      format: 'image',
      src: { path: 'drawings/site-layout/plan.png' },
      corners: { tl: [-50, 0, -25], tr: [50, 0, -25], bl: [-50, 0, 25] },
    });
    expect(await exists(join(root, 'drawings', 'site-layout.png'))).toBe(true);
    expect(await exists(join(root, 'drawings', 'site-layout', 'plan.png'))).toBe(true);
    expect(await placement(root, 'site-layout')).toMatchObject({
      file: 'Site Layout.png',
      units: 'px',
      provisional: true,
      sizePx: [40, 20],
    });
  });

  it('the same file twice makes two drawings, never clobbering the first', async () => {
    const root = await project();
    const file = join(dir, 'plan.png');
    await writeFile(file, png(8, 8));
    await importRawFiles(root, [file], deps());
    const r = await importRawFiles(root, [file], deps());
    expect(r.items[0]?.layerId).toBe('sheet-plan-2');
    expect((await readdir(join(root, 'drawings'))).sort()).toEqual([
      'plan',
      'plan-2',
      'plan-2.png',
      'plan.png',
    ]);
  });

  it('a JPEG stays a photo, and is a drawing through Add drawing', async () => {
    const root = await project();
    const file = join(dir, 'scan.jpg');
    await writeFile(file, withExif({ width: 64, height: 48 }));
    const photo = await importRawFiles(root, [file], deps());
    expect(photo.items[0]).toMatchObject({ kind: 'photo', status: 'imported' });
    const drawing = await importRawFiles(root, [file], deps({ drawings: true }));
    expect(drawing.items[0]).toMatchObject({
      kind: 'drawing',
      status: 'imported',
      layerId: 'sheet-scan',
    });
    expect(await exists(join(root, 'drawings', 'scan.jpg'))).toBe(true);
  });

  it('a TIFF without a georeference becomes a drawing instead of failing', async () => {
    const root = await project();
    const file = join(dir, 'scan.tif');
    await writeFile(
      file,
      makeTiff(
        { width: 4, height: 2, samples: 3, bits: 8, values: new Array<number>(24).fill(90) },
        deflateSync,
      ),
    );
    const r = await importRawFiles(root, [file], deps());
    expect(r.items[0]).toMatchObject({
      kind: 'drawing',
      status: 'imported',
      layerId: 'sheet-scan',
    });
    const plan = new Uint8Array(await readFile(join(root, 'drawings', 'scan', 'plan.png')));
    expect(imageSize(plan)).toEqual({ width: 4, height: 2 });
  });

  it('a PDF is copied in and waits for the app window to draw its pages', async () => {
    const root = await project();
    const file = join(dir, 'GA Drawings.pdf');
    await writeFile(file, '%PDF-1.4\n');
    const r = await importRawFiles(root, [file], deps());
    expect(r.items).toEqual([
      {
        file: 'GA Drawings.pdf',
        kind: 'drawing',
        status: 'queued',
        message: 'Reading the pages.',
        drawing: { stem: 'ga-drawings', src: 'drawings/ga-drawings.pdf', name: 'GA Drawings.pdf' },
      },
    ]);
    expect(await readFile(join(root, 'drawings', 'ga-drawings.pdf'), 'utf8')).toBe('%PDF-1.4\n');
    // nothing is listed until a page arrives
    expect((await manifest(root)).layers).toEqual([]);
    expect(r.backup).toBe('');
  });

  it('refuses a picture too large to decode, with its size', async () => {
    const root = await project();
    const file = join(dir, 'huge.png');
    const head = png(1, 1);
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    v.setUint32(16, 30000);
    v.setUint32(20, 20000);
    await writeFile(file, head);
    const r = await importRawFiles(root, [file], deps());
    expect(r.items[0]).toMatchObject({ kind: 'drawing', status: 'error' });
    expect(r.items[0]?.message).toContain('30000 x 20000');
  });

  it('says which drawing formats work when a DWG is dropped', async () => {
    const root = await project();
    const file = join(dir, 'plan.dwg');
    await writeFile(file, 'AC1032');
    const r = await importRawFiles(root, [file], deps());
    expect(r.items[0]).toMatchObject({ kind: 'drawing', status: 'skipped' });
    expect(r.items[0]?.message).toBe(
      'DWG is not supported. Save the drawing as DXF or PDF, or as a PNG picture, then import that.',
    );
  });
});

describe('addDrawingPage', () => {
  const staged = async (root: string) => {
    const file = join(dir, 'sheets.pdf');
    await writeFile(file, '%PDF-1.4\n');
    const r = await importRawFiles(root, [file], deps());
    const d = r.items[0]?.drawing;
    if (!d) throw new Error('not staged');
    return d;
  };

  it('a one page drawing takes the stem itself', async () => {
    const root = await project();
    const d = await staged(root);
    const r = await addDrawingPage(root, { ...d, png: png(30, 20) });
    expect(r.layerId).toBe('sheet-sheets');
    expect(r.manifest.layers.find((l) => l.id === r.layerId)).toMatchObject({
      name: 'sheets.pdf',
      visible: false,
      role: 'plan',
      format: 'image',
      src: { path: 'drawings/sheets/plan.png' },
    });
    expect(await placement(root, 'sheets')).toMatchObject({ sizePx: [30, 20], provisional: true });
  });

  it('each page of a longer file is its own drawing, named by its page', async () => {
    const root = await project();
    const d = await staged(root);
    await addDrawingPage(root, { ...d, page: 1, pages: 3, png: png(30, 20) });
    const r = await addDrawingPage(root, { ...d, page: 3, pages: 3, png: png(20, 30) });
    expect(r.layerId).toBe('sheet-sheets-p3');
    expect(r.manifest.layers.map((l) => [l.id, l.name])).toEqual([
      ['sheet-sheets-p1', 'sheets.pdf, page 1'],
      ['sheet-sheets-p3', 'sheets.pdf, page 3'],
    ]);
    expect(await placement(root, 'sheets-p3')).toMatchObject({ sizePx: [20, 30], page: 3 });
  });

  it('the same page again replaces its picture and keeps one layer', async () => {
    const root = await project();
    const d = await staged(root);
    await addDrawingPage(root, { ...d, png: png(30, 20) });
    const r = await addDrawingPage(root, { ...d, png: png(60, 40) });
    expect(r.manifest.layers).toHaveLength(1);
    expect(await placement(root, 'sheets')).toMatchObject({ sizePx: [60, 40] });
  });

  it('refuses what is not a PNG, and a drawing that was never staged', async () => {
    const root = await project();
    const d = await staged(root);
    await expect(addDrawingPage(root, { ...d, png: new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      'not a PNG',
    );
    await expect(addDrawingPage(root, { ...d, stem: 'other', png: png(4, 4) })).rejects.toThrow(
      'was not imported',
    );
  });
});

describe('placing a drawing (the corners patch)', () => {
  const corners = {
    tl: [10, 2, -40] as [number, number, number],
    tr: [90, 2, -40] as [number, number, number],
    bl: [10, 2, 0] as [number, number, number],
  };

  it('moves the picture, shows it and marks its placement as placed', async () => {
    const root = await project();
    const file = join(dir, 'plan.png');
    await writeFile(file, png(40, 20));
    await importRawFiles(root, [file], deps());
    const r = await updateLayers(root, ['sheet-plan'], { corners });
    expect(r.manifest.layers[0]).toMatchObject({ corners, visible: true });
    const p = await placement(root, 'plan');
    expect(p.provisional).toBe(false);
    expect(p.baseY).toBe(2);
    expect(p.unitM).toBe(2);
    expect(p.matrix).toEqual([2, 0, 0, 2, 10, -40]);
  });

  it('refuses a layer that is not an image raster', async () => {
    const root = await project();
    const glb = join(dir, 'pad.glb');
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}]}  ');
    const out = new Uint8Array(20 + json.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, out.length, true);
    v.setUint32(12, json.length, true);
    v.setUint32(16, 0x4e4f534a, true);
    out.set(json, 20);
    await writeFile(glb, out);
    await importRawFiles(root, [glb], deps());
    await expect(updateLayers(root, ['mesh-pad'], { corners })).rejects.toThrow(
      'only a picture laid on the ground takes corners',
    );
  });
});
