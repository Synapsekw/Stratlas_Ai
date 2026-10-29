import { describe, expect, it } from 'vitest';
import {
  AI_REQUEST_SCHEMA,
  AiRequest,
  DetectionOrigin,
  DetectionsFile,
  FieldSpec,
  FieldValue,
  Issue,
  ipc,
  parseManifest,
} from './index';

const spec = (n: number) => ({ key: `f${n}`, label: `Field ${n}`, type: 'text' as const });

const gauge = {
  schema: AI_REQUEST_SCHEMA,
  id: 'read-gauges',
  name: 'Read gauges',
  kind: 'find',
  prompt: 'Find every pressure gauge and read it.',
  fields: [
    { key: 'reading', label: 'Reading', type: 'number', unit: 'bar' },
    { key: 'in_normal_range', label: 'In normal range', type: 'yesno' },
    { key: 'gauge_type', label: 'Gauge type', type: 'choice', choices: ['dial', 'digital'] },
  ],
  scope: 'all',
  model: 'auto',
  author: 'Reviewer',
  createdAt: '2026-10-29T08:00:00Z',
  updatedAt: '2026-10-29T08:00:00Z',
};

const img = { key: 'p1', dataUrl: 'data:image/jpeg;base64,AA==', width: 100, height: 80 };
const ask = (kind: string, images: unknown[]) => ({
  runId: 'r1',
  projectId: 'demo',
  backend: { kind: 'local' },
  kind,
  prompt: 'What changed?',
  fields: [],
  images,
});

describe('aio.ai-request/1', () => {
  it('ties choices to the choice type', () => {
    expect(FieldSpec.safeParse({ key: 'a', label: 'A', type: 'choice' }).success).toBe(false);
    expect(
      FieldSpec.safeParse({ key: 'a', label: 'A', type: 'number', choices: ['x', 'y'] }).success,
    ).toBe(false);
    expect(
      FieldSpec.safeParse({ key: 'a', label: 'A', type: 'choice', choices: ['x', 'y'] }).success,
    ).toBe(true);
  });

  it('checks a value against its type', () => {
    const base = { key: 'a', label: 'A' };
    expect(FieldValue.safeParse({ ...base, type: 'yesno', value: 'maybe' }).success).toBe(false);
    expect(FieldValue.safeParse({ ...base, type: 'number', value: '4' }).success).toBe(false);
    expect(FieldValue.safeParse({ ...base, type: 'number', value: 4.5 }).success).toBe(true);
    expect(FieldValue.safeParse({ ...base, type: 'yesno', value: 'unknown' }).success).toBe(true);
    expect(FieldValue.safeParse({ ...base, type: 'text', value: null }).success).toBe(true);
  });

  it('accepts a gauge request and refuses duplicate keys or 13 fields', () => {
    expect(AiRequest.safeParse(gauge).success).toBe(true);
    const dup = { ...gauge, fields: [spec(1), spec(1)] };
    expect(AiRequest.safeParse(dup).success).toBe(false);
    const many = { ...gauge, fields: Array.from({ length: 13 }, (_, i) => spec(i)) };
    expect(AiRequest.safeParse(many).success).toBe(false);
  });

  it('keeps fields on issues, detections and the detection origin', () => {
    const fields = [{ key: 'reading', label: 'Reading', type: 'number', value: 4, unit: 'bar' }];
    const issue = Issue.parse({
      id: 'i1',
      code: 'F01',
      classId: 'gauge',
      severityModelId: 's',
      severity: 1,
      status: 'draft',
      title: 'Gauge',
      note: '',
      author: 'r',
      createdAt: '2026-10-29T10:00:00+03:00',
      updatedAt: '2026-10-29T10:00:00+03:00',
      sightings: [
        { on: 'mesh', layer: 'plant', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } },
      ],
      source: 'human',
      fields,
    });
    expect(issue.fields).toEqual(fields);
    const file = DetectionsFile.parse({
      schema: 'aio.detections/1',
      source: 'ai',
      producer: 'x',
      createdAt: '2026-10-29T08:00:00Z',
      assessed: 'all',
      detections: [
        {
          photo: 'p1',
          class: 'gauge',
          bbox: [1, 1, 5, 5],
          fields,
          origin: { request: 'read-gauges' },
        },
      ],
    });
    expect(file.detections[0]?.fields).toEqual(fields);
    expect(file.detections[0]?.origin?.request).toBe('read-gauges');
    expect(DetectionOrigin.safeParse({ request: 'Bad Id' }).success).toBe(false);
  });

  it('keeps aiPolicy on the manifest', () => {
    const r = parseManifest({
      schema: 'aio.project/1',
      id: 'demo',
      name: 'Demo',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [],
      severityModels: [],
      classCatalogues: [],
      aiPolicy: 'forbid',
    });
    expect(r.ok && r.value.aiPolicy).toBe('forbid');
  });

  it('ai:ask wants two images for a change and one for the rest', () => {
    const req = ipc['ai:ask'].request;
    expect(req.safeParse(ask('change', [img])).success).toBe(false);
    expect(req.safeParse(ask('change', [img, img])).success).toBe(true);
    expect(req.safeParse(ask('find', [img, img])).success).toBe(false);
    expect(req.safeParse(ask('find', [img])).success).toBe(true);
  });
});
