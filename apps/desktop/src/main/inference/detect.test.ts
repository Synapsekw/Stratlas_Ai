import { describe, expect, it } from 'vitest';
import { detectImage, type RunModel } from './detect';
import {
  markerCard,
  markerDetectorOnnx,
  markerPhotoRgba,
  type MarkerPatch,
} from './fixtures/markerDetector';
import { realOrt } from './fixtures/realOrt';

const ort = realOrt();

async function markerRun(provider = 'cpu'): Promise<RunModel> {
  if (!ort) throw new Error('no runtime');
  const session = await ort.InferenceSession.create(markerDetectorOnnx(), {
    executionProviders: [provider],
  });
  return async ({ data, dims }) => {
    const out = await session.run({ images: new ort.Tensor('float32', data, dims) });
    return session.outputNames.map((name) => {
      const t = out[name];
      if (!t) throw new Error(`no output ${name}`);
      return { name, dims: t.dims, data: t.data };
    });
  };
}

const card = markerCard(markerDetectorOnnx());
const photo = (w: number, h: number, patches: MarkerPatch[]) => ({
  width: w,
  height: h,
  rgba: markerPhotoRgba(w, h, patches),
});
const boxesOf = (r: Awaited<ReturnType<typeof detectImage>>) =>
  r.map((b) => ({ cls: b.cls, box: [b.x0, b.y0, b.x1, b.y1].map(Math.round) }));

describe.skipIf(!ort)('the synthetic marker detector, run by onnxruntime', () => {
  it('finds each patch once with its exact box and class', async () => {
    const run = await markerRun();
    const found = await detectImage(
      photo(320, 320, [
        { cls: 'marker', box: [40, 50, 72, 82] },
        { cls: 'cyan-marker', box: [200, 210, 230, 250] },
      ]),
      { card, minConfidence: 0.5 },
      run,
    );
    expect(boxesOf(found)).toEqual([
      { cls: 1, box: [200, 210, 230, 250] },
      { cls: 0, box: [40, 50, 72, 82] },
    ]);
  });

  it('letterboxes a larger photo and maps the boxes back (within 2 px)', async () => {
    const run = await markerRun();
    const found = await detectImage(
      photo(640, 480, [{ cls: 'marker', box: [100, 120, 164, 184] }]),
      { card, minConfidence: 0.5 },
      run,
    );
    expect(found).toHaveLength(1);
    const b = found[0];
    expect(
      b &&
        [b.x0, b.y0, b.x1, b.y1].every((v, i) => Math.abs(v - ([100, 120, 164, 184][i] ?? 0)) <= 2),
    ).toBe(true);
  });

  it('keeps a patch across a tile seam once', async () => {
    const run = await markerRun();
    // tiles of 320 with 64 overlap start at x 0, 256 and 320: the patch crosses the seam at 320
    const found = await detectImage(
      photo(640, 320, [{ cls: 'marker', box: [300, 100, 332, 132] }]),
      { card, minConfidence: 0.5, tile: { size: 320, overlap: 64 } },
      run,
    );
    expect(boxesOf(found)).toEqual([{ cls: 0, box: [300, 100, 332, 132] }]);
  });

  it('runs wrapping tiles across the seam of a 360 frame and finds a split patch whole', async () => {
    const run = await markerRun();
    // one patch cut by the seam (x 980 to 1000 and 0 to 20), one in the middle
    const frame = photo(1000, 320, [
      { cls: 'marker', box: [980, 100, 1000, 132] },
      { cls: 'marker', box: [0, 100, 20, 132] },
      { cls: 'cyan-marker', box: [500, 150, 524, 182] },
    ]);
    const tile = { size: 320, overlap: 64 };
    const wrapped = await detectImage(frame, { card, minConfidence: 0.5, tile, wrap: true }, run);
    expect(boxesOf(wrapped)).toEqual([
      { cls: 0, box: [980, 100, 1020, 132] },
      { cls: 1, box: [500, 150, 524, 182] },
    ]);
    // without wrapping the seam halves stay apart
    const plain = await detectImage(frame, { card, minConfidence: 0.5, tile }, run);
    expect(plain.filter((b) => b.cls === 0)).toHaveLength(2);
  });

  it('scales boxes to photo pixels when the photo arrived scaled', async () => {
    const run = await markerRun();
    const found = await detectImage(
      photo(320, 320, [{ cls: 'marker', box: [40, 50, 72, 82] }]),
      { card, minConfidence: 0.5, scale: 0.5 },
      run,
    );
    expect(boxesOf(found)).toEqual([{ cls: 0, box: [80, 100, 144, 164] }]);
  });

  it('finds nothing on a photo without patches', async () => {
    const run = await markerRun();
    expect(await detectImage(photo(320, 320, []), { card, minConfidence: 0.25 }, run)).toEqual([]);
  });
});

const gpu = (ort?.listSupportedBackends?.() ?? [])
  .map((b) => b.name)
  .find(
    (n) =>
      (process.platform === 'win32' && n === 'dml') ||
      (process.platform === 'darwin' && n === 'coreml'),
  );

describe.skipIf(!ort || !gpu)('the GPU provider against the CPU', () => {
  it('finds the same boxes (within 1 px)', async () => {
    const img = photo(320, 320, [
      { cls: 'marker', box: [40, 50, 72, 82] },
      { cls: 'cyan-marker', box: [200, 210, 230, 250] },
    ]);
    const cpu = await detectImage(img, { card, minConfidence: 0.5 }, await markerRun('cpu'));
    let other;
    try {
      other = await detectImage(img, { card, minConfidence: 0.5 }, await markerRun(gpu));
    } catch {
      // no usable device on this machine (a remote session, a VM): nothing to compare
      return;
    }
    expect(other.map((b) => b.cls)).toEqual(cpu.map((b) => b.cls));
    other.forEach((b, i) => {
      const c = cpu[i];
      expect(
        c && Math.max(...[b.x0 - c.x0, b.y0 - c.y0, b.x1 - c.x1, b.y1 - c.y1].map(Math.abs)),
      ).toBeLessThanOrEqual(1);
    });
  });
});
