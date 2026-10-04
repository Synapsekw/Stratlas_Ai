import { describe, expect, it } from 'vitest';
import { DETECTIONS_SCHEMA, DetectionsFile, pipelineParams } from './index';

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
