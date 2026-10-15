import type { ClassCatalogue, SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { classRows, moveTargets } from './classesView';

const models: SeverityModel[] = [
  {
    id: 'sev',
    name: 'General',
    levels: [{ value: 1, label: 'Minor', color: '#000000', criteria: '' }],
  },
];
const catalogues: ClassCatalogue[] = [
  {
    id: 'cat',
    name: 'Classes',
    assetType: 'asset',
    classes: [
      { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' },
      { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'gone' },
    ],
  },
];

describe('classes view', () => {
  it('lists every class with its usage and model name', () => {
    const rows = classRows(
      catalogues,
      models,
      [{ classId: 'crack' }, { classId: 'crack' }],
      [{ classId: 'rust', status: 'draft' }],
    );
    expect(rows.map((r) => [r.cls.id, r.issues, r.detections, r.modelName])).toEqual([
      ['crack', 2, 0, 'General'],
      ['rust', 0, 1, 'gone'],
    ]);
  });

  it('offers every other class as the target of a delete', () => {
    const rows = classRows(catalogues, models, [], []);
    expect(moveTargets(rows, 'crack').map((c) => c.id)).toEqual(['rust']);
  });
});
