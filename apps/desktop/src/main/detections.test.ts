import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectManifest, SCHEMA_VERSION, type DetectionsFile } from '@aio/schema';
import {
  folderFiles,
  imageSize,
  packageFiles,
  parseIssuesMap,
  readDetectionPasses,
  writeDetectionPass,
} from './detections';
import {
  createMaskAssist,
  encoderInput,
  findSamModel,
  SAM_SIZE,
  type OrtLike,
  type OrtSession,
  type OrtTensor,
} from './maskAssist';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-det-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const manifest = ProjectManifest.parse({
  schema: SCHEMA_VERSION,
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      items: [
        { id: 'p001', src: { path: 'photos/p001.jpg' } },
        { id: 'p002', src: { path: 'photos/p002.png' } },
      ],
    },
  ],
  severityModels: [],
  classCatalogues: [],
});

/** A JPEG header with an APP1 block before the SOF0 frame (width x height). */
function jpegHeader(width: number, height: number): Buffer {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(20)]);
}

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const ai = {
  schema: 'aio.detections/1' as const,
  source: 'ai' as const,
  detections: [
    { id: 'a1', photo: 'p001', class: 'corrosion', status: 'draft', bbox: [1, 2, 30, 40] },
    { id: 'a2', photo: 'p002', class: 'corrosion', bbox: [0, 0, 0.5, 0.5], space: 'normalized' },
  ],
};

describe('detection passes (detections/*.json)', () => {
  async function project() {
    await mkdir(join(base, 'detections'), { recursive: true });
    await mkdir(join(base, 'photos'), { recursive: true });
    await mkdir(join(base, 'inspection'), { recursive: true });
    await writeFile(join(base, 'photos', 'p001.jpg'), jpegHeader(2560, 1708));
    await writeFile(join(base, 'photos', 'p002.png'), pngHeader(800, 600));
    await writeFile(join(base, 'detections', 'ai-run.json'), JSON.stringify(ai));
    await writeFile(join(base, 'detections', 'kit.json'), JSON.stringify([{ image: 'p001.jpg' }]));
    await writeFile(join(base, 'detections', 'bad.json'), '{"schema":"aio.detections/1"}');
    await writeFile(join(base, 'detections', 'notes.txt'), 'x');
    await writeFile(
      join(base, 'inspection', 'issues-map.json'),
      JSON.stringify({
        schema: 'aio.inspection-issues/1',
        issues: { 'insp-1': { detections: ['a2'], hash: 'h' } },
      }),
    );
  }

  it('reads every pass, reports the rest, sizes preview photos and the pipeline map', async () => {
    await project();
    const r = await readDetectionPasses(folderFiles(base), manifest, false);
    if (!r.ok) throw new Error(r.error);
    expect(r.files.map((f) => f.name)).toEqual(['ai-run.json']);
    expect(r.problems.map((p) => p.name).sort()).toEqual(['bad.json', 'kit.json']);
    // only the preview-space photo needs its size; the normalized one does not
    expect(r.sizes).toEqual({ 'photos/p001': [2560, 1708] });
    expect(r.issuesMap).toEqual({ 'insp-1': ['a2'] });
    expect(r.readOnly).toBe(false);
  });

  it('writes one pass atomically with a backup, nothing else', async () => {
    await project();
    const next = { ...ai, detections: [{ ...ai.detections[0], status: 'rejected' }] };
    expect(
      await writeDetectionPass(base, 'ai-run.json', next as unknown as DetectionsFile),
    ).toEqual({ ok: true });
    const saved = JSON.parse(await readFile(join(base, 'detections', 'ai-run.json'), 'utf8')) as {
      detections: { status: string }[];
    };
    expect(saved.detections.map((d) => d.status)).toEqual(['rejected']);
    const bak = JSON.parse(
      await readFile(join(base, 'detections', 'ai-run.json.bak'), 'utf8'),
    ) as typeof ai;
    expect(bak.detections).toHaveLength(2);
    expect(await readFile(join(base, 'detections', 'kit.json'), 'utf8')).toContain('p001.jpg');
  });

  it('refuses a pass saved by a newer version and never writes over it', async () => {
    await project();
    const newer = `${JSON.stringify({ ...ai, schema: 'aio.detections/2', extra: true }, null, 2)}\n`;
    const file = join(base, 'detections', 'newer.json');
    await writeFile(file, newer);
    const message =
      'detections/newer.json was saved by a newer version of Quadrion AI (aio.detections/2). Update the app to open it. The file was not changed.';
    const r = await readDetectionPasses(folderFiles(base), manifest, false);
    if (!r.ok) throw new Error(r.error);
    // the current pass still reads
    expect(r.files.map((f) => f.name)).toEqual(['ai-run.json']);
    expect(r.problems.find((p) => p.name === 'newer.json')).toEqual({
      name: 'newer.json',
      error: message,
    });
    expect(await writeDetectionPass(base, 'newer.json', ai as unknown as DetectionsFile)).toEqual({
      ok: false,
      error: message,
    });
    expect(await readFile(file, 'utf8')).toBe(newer);
    await expect(readFile(`${file}.bak`)).rejects.toThrow();
  });

  it('reads a package read only, sizes from its members', async () => {
    const members = new Map<string, Buffer>([
      ['detections/ai-run.json', Buffer.from(JSON.stringify(ai))],
      ['photos/p001.jpg', jpegHeader(640, 480)],
    ]);
    const archive = {
      entries: members,
      read: (n: string) => Promise.resolve(members.get(n) ?? Buffer.alloc(0)),
    };
    const r = await readDetectionPasses(packageFiles(archive), manifest, true);
    expect(r).toMatchObject({ ok: true, readOnly: true, sizes: { 'photos/p001': [640, 480] } });
  });

  it('reads image sizes from JPEG and PNG headers', () => {
    expect(imageSize(jpegHeader(4000, 3000))).toEqual([4000, 3000]);
    expect(imageSize(pngHeader(10, 20))).toEqual([10, 20]);
    expect(imageSize(Buffer.from('nope'))).toBeNull();
    expect(parseIssuesMap({ issues: { a: { detections: ['x', 1] } } })).toEqual({ a: ['x'] });
  });
});

