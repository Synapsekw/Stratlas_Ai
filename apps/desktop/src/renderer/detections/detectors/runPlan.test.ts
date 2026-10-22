import { VLM_DETECTOR_SCHEMA, type VlmDetector } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { DetectItem } from '../convert';
import { estimateMinutes, orderForProject, planRuns, type Chosen } from './runPlan';

const det = (id: string, assetTypes: string[]): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: id,
  version: 1,
  classId: 'patch',
  assetTypes,
  looksLike: 'a dark patch',
  ignore: '',
  question: 'Is this a dark patch?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen', modelSha256: 'a'.repeat(64) },
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'verified',
});

describe('runPlan', () => {
  it('splits the selection into one job per layer and skips frames', () => {
    const items: DetectItem[] = [
      { kind: 'photo', layer: 'd1', photo: 'p1' },
      { kind: 'frame', layer: 'v1', t: 2 },
      { kind: 'photo', layer: 'd2', photo: 'q1' },
      { kind: 'photo', layer: 'd1', photo: 'p2' },
      { kind: 'photo', layer: 'd1', photo: 'p1' },
      { kind: 'frame', layer: 'w1', t: 4 },
    ];
    const chosen: Chosen[] = [{ where: 'library', detector: det('a', ['roof']), threshold: 0.8 }];
    const plan = planRuns(items, chosen);
    expect(plan.skippedFrames).toBe(2);
    expect(plan.runs.map((r) => ({ layer: r.layer, photos: r.photos }))).toEqual([
      { layer: 'd1', photos: ['p1', 'p2'] },
      { layer: 'd2', photos: ['q1'] },
    ]);
    expect(plan.runs[0]?.detectors).toEqual(chosen);
    expect(planRuns([{ kind: 'frame', layer: 'v1', t: 1 }], chosen)).toEqual({
      runs: [],
      skippedFrames: 1,
    });
  });

  it('estimateMinutes rounds up', () => {
    expect(estimateMinutes(240, 1)).toBe(28);
    expect(estimateMinutes(1, 1)).toBe(1);
    expect(estimateMinutes(240, 3)).toBe(84);
    expect(estimateMinutes(0, 2)).toBe(0);
  });

  it("orders the project's asset type first", () => {
    const list = [
      { where: 'shipped' as const, detector: det('tower', ['telecom']) },
      { where: 'library' as const, detector: det('rust', ['Roof', 'facade']) },
      { where: 'project' as const, detector: det('crack', ['bridge']) },
    ];
    const { forProject, rest } = orderForProject(list, ['roof']);
    expect(forProject.map((x) => x.detector.id)).toEqual(['rust']);
    expect(rest.map((x) => x.detector.id)).toEqual(['tower', 'crack']);
    expect(orderForProject(list, []).forProject).toEqual([]);
  });
});
