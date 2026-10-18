import { describe, expect, it } from 'vitest';
import { ReadComponentsInput, measurementRecords } from './engineerTools';
import type { ComponentObservation } from '@aio/schema';

describe('bounded measurement access', () => {
  it('retains source associations and uncertainty without exposing local file paths', () => {
    const q = { basis: 'observed' as const, note: 'Rear face not independently measured.' };
    const o: ComponentObservation = {
      id: 'obs-panel-1',
      kind: 'panel',
      centre: [0, 1, 0],
      size: [1, 2, 0.2],
      azimuthDeg: 0,
      tiltDeg: 0,
      quality: { centre: q, width: q, height: q, depth: q, azimuthDeg: q, tiltDeg: q },
      notes: ['Drawing-only depth.', 'C:\\private\\file.dxf'],
      sources: [
        { kind: 'photo', ref: 'img-crop-1' },
        { kind: 'drawing', ref: 'C:\\private\\file.dxf' },
      ],
    };
    const record = measurementRecords([o])[0];
    expect(record?.sources).toEqual([
      { kind: 'photo', ref: 'img-crop-1' },
      { kind: 'drawing', ref: 'source-2' },
    ]);
    expect(record?.quality.depth?.note).toBe(q.note);
    expect(record?.notes).toContain('Drawing-only depth.');
    expect(JSON.stringify(record)).not.toContain('private');
  });
  it('rejects unbounded and executable tool arguments', () => {
    expect(ReadComponentsInput.safeParse({ ids: Array(17).fill('obs-a') }).success).toBe(false);
    expect(ReadComponentsInput.safeParse({ ids: ['obs-a'], path: 'private.laz' }).success).toBe(
      false,
    );
    expect(ReadComponentsInput.safeParse({ ids: ['obs-a'], code: 'exec()' }).success).toBe(false);
    expect(ReadComponentsInput.safeParse({ ids: ['obs-a'] }).success).toBe(true);
  });
  it('does not expose records that are absent from the approved inventory', () => {
    expect(measurementRecords([])).toEqual([]);
  });
});