describe('mask assist seam', () => {
  async function pack(withModel: boolean): Promise<string> {
    const dir = join(base, 'pack');
    await mkdir(join(dir, 'models', 'sam'), { recursive: true });
    if (withModel) {
      await writeFile(join(dir, 'models', 'sam', 'encoder.onnx'), 'x');
      await writeFile(join(dir, 'models', 'sam', 'decoder.onnx'), 'x');
      await writeFile(join(dir, 'models', 'sam', 'model.json'), '{"name":"MobileSAM test"}');
    }
    return dir;
  }

  it('is unavailable without a model or without the runtime', async () => {
    const empty = await pack(false);
    expect(await findSamModel(empty)).toBeNull();
    expect(await findSamModel(null)).toBeNull();
    const none = createMaskAssist({
      packDir: () => Promise.resolve(empty),
      loadRuntime: () => Promise.resolve(null),
      decode: () => Promise.reject(new Error('unused')),
    });
    expect(await none.status()).toEqual({ available: false, reason: 'no-model' });
    expect(await none.segment('p.jpg', [0, 0, 10, 10])).toEqual({
      ok: false,
      error: 'No mask model is installed in the pipeline pack.',
    });
    const dir = await pack(true);
    const noRuntime = createMaskAssist({
      packDir: () => Promise.resolve(dir),
      loadRuntime: () => Promise.resolve(null),
      decode: () => Promise.reject(new Error('unused')),
    });
    expect(await noRuntime.status()).toEqual({ available: false, reason: 'no-runtime' });
  });

  it('runs encoder then decoder and outlines the best mask in photo pixels', async () => {
    const dir = await pack(true);
    const W = 200;
    const H = 100;
    let encodes = 0;
    const tensor = (data: Float32Array, dims: readonly number[]): OrtTensor => ({ data, dims });
    const encoder: OrtSession = {
      inputNames: ['image'],
      outputNames: ['image_embeddings'],
      run: (feeds) => {
        encodes++;
        expect(feeds.image?.dims).toEqual([1, 3, SAM_SIZE, SAM_SIZE]);
        return Promise.resolve({ image_embeddings: tensor(new Float32Array(4), [1, 1, 2, 2]) });
      },
    };
    const decoder: OrtSession = {
      inputNames: [
        'image_embeddings',
        'point_coords',
        'point_labels',
        'mask_input',
        'has_mask_input',
        'orig_im_size',
      ],
      outputNames: ['masks', 'iou_predictions', 'low_res_masks'],
      run: (feeds) => {
        expect(Array.from(feeds.point_labels?.data ?? [])).toEqual([2, 3]);
        expect(Array.from(feeds.orig_im_size?.data ?? [])).toEqual([H, W]);
        // mask 0 empty, mask 1 a rectangle x 50..149, y 20..59; mask 1 has the better IoU
        const data = new Float32Array(2 * W * H).fill(-1);
        for (let y = 20; y < 60; y++) for (let x = 50; x < 150; x++) data[W * H + y * W + x] = 1;
        return Promise.resolve({
          masks: tensor(data, [1, 2, H, W]),
          iou_predictions: tensor(new Float32Array([0.1, 0.9]), [1, 2]),
        });
      },
    };
    const ort: OrtLike = {
      InferenceSession: {
        create: (p: string) => Promise.resolve(p.endsWith('encoder.onnx') ? encoder : decoder),
      },
      Tensor: class {
        constructor(
          _type: 'float32',
          public data: Float32Array,
          public dims: readonly number[],
        ) {}
      },
    };
    const assist = createMaskAssist({
      packDir: () => Promise.resolve(dir),
      loadRuntime: () => Promise.resolve(ort),
      decode: () =>
        Promise.resolve({
          width: W,
          height: H,
          scaledWidth: 4,
          scaledHeight: 2,
          rgba: new Uint8Array(32),
        }),
    });
    expect(await assist.status()).toEqual({ available: true, model: 'MobileSAM test' });
    const r = await assist.segment('photos/p001.jpg', [40, 10, 120, 60]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const xs = r.points.map((p) => p[0]);
    const ys = r.points.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(50.5);
    expect(Math.max(...xs)).toBe(149.5);
    expect(Math.min(...ys)).toBe(20.5);
    expect(Math.max(...ys)).toBe(59.5);
    await assist.segment('photos/p001.jpg', [0, 0, 10, 10]);
    expect(encodes).toBe(1);
  });

  it('normalises and pads the encoder input', () => {
    const rgba = new Uint8Array([255, 0, 0, 255]);
    const t = encoderInput({ width: 1, height: 1, scaledWidth: 1, scaledHeight: 1, rgba });
    expect(t[0]).toBeCloseTo((255 - 123.675) / 58.395);
    expect(t[1]).toBeCloseTo(-123.675 / 58.395);
    expect(t[SAM_SIZE * SAM_SIZE]).toBeCloseTo(-116.28 / 57.12);
  });
});
