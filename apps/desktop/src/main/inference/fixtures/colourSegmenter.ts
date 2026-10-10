/**
 * A synthetic SAM-shaped segmentation model for tests (M11 G12): plain operators with hand-set
 * constants, no trained weights, so no model file of unknown origin is checked in and there is no
 * licence or training-data question. It takes the shipped model's inputs and gives its outputs
 * (`hwc-255` encoder, ADR 0011), so `segment.ts` runs it through onnxruntime exactly as it runs
 * MobileSAM.
 *
 * How it works: the encoder averages 4 x 4 pixel blocks and divides each block's colour by its
 * brightness (chromaticity), so shading and texture drop out and a pile of one material is one
 * colour. The decoder reads the chromaticity under the click (a narrow Gaussian weight around
 * the point) and marks every cell within a small distance of it; `segment.ts` keeps the region
 * under the click. The predicted IoU is a constant 0.9.
 */
import { writeOnnx, type OnnxNode } from './onnx';

const S = 1024;
const G = 256;
const BLOCK = S / G;

/** The ONNX bytes of the encoder and decoder, and their `model.json` card. */
export function colourSegmenterOnnx(threshold = 0.002): {
  encoder: Uint8Array;
  decoder: Uint8Array;
  card: Record<string, string>;
} {
  const encNodes: OnnxNode[] = [
    { op: 'Reshape', inputs: ['input_image', 'nhwc'], outputs: ['img4'] },
    {
      op: 'Transpose',
      inputs: ['img4'],
      outputs: ['nchw'],
      attrs: { perm: { ints: [0, 3, 1, 2] } },
    },
    {
      op: 'AveragePool',
      inputs: ['nchw'],
      outputs: ['pooled'],
      attrs: { kernel_shape: { ints: [BLOCK, BLOCK] }, strides: { ints: [BLOCK, BLOCK] } },
    },
    {
      op: 'ReduceSum',
      inputs: ['pooled', 'axis1'],
      outputs: ['bright'],
      attrs: { keepdims: { i: 1 } },
    },
    { op: 'Add', inputs: ['bright', 'eps'], outputs: ['brightE'] },
    { op: 'Div', inputs: ['pooled', 'brightE'], outputs: ['image_embeddings'] },
  ];
  const encoder = writeOnnx({
    name: 'quadrion-colour-segmenter-encoder',
    doc: 'Quadrion AI test fixture: chromaticity of 4 x 4 blocks.',
    nodes: encNodes,
    initializers: [
      { name: 'nhwc', dims: [4], int64: [1, S, S, 3] },
      { name: 'axis1', dims: [1], int64: [1] },
      { name: 'eps', dims: [], float: [1e-3] },
    ],
    inputs: [{ name: 'input_image', dims: [S, S, 3] }],
    outputs: [{ name: 'image_embeddings', dims: [1, 3, G, G] }],
  });

  const decNodes: OnnxNode[] = [
    // the click: point_coords[0, 0, :] in pixels of the 1024 image, to cells of the grid
    { op: 'Gather', inputs: ['point_coords', 'i0'], outputs: ['p0'], attrs: { axis: { i: 1 } } },
    { op: 'Gather', inputs: ['p0', 'i0'], outputs: ['px'], attrs: { axis: { i: 1 } } },
    { op: 'Gather', inputs: ['p0', 'i1'], outputs: ['py'], attrs: { axis: { i: 1 } } },
    { op: 'Reshape', inputs: ['px', 'one4'], outputs: ['px4'] },
    { op: 'Reshape', inputs: ['py', 'one4'], outputs: ['py4'] },
    { op: 'Mul', inputs: ['px4', 'toCell'], outputs: ['cx'] },
    { op: 'Mul', inputs: ['py4', 'toCell'], outputs: ['cy'] },
    { op: 'Sub', inputs: ['xs', 'cx'], outputs: ['dx'] },
    { op: 'Sub', inputs: ['ys', 'cy'], outputs: ['dy'] },
    { op: 'Mul', inputs: ['dx', 'dx'], outputs: ['dx2'] },
    { op: 'Mul', inputs: ['dy', 'dy'], outputs: ['dy2'] },
    { op: 'Add', inputs: ['dx2', 'dy2'], outputs: ['r2'] },
    { op: 'Mul', inputs: ['r2', 'negHalf'], outputs: ['e'] },
    { op: 'Exp', inputs: ['e'], outputs: ['w'] },
    // the chromaticity under the click, a weighted mean
    { op: 'Mul', inputs: ['image_embeddings', 'w'], outputs: ['ew'] },
    { op: 'ReduceSum', inputs: ['ew', 'axes23'], outputs: ['ews'], attrs: { keepdims: { i: 1 } } },
    { op: 'ReduceSum', inputs: ['w', 'axes23'], outputs: ['ws'], attrs: { keepdims: { i: 1 } } },
    { op: 'Div', inputs: ['ews', 'ws'], outputs: ['at'] },
    // squared distance to it, as logits: positive within the threshold
    { op: 'Sub', inputs: ['image_embeddings', 'at'], outputs: ['d'] },
    { op: 'Mul', inputs: ['d', 'd'], outputs: ['d2'] },
    { op: 'ReduceSum', inputs: ['d2', 'axis1'], outputs: ['dist'], attrs: { keepdims: { i: 1 } } },
    { op: 'Sub', inputs: ['thr', 'dist'], outputs: ['margin'] },
    { op: 'Mul', inputs: ['margin', 'gain'], outputs: ['masks'] },
    // a constant IoU of the right shape [1, 1]
    { op: 'ReduceSum', inputs: ['ws', 'axes23'], outputs: ['wsum'], attrs: { keepdims: { i: 0 } } },
    { op: 'Mul', inputs: ['wsum', 'zero'], outputs: ['z'] },
    { op: 'Add', inputs: ['z', 'iou'], outputs: ['iou_predictions'] },
  ];
  const decoder = writeOnnx({
    name: 'quadrion-colour-segmenter-decoder',
    doc: 'Quadrion AI test fixture: cells of the clicked chromaticity.',
    nodes: decNodes,
    initializers: [
      { name: 'i0', dims: [], int64: [0] },
      { name: 'i1', dims: [], int64: [1] },
      { name: 'one4', dims: [4], int64: [1, 1, 1, 1] },
      { name: 'toCell', dims: [], float: [1 / BLOCK] },
      { name: 'xs', dims: [1, 1, 1, G], float: Array.from({ length: G }, (_, i) => i + 0.5) },
      { name: 'ys', dims: [1, 1, G, 1], float: Array.from({ length: G }, (_, i) => i + 0.5) },
      { name: 'negHalf', dims: [], float: [-0.5] },
      { name: 'axes23', dims: [2], int64: [2, 3] },
      { name: 'axis1', dims: [1], int64: [1] },
      { name: 'thr', dims: [], float: [threshold] },
      { name: 'gain', dims: [], float: [1000] },
      { name: 'zero', dims: [], float: [0] },
      { name: 'iou', dims: [], float: [0.9] },
    ],
    inputs: [
      { name: 'image_embeddings', dims: [1, 3, G, G] },
      { name: 'point_coords', dims: [1, 'num_points', 2] },
    ],
    outputs: [
      { name: 'masks', dims: [1, 1, G, G] },
      { name: 'iou_predictions', dims: [1, 1] },
    ],
  });
  return {
    encoder,
    decoder,
    card: {
      name: 'Colour test segmenter',
      version: '1',
      licence: 'MIT',
      source:
        'Quadrion AI test fixture (apps/desktop/src/main/inference/fixtures/colourSegmenter.ts)',
      input: 'hwc-255',
    },
  };
}
