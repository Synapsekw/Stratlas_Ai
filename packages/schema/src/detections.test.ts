import { describe, expect, it } from 'vitest';
import { DETECTIONS_SCHEMA, DetectionOrigin, DetectionsFile, pipelineParams } from './index';

const file = {
  schema: DETECTIONS_SCHEMA,
  source: 'ai',
  producer: 'anthropic claude vision',
  createdAt: '2026-10-05T08:00:00Z',
  assessed: 'all',
  detections: [
    { id: 'a1', photo: 'p001', class: 'corrosion', severity: 2, bbox: [10, 20, 60, 80] },
    { photo: 'p002', class: 'crack', severity: 'uncertain', status: 'draft', bbox: [1, 1, 5, 5] },
    { class: 'corrosion', space: 'sheet', sheet: 'sheet-00', bbox: [100, 100, 140, 130] },
    {
      photo: 'p003',
      class: 'corrosion',
      space: 'source',
      width: 4000,
      height: 3000,
      bbox: [400, 300, 800, 600],
      confidence: 0.82,
    },
  ],
};

describe('aio.detections/1', () => {
  it('accepts review, AI and sheet detections', () => {
    expect(DetectionsFile.safeParse(file).success).toBe(true);
  });

  it('refuses boxes inside out, photos missing and sheets without a name', () => {
    const bad = (d: Record<string, unknown>) =>
      DetectionsFile.safeParse({ ...file, detections: [d] }).success;
    expect(bad({ photo: 'p', class: 'c', bbox: [10, 10, 5, 20] })).toBe(false);
    expect(bad({ class: 'c', bbox: [0, 0, 1, 1] })).toBe(false);
    expect(bad({ class: 'c', space: 'sheet', bbox: [0, 0, 1, 1] })).toBe(false);
    expect(bad({ photo: 'p', class: 'c', space: 'normalized', bbox: [0, 0, 2, 1] })).toBe(false);
    expect(bad({ photo: 'p', class: 'c', status: 'maybe', bbox: [0, 0, 1, 1] })).toBe(false);
    expect(DetectionsFile.safeParse({ ...file, schema: 'aio.detections/2' }).success).toBe(false);
  });
});

describe('aio.detections/1 review fields', () => {
  const review = {
    id: 'r1',
    photo: 'p001',
    class: 'corrosion',
    status: 'accepted',
    issueId: 'issue-1',
    space: 'source',
    width: 2560,
    height: 1708,
    bbox: [10, 10, 60, 40],
    geom: {
      type: 'polygon',
      points: [
        [10, 10],
        [60, 10],
        [35, 40],
      ],
    },
    uncertain: true,
    label: 'rust',
    origin: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: 'detect-v1',
      runId: 'r',
    },
    reviewedBy: 'dan',
    reviewedAt: '2026-10-05T10:00:00Z',
  };
  const frame = {
    id: 'f1',
    frame: { layer: 'clip', t: 3.5 },
    class: 'crack',
    space: 'source',
    width: 1920,
    height: 1080,
    bbox: [1, 1, 9, 9],
  };
  const parse = (d: unknown, extra: Record<string, unknown> = {}) =>
    DetectionsFile.safeParse({ ...file, ...extra, detections: [d] }).success;

  it('takes shapes, video frames, issue links, origins and the run', () => {
    expect(parse(review)).toBe(true);
    expect(parse(frame, { run: { id: 'r', model: 'm', images: 4, costUsd: 0.02 } })).toBe(true);
  });

  it('keeps a walk frame box that wraps across the 360 seam (x1 > width)', () => {
    const wrap = {
      ...frame,
      frame: { layer: 'walk', t: 2 },
      width: 3840,
      height: 1920,
      bbox: [3800, 900, 3880, 1100],
      geom: { type: 'box', x: 3800, y: 900, w: 80, h: 200 },
    };
    const res = DetectionsFile.safeParse({ ...file, detections: [wrap] });
    expect(res.success).toBe(true);
    expect(res.data?.detections[0]?.bbox).toEqual([3800, 900, 3880, 1100]);
  });

  it('refuses a frame and a photo together, a frame without its size, unknown run keys', () => {
    expect(parse({ ...frame, photo: 'p001' })).toBe(false);
    expect(parse({ ...frame, width: undefined })).toBe(false);
    expect(parse({ ...frame, space: 'preview' })).toBe(false);
    expect(parse({ ...review, geom: { type: 'mask', src: { path: 'm.png' } } })).toBe(false);
    expect(parse(review, { run: { id: 'r', extra: 1 } })).toBe(false);
  });
});

describe('inspection.run params', () => {
  const p = pipelineParams('inspection.run');
  it('takes the detections, review and clustering options', () => {
    expect(p.safeParse({}).success).toBe(true);
    expect(
      p.safeParse({
        detections: ['detections', 'D:/ai/run1.json'],
        includeDrafts: true,
        minConfidence: 0.4,
        clusterM: 1.5,
        profile: 'tank',
        out: 'inspection',
      }).success,
    ).toBe(true);
  });
  it('keeps outputs in the project and refuses unknown keys', () => {
    expect(p.safeParse({ out: '../x' }).success).toBe(false);
    expect(p.safeParse({ minConfidence: 2 }).success).toBe(false);
    expect(p.safeParse({ profile: 'bridge' }).success).toBe(false);
    expect(p.safeParse({ grid: 4 }).success).toBe(false);
  });
});

describe('detector origin', () => {
  it('keeps detector origin fields', () => {
    const origin = {
      runId: 'run-1',
      model: 'qwen',
      detectorId: 'corrosion-spike',
      detectorVersion: 2,
      modelSha256: 'a'.repeat(64),
      threshold: 0.8,
    };
    expect(DetectionOrigin.parse(origin)).toEqual(origin);
  });
  it('refuses an unknown key in origin', () => {
    expect(DetectionOrigin.safeParse({ detectorId: 'x', colour: 'red' }).success).toBe(false);
  });
});
