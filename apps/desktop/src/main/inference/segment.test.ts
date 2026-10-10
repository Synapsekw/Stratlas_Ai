import type { Vec2 } from '@aio/schema';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrtLike } from '../maskAssist';
import { colourSegmenterOnnx } from './fixtures/colourSegmenter';
import { realOrt } from './fixtures/realOrt';
import {
  bestMask,
  bufferMask,
  createSegmenter,
  decoderFeeds,
  encoderTensor,
  fillHoles,
  findSegmentModel,
  maskRing,
  reduceRing,
  regionAt,
  resizeRgb,
  SAM_SIZE,
  touchesEdge,
} from './segment';

const disc = (W: number, cx: number, cy: number, r: number) => {
  const data = new Uint8Array(W * W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) data[y * W + x] = 1;
  return { width: W, height: W, data };
};
const count = (m: { data: Uint8Array }) => m.data.reduce((s, v) => s + (v ? 1 : 0), 0);

/** Area of a closed ring (shoelace). */
const ringArea = (ring: readonly Vec2[]) =>
  Math.abs(
    ring.reduce((s, p, i) => {
      const q = ring[(i + 1) % ring.length] ?? p;
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2,
  );

describe('mask clean-up', () => {
  it('keeps the region under the click, or the nearest one', () => {
    const a = disc(64, 16, 16, 6);
    const b = disc(64, 48, 48, 8);
    const both = { width: 64, height: 64, data: a.data.map((v, i) => v | (b.data[i] ?? 0)) };
    expect(count(regionAt(both, [16, 16]))).toBe(count(a));
    expect(count(regionAt(both, [60, 40]))).toBe(count(b));
    expect(count(regionAt({ width: 4, height: 4, data: new Uint8Array(16) }, [1, 1]))).toBe(0);
  });

  it('fills holes but not bays open to the edge', () => {
    const m = disc(32, 16, 16, 10);
    m.data[16 * 32 + 16] = 0;
    m.data[16 * 32 + 17] = 0;
    expect(count(fillHoles(m))).toBe(count(disc(32, 16, 16, 10)));
  });

  it('grows and shrinks by about the buffer distance', () => {
    const m = disc(128, 64, 64, 20);
    const grown = count(bufferMask(m, 5));
    const shrunk = count(bufferMask(m, -5));
    expect(grown / (Math.PI * 25 * 25)).toBeGreaterThan(0.9);
    expect(grown / (Math.PI * 25 * 25)).toBeLessThan(1.12);
    expect(shrunk / (Math.PI * 15 * 15)).toBeGreaterThan(0.88);
    expect(shrunk / (Math.PI * 15 * 15)).toBeLessThan(1.12);
    expect(bufferMask(m, 0)).toBe(m);
  });

  it('says when the outline reaches the crop edge', () => {
    expect(touchesEdge(disc(32, 16, 16, 8))).toBe(false);
    expect(touchesEdge(disc(32, 2, 16, 8))).toBe(true);
  });

  it('outlines a disc and reduces it to the asked vertex count', () => {
    const m = disc(200, 100, 100, 60);
    const ring = maskRing(m);
    expect(ring).not.toBeNull();
    expect(Math.abs(ringArea(ring ?? []) / (Math.PI * 3600) - 1)).toBeLessThan(0.03);
    const eight = maskRing(m, 8) ?? [];
    expect(eight).toHaveLength(8);
    expect(ringArea(eight) / (Math.PI * 3600)).toBeGreaterThan(0.85);
    expect(reduceRing(eight, 2)).toHaveLength(3);
    expect(maskRing({ width: 3, height: 3, data: new Uint8Array(9) })).toBeNull();
  });
});

describe('tensors', () => {
  it('lays the image out as the card says', () => {
    const rgb = new Uint8Array(SAM_SIZE * SAM_SIZE * 3).fill(255);
    const hwc = encoderTensor('hwc-255', rgb);
    expect(hwc.dims).toEqual([SAM_SIZE, SAM_SIZE, 3]);
    expect(hwc.data[0]).toBe(255);
    const nchw = encoderTensor('nchw-imagenet', rgb);
    expect(nchw.dims).toEqual([1, 3, SAM_SIZE, SAM_SIZE]);
    expect(nchw.data[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
  });

  it('scales a smaller crop up to the model size', () => {
    const rgb = new Uint8Array(2 * 2 * 3);
    rgb.set([0, 0, 0, 100, 100, 100, 0, 0, 0, 100, 100, 100]);
    const big = resizeRgb(rgb, 2, 4);
    expect(big).toHaveLength(4 * 4 * 3);
    expect(big[0]).toBe(0);
    expect(big[3 * 3]).toBe(100);
    expect(resizeRgb(rgb, 2, 2)).toBe(rgb);
  });

  it('feeds the click, then the add and remove clicks, then the padding point', () => {
    const ort = {
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[],
        ) {}
      },
    } as unknown as OrtLike;
    const emb = { data: new Float32Array(1), dims: [1] };
    const one = decoderFeeds(ort, emb, [10, 20]);
    expect(Array.from(one.point_coords?.data ?? [])).toEqual([10, 20, 0, 0]);
    expect(Array.from(one.point_labels?.data ?? [])).toEqual([1, -1]);
    const more = decoderFeeds(
      ort,
      emb,
      [10, 20],
      [
        { at: [30, 40], include: false },
        { at: [50, 60], include: true },
      ],
    );
    expect(more.point_coords?.dims).toEqual([1, 4, 2]);
    expect(Array.from(more.point_coords?.data ?? [])).toEqual([10, 20, 30, 40, 50, 60, 0, 0]);
    expect(Array.from(more.point_labels?.data ?? [])).toEqual([1, 0, 1, -1]);
  });

  it('picks the mask with the best predicted IoU and scales it to the model size', () => {
    const lo = new Float32Array(2 * 4 * 4).fill(-1);
    lo.fill(1, 16, 16 + 4); // the second mask: its top row
    const got = bestMask(
      { data: lo, dims: [1, 2, 4, 4] },
      { data: new Float32Array([0.2, 0.7]), dims: [1, 2] },
    );
    expect(got?.score).toBeCloseTo(0.7, 5);
    expect(count(got?.mask ?? { data: new Uint8Array() })).toBe(SAM_SIZE * (SAM_SIZE / 4));
    expect(bestMask({ data: lo, dims: [2, 16] }, undefined)).toBeNull();
  });
});

describe('the pack model', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-seg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function pack(card: Record<string, string> | null): Promise<string> {
    const sam = join(dir, 'models', 'sam');
    await mkdir(sam, { recursive: true });
    const m = colourSegmenterOnnx();
    await writeFile(join(sam, 'encoder.onnx'), m.encoder);
    await writeFile(join(sam, 'decoder.onnx'), m.decoder);
    if (card) await writeFile(join(sam, 'model.json'), JSON.stringify(card));
    return dir;
  }

  it('says what is missing: the pack, the model, an accepted licence', async () => {
    expect(await findSegmentModel(null)).toEqual({ ok: false, reason: 'no-pack' });
    expect(await findSegmentModel(dir)).toEqual({ ok: false, reason: 'no-model' });
    await pack(null);
    expect(await findSegmentModel(dir)).toMatchObject({ ok: false, reason: 'licence' });
    await pack({ name: 'X', licence: 'CC-BY-NC-4.0' });
    expect(await findSegmentModel(dir)).toMatchObject({ ok: false, reason: 'licence' });
    await pack(colourSegmenterOnnx().card);
    expect(await findSegmentModel(dir)).toMatchObject({
      ok: true,
      model: { card: { name: 'Colour test segmenter', input: 'hwc-255', licence: 'MIT' } },
    });
  });

  it('is unavailable with the reason when there is no pack or no runtime', async () => {
    const none = createSegmenter({
      packDir: () => Promise.resolve(null),
      loadRuntime: () => Promise.resolve(null),
    });
    expect(await none.status()).toEqual({ available: false, reason: 'no-pack' });
    const r = await none.suggest({
      click: [0, 0],
      crop: { key: 'k', size: 64, x0: 0, y1: 0, res: 1 },
    });
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    if (!r.ok) expect(r.error).toMatch(/needs the pipeline pack/);
    await pack(colourSegmenterOnnx().card);
    const noRt = createSegmenter({
      packDir: () => Promise.resolve(dir),
      loadRuntime: () => Promise.resolve(null),
    });
    expect(await noRt.status()).toEqual({ available: false, reason: 'no-runtime' });
  });

  const ort = realOrt();
  it.runIf(ort)('outlines a pile on a synthetic ortho through onnxruntime', async () => {
    await pack(colourSegmenterOnnx().card);
    const seg = createSegmenter({
      packDir: () => Promise.resolve(dir),
      loadRuntime: () => Promise.resolve(ort as unknown as OrtLike),
    });
    expect(await seg.status()).toEqual({ available: true, model: 'Colour test segmenter 1' });
    // a 512 px crop at 0.1 m: sand, a grey pile of 12 m radius at (500020, 2800030), shaded,
    // and a reddish neighbour touching it
    const size = 512;
    const res = 0.1;
    const x0 = 500_000;
    const y1 = 2_800_050;
    const rgb = new Uint8Array(size * size * 3);
    const pile = { e: 500_020, n: 2_800_030, r: 12 };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const e = x0 + (x + 0.5) * res;
        const n = y1 - (y + 0.5) * res;
        const d = Math.hypot(e - pile.e, n - pile.n);
        const shade = 0.6 + (0.5 * ((x + y) % 7)) / 7;
        let c = [214, 190, 150];
        if (d <= pile.r) c = [120 * shade, 120 * shade, 126 * shade];
        else if (Math.hypot(e - 500_040, n - 2_800_030) <= 8.5) c = [200, 110, 90];
        rgb.set(
          c.map((v) => Math.round(v)),
          (y * size + x) * 3,
        );
      }
    }
    const crop = { key: 'ortho@1', size, x0, y1, res, rgb };
    const first = await seg.suggest({ click: [pile.e + 3, pile.n - 2], crop });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.touchesEdge).toBe(false);
    expect(first.score).toBeCloseTo(0.9, 5);
    expect(Math.abs(ringArea(first.ring) / (Math.PI * 144) - 1)).toBeLessThan(0.06);
    for (const [e, n] of first.ring)
      expect(Math.hypot(e - pile.e, n - pile.n)).toBeLessThan(pile.r + 0.6);
    // the same crop again without its pixels: a buffer of 10 crop pixels (1 m) and 12 vertices
    const second = await seg.suggest({
      click: [pile.e, pile.n],
      crop: { ...crop, rgb: undefined },
      bufferPx: 10,
      vertices: 12,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ring).toHaveLength(12);
    expect(ringArea(second.ring)).toBeGreaterThan(ringArea(first.ring) * 1.1);
    // a Remove area click is passed on (the fixture model reads the first click only), and one
    // outside the crop is ignored
    const refined = await seg.suggest({
      click: [pile.e, pile.n],
      crop: { ...crop, rgb: undefined },
      refine: [
        { at: [500_040, 2_800_030], include: false },
        { at: [x0 - 100, y1], include: true },
      ],
    });
    expect(refined.ok).toBe(true);
    if (refined.ok)
      expect(Math.abs(ringArea(refined.ring) / ringArea(first.ring) - 1)).toBeLessThan(0.01);
    // another crop without pixels is stale; a click outside the crop is refused
    expect(
      await seg.suggest({
        click: [pile.e, pile.n],
        crop: { ...crop, key: 'other', rgb: undefined },
      }),
    ).toMatchObject({ ok: false, code: 'stale' });
    expect(await seg.suggest({ click: [x0 - 5, y1], crop })).toMatchObject({
      ok: false,
      code: 'nothing',
    });
  });
});
