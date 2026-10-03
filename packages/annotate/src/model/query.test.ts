import { describe, expect, it } from 'vitest';
import { LATER, makeIssue, photoSighting, videoSighting } from '../testing';
import { compareCodes, filterIssues, issueDatasets, sortIssues, severityCounts } from './query';

const issues = [
  makeIssue({ id: 'a', code: 'F10', severity: 3, classId: 'blister', title: 'Roof blisters' }),
  makeIssue({
    id: 'b',
    code: 'F02',
    severity: 5,
    status: 'approved',
    sightings: [photoSighting],
    note: 'leak at weld',
    updatedAt: LATER,
  }),
  makeIssue({ id: 'c', code: 'F1', severity: 'uncertain', sightings: [videoSighting] }),
];

describe('filterIssues', () => {
  it('returns everything for an empty filter', () => {
    expect(filterIssues(issues, {})).toHaveLength(3);
  });

  it('filters by severity, including uncertain', () => {
    expect(filterIssues(issues, { severities: [5, 'uncertain'] }).map((i) => i.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('filters by class and status', () => {
    expect(filterIssues(issues, { classIds: ['blister'] }).map((i) => i.id)).toEqual(['a']);
    expect(filterIssues(issues, { statuses: ['approved'] }).map((i) => i.id)).toEqual(['b']);
  });

  it('filters by dataset kind and layer', () => {
    expect(filterIssues(issues, { datasets: ['video'] }).map((i) => i.id)).toEqual(['c']);
    expect(filterIssues(issues, { layers: ['photos'] }).map((i) => i.id)).toEqual(['b']);
  });

  it('searches code, title, note and class label, case-insensitive', () => {
    expect(filterIssues(issues, { text: 'LEAK' }).map((i) => i.id)).toEqual(['b']);
    expect(filterIssues(issues, { text: 'f10' }).map((i) => i.id)).toEqual(['a']);
    expect(
      filterIssues(issues, { text: 'coating' }, (id) => (id === 'blister' ? 'Coating' : id)).map(
        (i) => i.id,
      ),
    ).toEqual(['a']);
  });
});

describe('sortIssues', () => {
  it('sorts codes naturally', () => {
    expect(sortIssues(issues, 'code').map((i) => i.code)).toEqual(['F1', 'F02', 'F10']);
    expect(compareCodes('D9', 'F1')).toBeLessThan(0);
  });

  it('sorts by severity, highest first, uncertain last', () => {
    expect(sortIssues(issues, 'severity').map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by last change, newest first, and can reverse', () => {
    expect(sortIssues(issues, 'updated')[0]?.id).toBe('b');
    expect(sortIssues(issues, 'code', 'desc').map((i) => i.code)).toEqual(['F10', 'F02', 'F1']);
  });

  it('sorts by status order', () => {
    expect(sortIssues(issues, 'status').at(-1)?.id).toBe('b');
  });
});

describe('summaries', () => {
  it('counts severities', () => {
    expect(severityCounts(issues)).toEqual(
      new Map<number | 'uncertain', number>([
        [3, 1],
        [5, 1],
        ['uncertain', 1],
      ]),
    );
  });

  it('lists the dataset kinds of an issue', () => {
    expect(issueDatasets(makeIssue({ sightings: [photoSighting, photoSighting] }))).toEqual([
      'image',
    ]);
  });
});
