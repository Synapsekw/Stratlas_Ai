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
      proposedBox: [12, 22, 58, 78],
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
      proposedBox: [12, 22, 58, 78],
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
      expect(written.proposedBox).toEqual(was?.proposedBox);
    }
  });
});

describe('multi-view vote in the model', () => {
  const vote = {
    views: 3,
    seenBy: 5,
    score: 0.8,
    point: [1, 2, 3] as [number, number, number],
    placedOn: 'mesh' as const,
    sightings: [{ photo: 'p002', bbox: [1, 1, 5, 5] as [number, number, number, number] }],
  };
  const voted: DetectionsFile = {
    schema: 'aio.detections/1',
    source: 'model',
    producer: 'detect.vlm',
    detections: [
      {
        id: 'w1',
        photo: 'p001',
        class: 'corrosion',
        status: 'draft',
        bbox: [10, 20, 60, 80],
        vote,
      },
      { id: 'w2', photo: 'p001', class: 'corrosion', status: 'draft', bbox: [100, 20, 160, 80] },
    ],
  };
  it('carries the vote and writes it back on review', () => {
    const { detections, passes } = readPasses([{ name: 'vlm-run-b.json', file: voted }], passCtx);
    expect(detections[0]?.vote).toEqual(vote);
    expect(detections[1]?.vote).toBeUndefined();
    const rec = passes[0];
    if (!rec) throw new Error('no pass');
    // the reviewer accepts the voted draft: it is written from the model, the vote stays
    const reviewed = detections.map((d) =>
      d.id === 'w1' ? { ...d, status: 'accepted' as const } : d,
    );
    const out = writePass(rec, reviewed, new Map());
    expect(out.detections[0]?.vote).toEqual(vote);
    expect(out.detections[0]?.status).toBe('accepted');
    expect(out.detections[1]?.vote).toBeUndefined();
  });
});

describe('360 walk track in the model', () => {
  const track = {
    frames: 3,
    firstT: 4,
    lastT: 5,
    score: 0.8,
    point: [1, 2, 3] as [number, number, number],
    placedOn: 'ground' as const,
    bearingDeg: 90,
    rangeM: 5,
    sightings: [{ t: 4, bbox: [10, 20, 60, 80] as [number, number, number, number] }],
  };
  const tracked: DetectionsFile = {
    schema: 'aio.detections/1',
    source: 'model',
    layer: 'walk-1',
    detections: [
      {
        id: 't1',
        frame: { layer: 'walk-1', t: 4.5 },
        class: 'corrosion',
        status: 'draft',
        bbox: [12, 20, 62, 80],
        space: 'source',
        width: 5760,
        height: 2880,
        track,
      },
      {
        id: 't2',
        frame: { layer: 'walk-1', t: 9 },
        class: 'corrosion',
        status: 'draft',
        bbox: [100, 20, 160, 80],
        space: 'source',
        width: 5760,
        height: 2880,
      },
    ],
  };
  it('carries the track and writes it back on review', () => {
    const { detections, passes } = readPasses(
      [{ name: 'model-run-w.json', file: tracked }],
      passCtx,
    );
    expect(detections[0]?.track).toEqual(track);
    expect(detections[1]?.track).toBeUndefined();
    const rec = passes[0];
    if (!rec) throw new Error('no pass');
    const reviewed = detections.map((d) =>
      d.id === 't1' ? { ...d, status: 'rejected' as const } : d,
    );
    const out = writePass(rec, reviewed, new Map());
    expect(out.detections[0]?.track).toEqual(track);
    expect(out.detections[0]?.status).toBe('rejected');
    expect(out.detections[1]?.track).toBeUndefined();
  });
});
