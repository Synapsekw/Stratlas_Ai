import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DetectorModelCard } from '../../packages/schema/src/inference.ts';
import {
  MARKER_RGB,
  buildMarkerDetector,
  buildWrongLayoutDetector,
  corruptOnnx,
  decodeOnnx,
  markerImage,
  onnxStrings,
  postprocessYoloV8,
  runOnnx,
} from './onnx-test-model.mjs';

/** The image as the card asks for it: NCHW, RGB, divided by 255. */
function tensorOf(rgb, w, h) {
  const t = new Float32Array(3 * w * h);
  for (let i = 0; i < w * h; i++)
    for (let c = 0; c < 3; c++) t[c * w * h + i] = rgb[3 * i + c] / 255;
  return { dims: [1, 3, h, w], data: t };
}

describe('marker test detector (ONNX from plain operators)', () => {
  const { onnx, card } = buildMarkerDetector();

  it('has a valid model card with an SPDX licence and the file hash', () => {
    const r = DetectorModelCard.safeParse(card);
    expect(r.success).toBe(true);
    expect(card.licence).toBe('MIT');
    expect(card.layout).toBe('yolo-v8');
    expect(card.classes).toEqual(['marker']);
    expect(card.sha256).toBe(createHash('sha256').update(onnx).digest('hex'));
  });

  it('is the same bytes every time', () => {
    expect(buildMarkerDetector().onnx.equals(onnx)).toBe(true);
  });

  it('decodes as an ONNX model (opset 13, one input, YOLOv8 output) with no weights', () => {
    const m = decodeOnnx(onnx);
    expect(m.irVersion).toBe(7);
    expect(m.opset).toEqual([{ domain: '', version: 13 }]);
    expect(m.graph.inputs).toEqual([{ name: 'images', elemType: 1, shape: [1, 3, 640, 640] }]);
    expect(m.graph.outputs).toEqual([{ name: 'output0', elemType: 1, shape: [1, 5, 361] }]);
    const ops = new Set(m.graph.nodes.map((n) => n.opType));
    for (const op of ['Split', 'Greater', 'MaxPool', 'AveragePool', 'Concat'])
      expect(ops).toContain(op);
    // only tiny constants: thresholds, shapes, scalars
    expect(onnx.length).toBeLessThan(8000);
    expect(onnxStrings(onnx).join(' ')).toContain('Quadrion AI test fixture');
  });

  it('finds every seeded marker with its exact box, and nothing else', () => {
    const W = 640;
    const markers = [
      { x: 40, y: 50, size: 12 },
      { x: 300, y: 310, size: 20 },
      { x: 520, y: 90, size: 28 },
      { x: 150, y: 560, size: 16 },
    ];
    const { rgb, boxes } = markerImage({ width: W, height: W, markers, seed: 3 });
    // a red patch and a pink patch close to the marker colour must not count
    for (let y = 400; y < 430; y++)
      for (let x = 400; x < 430; x++) rgb.set([230, 40, 40], (y * W + x) * 3);
    for (let y = 200; y < 220; y++)
      for (let x = 100; x < 120; x++) rgb.set([235, 150, 220], (y * W + x) * 3);
    const out = runOnnx(decodeOnnx(onnx), { images: tensorOf(rgb, W, W) });
    expect(out.output0.dims).toEqual([1, 5, 361]);
    const found = postprocessYoloV8(out.output0, { minConfidence: card.minConfidence });
    const sorted = (b) => [...b].sort((a, c) => a[0] - c[0]);
    expect(sorted(found.map((d) => d.box))).toEqual(sorted(boxes));
    expect(found.every((d) => d.score >= 0.5 && d.classIndex === 0)).toBe(true);
  });

  it('uses the marker colour the demo paints', () => {
    expect(MARKER_RGB).toEqual([224, 32, 224]);
  });

  it('has error-path twins: a wrong layout and a corrupt file', () => {
    const wrong = decodeOnnx(buildWrongLayoutDetector().onnx);
    expect(wrong.graph.outputs[0].shape).toEqual([1, 3, 361]);
    expect(() => decodeOnnx(corruptOnnx())).toThrow();
  });
});
