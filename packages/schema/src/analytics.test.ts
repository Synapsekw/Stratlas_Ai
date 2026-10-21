import { describe, expect, it } from 'vitest';
import { DetectVlmParams, VlmDetector, vlmPassName } from './index';

const sha = 'a'.repeat(64);

const detector = {
  schema: 'aio.vlm-detector/1',
  id: 'corrosion-spike',
  name: 'Corrosion',
  version: 1,
  classId: 'corrosion',
  assetTypes: ['tower'],
  looksLike: 'Orange-brown rust staining on steel.',
  ignore: 'Paint colour, shadows.',
  question: 'Is there corrosion in this picture?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen2.5-vl-7b-instruct-q4_k_m', modelSha256: sha },
  author: 'AIO',
  createdAt: '2026-10-17T08:00:00Z',
  updatedAt: '2026-10-17T08:00:00Z',
  source: 'shipped',
  status: 'verified',
  samples: [{ photo: 'p001', file: 'samples/p001.jpg' }],
  examples: [{ file: 'examples/e1.jpg', verdict: 'is' }],
};

describe('analytics contracts', () => {
  it('parses the spike corrosion detector', () => {
    expect(VlmDetector.parse(detector).id).toBe('corrosion-spike');
  });
  it('refuses a sample path outside samples/', () => {
    const bad = { ...detector, samples: [{ photo: 'p001', file: '../x.jpg' }] };
    expect(VlmDetector.safeParse(bad).success).toBe(false);
  });
  it('refuses tiles not multiples of 28', () => {
    const bad = { ...detector, tiles: { ...detector.tiles, sendW: 1300 } };
    expect(VlmDetector.safeParse(bad).success).toBe(false);
  });
  it('vlmPassName sanitises', () => {
    expect(vlmPassName('run-a/b')).toBe('vlm-run-a-b.json');
  });
  it('DetectVlmParams refuses a relative serverFile', () => {
    const params = {
      run: 'run-1',
      layer: 'photos-1',
      photos: ['p001'],
      detectors: [{ where: 'shipped', detector, threshold: 0.8 }],
      serverFile: 'runtime/analytics-server.json',
      modelSha256: sha,
      model: 'qwen2.5-vl-7b-instruct-q4_k_m',
    };
    expect(DetectVlmParams.safeParse(params).success).toBe(false);
    expect(
      DetectVlmParams.safeParse({ ...params, serverFile: 'C:/data/runtime/analytics-server.json' })
        .success,
    ).toBe(true);
  });
});
