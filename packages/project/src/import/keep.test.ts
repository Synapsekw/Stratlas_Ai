import type { Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { mergeImportedIssues } from './keep';

const T0 = '2026-09-29T07:25:00.000Z';
const T1 = '2026-10-04T03:00:26.657Z';

function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    code: id,
    classId: 'crack',
    severityModelId: 'm',
    severity: 2,
    status: 'draft',
    title: 'Crack',
    note: '',
    author: 'Kit',
    createdAt: T0,
    updatedAt: T0,
    sightings: [
      { on: 'mesh', layer: 'model', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } },
    ],
    source: 'import',
    ...over,
  };
}

describe('mergeImportedIssues', () => {
  it('takes the fresh import for issues nobody touched', () => {
    const out = mergeImportedIssues([issue('F01')], [issue('F01', { status: 'reviewed' })]);
    expect(out.map((i) => [i.id, i.status])).toEqual([['F01', 'reviewed']]);
  });

  it('keeps issues people created, after the imported ones', () => {
    const mine = issue('a1b2', {
      code: 'F12',
      source: 'human',
      author: 'D',
      createdAt: T1,
      updatedAt: T1,
    });
    const out = mergeImportedIssues([issue('F01'), mine], [issue('F01'), issue('F02')]);
    expect(out.map((i) => i.id)).toEqual(['F01', 'F02', 'a1b2']);
  });

  it('keeps an imported issue someone edited since the last import', () => {
    const edited = issue('F01', { status: 'approved', updatedAt: T1 });
    const out = mergeImportedIssues([edited], [issue('F01', { status: 'reviewed' })]);
    expect(out).toEqual([edited]);
  });

  it('drops untouched imported issues the source no longer has', () => {
    const out = mergeImportedIssues([issue('F01'), issue('F09')], [issue('F01')]);
    expect(out.map((i) => i.id)).toEqual(['F01']);
  });

  it('keeps an edited imported issue the source no longer has', () => {
    const edited = issue('F09', { note: 'checked on site', updatedAt: T1 });
    const out = mergeImportedIssues([edited], [issue('F01')]);
    expect(out.map((i) => i.id)).toEqual(['F01', 'F09']);
  });

  it('ignores entries that are not issues', () => {
    expect(mergeImportedIssues([{ junk: true }], [issue('F01')]).map((i) => i.id)).toEqual(['F01']);
  });
});
