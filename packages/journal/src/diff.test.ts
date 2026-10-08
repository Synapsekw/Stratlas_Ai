import { describe, expect, it } from 'vitest';
import { diffFields, diffIssues, diffRecordFile, isJournaledFile } from './diff';

const f01 = {
  id: 'i_f01',
  code: 'F01',
  classId: 'corrosion',
  severityModelId: 'sev-5',
  severity: 3,
  status: 'draft',
  title: 'Corrosion on flange',
  note: '',
  author: 'Rana Example',
  createdAt: '2026-10-01T06:00:00.000Z',
  updatedAt: '2026-10-01T06:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'site-mesh', geom: { type: 'spoint', p: [1, 2, 3] } }],
  source: 'human',
};

describe('diffFields', () => {
  it('lists set and unset fields with their old values', () => {
    expect(diffFields({ a: 1, b: 2, c: 3 }, { a: 1, b: 4, d: 5 })).toEqual({
      set: { b: 4, d: 5 },
      unset: ['c'],
      was: { b: 2, c: 3 },
    });
    expect(diffFields({ a: [1, { x: 1, y: 2 }] }, { a: [1, { y: 2, x: 1 }] })).toEqual({});
  });
});

describe('diffIssues', () => {
  it('makes a create, a labelled patch, a status step, a sighting and a delete', () => {
    const f02 = { ...f01, id: 'i_f02', code: 'F02' };
    const next = {
      ...f01,
      severity: 4,
      status: 'reviewed',
      updatedAt: '2026-10-02T06:00:00.000Z',
      sightings: [...f01.sightings, { on: 'image', layer: 'photos', photo: 'p1' }],
    };
    const ops = diffIssues(
      [f01, f02],
      [next, { ...f02, id: 'i_f03', code: 'F03' }],
      [
        { label: 'F01 severity 3 to 4', ids: ['i_f01'] },
        { label: 'F01 to reviewed', ids: ['i_f01'] },
      ],
    );
    expect(ops.map((o) => [o.kind, o.target.id, o.label])).toEqual([
      ['issue.sighting.add', 'i_f01', 'F01 to reviewed'],
      ['issue.status', 'i_f01', 'F01 to reviewed'],
      ['issue.patch', 'i_f01', 'F01 to reviewed'],
      ['issue.create', 'i_f03', undefined],
      ['issue.delete', 'i_f02', undefined],
    ]);
    const patch = ops.find((o) => o.kind === 'issue.patch');
    expect(patch?.payload).toEqual({
      set: { severity: 4, updatedAt: '2026-10-02T06:00:00.000Z' },
      was: { severity: 3, updatedAt: '2026-10-01T06:00:00.000Z' },
    });
    expect(patch?.base).toMatch(/^[a-f0-9]{64}$/);
    expect(ops.find((o) => o.kind === 'issue.status')?.payload).toEqual({
      from: 'draft',
      to: 'reviewed',
    });
  });

  it('gives nothing for an unchanged list', () => {
    expect(diffIssues([f01], [structuredClone(f01)])).toEqual([]);
  });
});

describe('diffRecordFile', () => {
  it('knows which files it follows', () => {
    expect(isJournaledFile('issues.json')).toBe(true);
    expect(isJournaledFile('change/c1.json')).toBe(true);
    expect(isJournaledFile('detections/ai.json')).toBe(true);
    expect(isJournaledFile('models/m1.procmodel.json')).toBe(true);
    expect(isJournaledFile('edits/boundaries.json')).toBe(true);
    expect(isJournaledFile('report/narrative.json')).toBe(true);
    expect(isJournaledFile('manifest.json')).toBe(true);
    expect(isJournaledFile('journal/ops/x/000001.jsonl')).toBe(false);
    expect(isJournaledFile('team.json')).toBe(false);
  });

  it('reviews change items one by one', () => {
    const set = (status: string) => ({
      schema: 'aio.change/1',
      id: 'c1',
      items: [
        { id: 'x1', kind: 'issue', review: { status } },
        { id: 'x2', kind: 'issue' },
      ],
    });
    const ops = diffRecordFile('change/c1.json', set('open'), set('confirmed'));
    expect(ops).toEqual([
      expect.objectContaining({
        kind: 'change.review',
        target: { rec: 'change-item', id: 'x1', in: 'c1' },
        payload: { set: { review: { status: 'confirmed' } }, was: { review: { status: 'open' } } },
      }),
    ]);
  });

  it('treats a detection pass without ids as one record', () => {
    const pass = (n: number) => ({ schema: 'aio.detections/1', detections: [{ status: n }] });
    const ops = diffRecordFile('detections/a.json', pass(1), pass(2));
    expect(ops).toHaveLength(1);
    expect(ops[0]?.target).toEqual({ rec: 'detection-pass', id: 'a.json' });
  });

  it('records a boundary edit as a whole record, and a removed one as removed', () => {
    const edit = { pile: 'p1', epoch: 'e1', areaM2: 4 };
    const file = (edits: unknown[]) => ({ schema: 'aio.boundaries/1', edits });
    expect(diffRecordFile('edits/boundaries.json', file([]), file([edit]))).toEqual([
      expect.objectContaining({
        kind: 'boundary.edit',
        target: { rec: 'boundary', id: 'p1/e1' },
        payload: { record: edit },
      }),
    ]);
    expect(diffRecordFile('edits/boundaries.json', file([edit]), file([]))[0]?.payload).toEqual({
      record: { removed: true },
      was: edit,
    });
  });

  it('falls back to one external op for a file it cannot read', () => {
    const ops = diffRecordFile('issues.json', 'not json', { schema: 'aio.issues/1', issues: [] });
    expect(ops).toEqual([expect.objectContaining({ kind: 'record.external' })]);
  });
});

describe('diffRecordFile: survey/designs.json (M11 G6)', () => {
  const layer = (archived: boolean) => ({
    id: 'pad',
    name: 'Pad',
    kind: 'surface',
    file: 'pad.tin',
    counts: { triangles: 8 },
    visible: true,
    archived,
    verticalOffsetM: 0,
  });
  const design = (archived = false, name = 'Pad design') => ({
    id: 'd1',
    name,
    src: 'pad.xml',
    layers: [layer(archived)],
  });
  const file = (designs: unknown[], extra: Record<string, unknown> = {}) => ({
    schema: 'aio.designs/1',
    designs,
    ...extra,
  });
  const rel = 'survey/designs.json';

  it('records a new design as design.add with the whole record', () => {
    expect(diffRecordFile(rel, file([]), file([design()]))).toEqual([
      expect.objectContaining({
        kind: 'design.add',
        target: { rec: 'design', id: 'd1' },
        payload: { record: design() },
      }),
    ]);
  });

  it('records archiving a layer as design.archive and other changes as design.patch', () => {
    const archive = diffRecordFile(rel, file([design()]), file([design(true)]));
    expect(archive.map((o) => o.kind)).toEqual(['design.archive']);
    const rename = diffRecordFile(rel, file([design()]), file([design(false, 'Pad v2')]));
    expect(rename).toEqual([
      expect.objectContaining({
        kind: 'design.patch',
        payload: { set: { name: 'Pad v2' }, was: { name: 'Pad design' } },
      }),
    ]);
    const active = diffRecordFile(
      rel,
      file([design()]),
      file([design()], { activeAlignment: 'd1/cl' }),
    );
    expect(active).toEqual([
      expect.objectContaining({ kind: 'design.patch', target: { rec: 'designs', id: 'file' } }),
    ]);
  });
});
