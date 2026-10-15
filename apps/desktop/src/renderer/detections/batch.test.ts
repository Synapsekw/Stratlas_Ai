import type { Detection, ReviewChange } from '@aio/annotate/detections';
import type { ClassCatalogue, SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { acceptLabel, planBatch, rejectLabel, undoStep } from './batch';

const model: SeverityModel = {
  id: 'sev',
  name: 'S',
  levels: [{ value: 1, label: 'Minor', color: '#78b3d6', criteria: 'M' }],
};
const catalogues: ClassCatalogue[] = [
  {
    id: 'c',
    name: 'C',
    assetType: 'asset',
    classes: [{ id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' }],
  },
];
const det = (id: string, over: Partial<Detection> = {}): Detection => ({
  id,
  pass: 'p.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p1' },
  size: [100, 100],
  geom: { type: 'box', x: 1, y: 1, w: 5, h: 5 },
  classId: 'crack',
  severity: 1,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'model', producer: 'm' },
  ...over,
});

describe('Accept all planning', () => {
  it('counts what Accept all and Reject all would do with the list on screen', () => {
    const plan = planBatch(
      [det('a'), det('b', { classId: '' }), det('c', { status: 'rejected' }), det('d')],
      { models: [model], catalogues },
    );
    expect(plan).toEqual({ accept: 2, skip: 1, reject: 3 });
  });

  it('names the commands the same in the editor and the review', () => {
    expect(acceptLabel(1)).toBe('Accept 1 detection');
    expect(acceptLabel(4)).toBe('Accept 4 detections');
    expect(rejectLabel(2)).toBe('Reject 2 detections');
  });
});

describe('undo step needs the issue editor matching command', () => {
  const batch: ReviewChange = { label: 'Accept 2 detections', before: {}, after: {}, issues: true };
  const plain: ReviewChange = { label: 'Reject detection', before: {}, after: {} };
  it('undoes review changes alone, an Accept all with its issues, refuses a moved one', () => {
    expect(undoStep(undefined, null)).toBe('none');
    expect(undoStep(plain, 'Edit F01')).toBe('review');
    expect(undoStep(batch, 'Accept 2 detections')).toBe('with-issues');
    expect(undoStep(batch, 'Edit F03')).toBe('blocked');
  });

  it('pairs a batch with its own issues, not another batch of the same size', () => {
    const second: ReviewChange = {
      label: 'Accept 2 detections',
      before: { d3: det('d3'), d4: det('d4') },
      after: {
        d3: det('d3', { status: 'accepted', issueId: 'i3' }),
        d4: det('d4', { status: 'accepted', issueId: 'i4' }),
      },
      issues: true,
    };
    // the second batch's issues were undone in the register; the editor's top is the first batch
    const firstOnly = new Set(['i1', 'i2']);
    const has = (id: string) => firstOnly.has(id);
    expect(undoStep(second, 'Accept 2 detections', has)).toBe('blocked');
    const both = new Set(['i1', 'i2', 'i3', 'i4']);
    expect(undoStep(second, 'Accept 2 detections', (id) => both.has(id))).toBe('with-issues');
    // redo: the batch's issues must not be in the register yet
    expect(undoStep(second, 'Accept 2 detections', has, false)).toBe('with-issues');
    expect(undoStep(second, 'Accept 2 detections', (id) => both.has(id), false)).toBe('blocked');
  });
});
