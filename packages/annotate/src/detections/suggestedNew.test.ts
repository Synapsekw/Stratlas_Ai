import type { DetectionsFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { readPasses, toPassDetection, type PassContext } from './model';

const ctx: PassContext = {
  photoLayer: () => 'photos',
  photoSize: () => [100, 100],
  classId: (raw) => (raw === 'crack' || raw.toLowerCase() === 'hairline crack' ? 'crack' : null),
  pipelineIssue: () => null,
};

const file = (detections: DetectionsFile['detections']): DetectionsFile => ({
  schema: 'aio.detections/1',
  source: 'ai',
  detections,
});

describe('suggested new classes in pass files', () => {
  it('reads suggestedNew for a detection whose class matched none', () => {
    const r = readPasses(
      [
        {
          name: 'ai-r1.json',
          file: file([
            {
              id: 'a',
              photo: 'p1',
              class: 'Spalling',
              label: 'Spalling',
              suggestedNew: true,
              bbox: [0, 0, 10, 10],
              status: 'draft',
            },
          ]),
        },
      ],
      ctx,
    );
    expect(r.detections[0]).toMatchObject({ classId: '', label: 'Spalling', suggestedNew: true });
  });

  it('drops the flag once the class exists, and writes it only while the class is missing', () => {
    const r = readPasses(
      [
        {
          name: 'ai-r1.json',
          file: file([
            {
              id: 'a',
              photo: 'p1',
              class: 'crack',
              suggestedNew: true,
              bbox: [0, 0, 10, 10],
              status: 'draft',
            },
          ]),
        },
      ],
      ctx,
    );
    const d = r.detections[0];
    if (!d) throw new Error('no detection');
    expect(d.suggestedNew).toBeUndefined();
    const out = toPassDetection(
      { ...d, classId: '', label: 'Spalling', suggestedNew: true },
      {
        fileSource: 'ai',
      },
    );
    expect(out.suggestedNew).toBe(true);
    expect(toPassDetection(d, { fileSource: 'ai' }).suggestedNew).toBeUndefined();
  });

  it('resolves a class by the proposer word when the class field does not match', () => {
    const r = readPasses(
      [
        {
          name: 'model-r1.json',
          file: file([
            {
              id: 'm',
              photo: 'p1',
              class: 'crack_hairline',
              label: 'Hairline crack',
              bbox: [0, 0, 10, 10],
              status: 'draft',
            },
          ]),
        },
      ],
      ctx,
    );
    expect(r.detections[0]?.classId).toBe('crack');
  });
});
