import type { DetectionsFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { readPasses, writePass } from './model';

const passCtx = {
  photoLayer: () => 'photos',
  photoSize: (): [number, number] | null => [2000, 1000],
  classId: (raw: string) => (raw === 'corrosion' ? 'corrosion' : null),
  pipelineIssue: () => null,
};

const sha = 'a'.repeat(64);
const detectorOrigin = {
  detectorId: 'corrosion-spike',
  detectorVersion: 2,
  modelSha256: sha,
  threshold: 0.6,
};

const vlmRunA: DetectionsFile = {
  schema: 'aio.detections/1',
  source: 'model',
  producer: 'detect.vlm',
  detections: [
    {
      id: 'v1',
      photo: 'p001',
      class: 'corrosion',
      status: 'draft',
      confidence: 0.4,
      bbox: [10, 20, 60, 80],
      origin: { model: 'qwen', ...detectorOrigin },
      belowThreshold: true,
      rejectReason: 'wrong-class',
      rejectNote: 'it is paint',
    },
    {
      id: 'v2',
      photo: 'p001',
      class: 'corrosion',
      status: 'draft',
      bbox: [100, 20, 160, 80],
      origin: detectorOrigin,
      unscored: true,
    },
  ],
};

describe('detector fields in the model', () => {
  it('fromPass carries detector fields and toPass writes them back unchanged', () => {
    const { detections, passes } = readPasses([{ name: 'vlm-run-a.json', file: vlmRunA }], passCtx);
    const [d1, d2] = detections;
    expect(d1?.origin).toEqual({
      kind: 'model',
      producer: 'qwen',
      detector: { id: 'corrosion-spike', version: 2, modelSha256: sha, threshold: 0.6 },
    });
    expect(d1).toMatchObject({
      belowThreshold: true,
      rejectReason: 'wrong-class',
      rejectNote: 'it is paint',
    });
    expect(d2?.unscored).toBe(true);

    // an empty `loaded` map forces every detection through the model-to-pass writer
    const rec = passes[0];
    if (!rec) throw new Error('no pass');
    const out = writePass(rec, detections, new Map());
    for (const [i, written] of out.detections.entries()) {
      const was = vlmRunA.detections[i];
      expect(written.origin).toEqual(was?.origin);
      expect(written.belowThreshold).toBe(was?.belowThreshold);
      expect(written.unscored).toBe(was?.unscored);
      expect(written.rejectReason).toBe(was?.rejectReason);
      expect(written.rejectNote).toBe(was?.rejectNote);
    }
  });
});
