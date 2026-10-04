import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDetections, readPackageDetections, writeDetections } from './detections';
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

const NOW = '2026-10-05T10:00:00.000Z';
const detection = {
  id: 'd1',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [2560, 1708],
  geom: { type: 'box', x: 10, y: 20, w: 30, h: 40 },
  classId: 'moderate',
  severity: 2,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: {
    kind: 'ai',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    promptVersion: 'detect-v1',
    runId: 'r1',
  },
  confidence: 0.8,
  createdAt: NOW,
  updatedAt: NOW,
};
const file = { schema: 'aio.detections/1' as const, detections: [detection], runs: [] };

describe('detections.json', () => {
  it('is null before the first save, then round-trips with a backup', async () => {
    expect(await readDetections(base)).toEqual({ ok: true, file: null, readOnly: false });
    expect(await writeDetections(base, file)).toEqual({ ok: true });
    const r = await readDetections(base);
    expect(r.ok && r.file?.detections).toEqual([detection]);
    const second = { ...file, detections: [{ ...detection, status: 'rejected' }] };
    expect(await writeDetections(base, second)).toEqual({ ok: true });
    const bak = JSON.parse(
      await readFile(join(base, 'detections.json.bak'), 'utf8'),
    ) as typeof file;
    expect(bak.detections[0]?.status).toBe('draft');
  });

  it('refuses invalid contents and never overwrites the file with them', async () => {
    await writeDetections(base, file);
    const bad = { ...file, detections: [{ ...detection, status: 'accepted' }] };
    const w = await writeDetections(base, bad);
    expect(w.ok).toBe(false);
    expect(w.error).toContain('accepted but names no issue');
    const r = await readDetections(base);
    expect(r.ok && (r.file?.detections[0] as { status?: string } | undefined)?.status).toBe(
      'draft',
    );
  });

  it('reports a broken file with its path', async () => {
    await writeFile(
      join(base, 'detections.json'),
      '{"schema":"aio.detections/1","detections":[{"id":1}]}',
    );
    const r = await readDetections(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('detections.json');
  });

  it('reads a package read only', async () => {
    const archive = {
      entries: new Map([['detections.json', {}]]),
      read: () => Promise.resolve(Buffer.from(JSON.stringify(file))),
    };
    const r = await readPackageDetections(archive);
    expect(r).toMatchObject({ ok: true, readOnly: true });
    expect(await readPackageDetections({ entries: new Map(), read: archive.read })).toEqual({
      ok: true,
      file: null,
      readOnly: true,
    });
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
