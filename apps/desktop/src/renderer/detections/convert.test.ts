import type { Detection } from '@aio/annotate/detections';
import type { ClassCatalogue, SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  itemKey,
  promptTaxonomy,
  sampleTimes,
  toDraftDetections,
  type DetectItem,
} from './convert';

const model: SeverityModel = {
  id: 'aik',
  name: 'Kit',
  levels: [
    { value: 1, label: 'Light', color: '#fad34b', criteria: 'Light staining' },
    { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
  ],
  uncertain: { label: 'Uncertain', color: '#b68ef8' },
};
const catalogues: ClassCatalogue[] = [
  {
    id: 'c',
    name: 'Classes',
    assetType: 'stack',
    classes: [
      { id: 'light', label: 'Light staining', color: '#fad34b', severityModel: 'aik' },
      { id: 'moderate', label: 'Moderate rust', color: '#ff7a2d', severityModel: 'aik' },
    ],
  },
];

const photo: DetectItem = { kind: 'photo', layer: 'photos', photo: 'p001' };
const frame: DetectItem = { kind: 'frame', layer: 'clip', t: 12.5 };
const NOW = '2026-10-05T10:00:00.000Z';

function convert(
  results: Parameters<typeof toDraftDetections>[0]['results'],
  existing: Detection[] = [],
) {
  let n = 0;
  return toDraftDetections({
    results,
    items: new Map([
      [itemKey(photo), photo],
      [itemKey(frame), frame],
    ]),
    sizes: new Map([
      [itemKey(photo), { width: 2560, height: 1708 }],
      [itemKey(frame), { width: 1920, height: 1080 }],
    ]),
    models: [model],
    catalogues,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    promptVersion: 'detect-v1',
    runId: 'run-1',
    pass: 'ai-run-1.json',
    now: NOW,
    existing,
    newId: () => `n${String(++n)}`,
  });
}

describe('AI results to draft detections', () => {
  it('scales to photo pixels, keeps model, prompt version and confidence', () => {
    const { detections, skipped } = convert([
      {
        key: itemKey(photo),
        detections: [
          {
            classId: 'moderate',
            label: 'moderate',
            box: [0.25, 0.5, 0.25, 0.25],
            confidence: 0.81,
            severity: 2,
            note: 'Flange',
          },
        ],
      },
    ]);
    expect(skipped).toBe(0);
    expect(detections[0]).toEqual({
      id: 'n1',
      pass: 'ai-run-1.json',
      source: { kind: 'photo', layer: 'photos', photo: 'p001' },
      size: [2560, 1708],
      geom: { type: 'box', x: 640, y: 854, w: 640, h: 427 },
      classId: 'moderate',
      label: 'moderate',
      severity: 2,
      uncertain: false,
      note: 'Flange',
      confidence: 0.81,
      status: 'draft',
      origin: {
        kind: 'ai',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        promptVersion: 'detect-v1',
        runId: 'run-1',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('keeps unknown labels for the reviewer, drops severities outside the model, prefers polygons', () => {
    const { detections } = convert([
      {
        key: itemKey(frame),
        detections: [
          { classId: '', label: 'graffiti', box: [0, 0, 0.5, 0.5], severity: 9 },
          {
            classId: 'light',
            label: 'light',
            polygon: [
              [0, 0],
              [0.5, 0],
              [0.5, 0.5],
            ],
            box: [0, 0, 1, 1],
          },
        ],
      },
    ]);
    expect(detections[0]).toMatchObject({
      classId: '',
      label: 'graffiti',
      severity: null,
      source: { kind: 'frame', t: 12.5 },
    });
    expect(detections[1]?.geom).toEqual({
      type: 'polygon',
      points: [
        [0, 0],
        [960, 0],
        [960, 540],
      ],
    });
  });

  it('skips repeats of a proposal already on the photo, and unusable boxes', () => {
    const first = convert([
      {
        key: itemKey(photo),
        detections: [{ classId: 'light', label: 'light', box: [0.1, 0.1, 0.2, 0.2] }],
      },
    ]);
    const again = convert(
      [
        {
          key: itemKey(photo),
          detections: [
            { classId: 'light', label: 'light', box: [0.11, 0.1, 0.2, 0.2] },
            { classId: 'moderate', label: 'moderate', box: [0.1, 0.1, 0.2, 0.2] },
            { classId: 'light', label: 'light', box: [0.1, 0.1, 0, 0.2] },
          ],
        },
      ],
      first.detections,
    );
    expect(again.detections.map((d) => d.classId)).toEqual(['moderate']);
    expect(again.skipped).toBe(2);
  });
});

describe('what is sent', () => {
  it('sends every class and the most used severity scale', () => {
    const t = promptTaxonomy([model], catalogues);
    expect(t.classes).toEqual([
      { id: 'light', label: 'Light staining' },
      { id: 'moderate', label: 'Moderate rust' },
    ]);
    expect(t.severity).toEqual({
      levels: [
        { value: 1, label: 'Light', criteria: 'Light staining' },
        { value: 2, label: 'Moderate' },
      ],
      uncertain: true,
    });
    expect(promptTaxonomy([], []).classes).toEqual([]);
  });

  it('samples frames across a clip', () => {
    expect(sampleTimes(60, 10, 100)).toEqual([5, 15, 25, 35, 45, 55]);
    expect(sampleTimes(60, 10, 2)).toEqual([5, 15]);
    expect(sampleTimes(3, 10, 5)).toEqual([1.5]);
    expect(sampleTimes(0, 10, 5)).toEqual([]);
  });
});
