import { describe, expect, it } from 'vitest';
import { makeIssue } from '../testing';
import {
  createSearch,
  flattenGroups,
  groupIssues,
  issueZone,
  rowWindow,
  type RegisterRow,
} from './register';

describe('issueZone', () => {
  it('reads the zone of a kit finding from its location line', () => {
    const note =
      'Dust film on the panes\nLocation: 74.4 m above datum, East elevation side, Roof and crown.\nKit finding F0067.';
    expect(issueZone(makeIssue({ note }))).toBe('Roof and crown');
  });

  it('falls back to the side when the kit gives no zone', () => {
    const note = 'Rust.\nLocation: 77.0 m above datum, NE side.\nKit finding F01.';
    expect(issueZone(makeIssue({ note }))).toBe('NE side');
  });

  it('reads an uncertain photo zone and an HCl area', () => {
    expect(issueZone(makeIssue({ note: 'Recesses.\nZone podium.' }))).toBe('Podium');
    expect(issueZone(makeIssue({ note: 'A crack. Area: Bottom plate. Height 0.04 m.' }))).toBe(
      'Bottom plate',
    );
  });

  it('bands road chainage by kilometre', () => {
    expect(issueZone(makeIssue({ title: 'Bleeding at km 7.452' }))).toBe('km 7 to 8');
    expect(issueZone(makeIssue({ title: 'Longitudinal cracking at km 0.040' }))).toBe('km 0 to 1');
  });

  it('says so when there is no zone', () => {
    expect(issueZone(makeIssue({ note: '' }))).toBe('No zone');
  });
});

describe('groupIssues', () => {
  const issues = [
    makeIssue({ id: 'a', code: 'F01', severity: 2, classId: 'crack', status: 'reviewed' }),
    makeIssue({ id: 'b', code: 'F02', severity: 5, classId: 'blister' }),
    makeIssue({ id: 'c', code: 'F03', severity: 'uncertain', classId: 'crack' }),
    makeIssue({ id: 'd', code: 'F04', severity: 5, classId: 'crack' }),
  ];
  const label = (id: string) => ({ crack: 'Crack', blister: 'Coating blister' })[id] ?? id;

  it('keeps one group when not grouping', () => {
    const g = groupIssues(issues, 'none', label);
    expect(g.map((x) => x.issues.length)).toEqual([4]);
  });

  it('groups by severity, worst first, uncertain last, keeping the list order inside', () => {
    const g = groupIssues(issues, 'severity', label);
    expect(g.map((x) => [x.label, x.issues.map((i) => i.id)])).toEqual([
      ['Severity 5', ['b', 'd']],
      ['Severity 2', ['a']],
      ['Uncertain', ['c']],
    ]);
  });

  it('groups by class label and by status in workflow order', () => {
    expect(groupIssues(issues, 'class', label).map((x) => x.label)).toEqual([
      'Coating blister',
      'Crack',
    ]);
    expect(groupIssues(issues, 'status', label).map((x) => x.label)).toEqual(['draft', 'reviewed']);
  });

  it('reports the worst severity of each group', () => {
    const g = groupIssues(issues, 'class', label);
    expect(g.map((x) => x.top)).toEqual([5, 5]);
  });
});

describe('register rows', () => {
  const issues = Array.from({ length: 5 }, (_, k) =>
    makeIssue({ id: `i${k}`, code: `F0${k + 1}`, severity: k < 2 ? 5 : 1 }),
  );

  it('flattens groups into header and issue rows, hiding collapsed groups', () => {
    const groups = groupIssues(issues, 'severity', (x) => x);
    const rows = flattenGroups(groups, new Set(['sev:1']));
    expect(rows.map((r: RegisterRow) => (r.kind === 'group' ? `#${r.label}` : r.issue.id))).toEqual(
      ['#Severity 5', 'i0', 'i1', '#Severity 1'],
    );
  });

  it('has no header rows without grouping', () => {
    const rows = flattenGroups(
      groupIssues(issues, 'none', (x) => x),
      new Set(),
    );
    expect(rows.every((r) => r.kind === 'issue')).toBe(true);
  });

  it('renders only the rows in view plus overscan', () => {
    const rows: RegisterRow[] = Array.from({ length: 2115 }, (_, k) => ({
      kind: 'issue',
      issue: makeIssue({ id: `i${k}` }),
    }));
    const w = rowWindow(rows, { scrollTop: 48 * 1000, viewport: 480, rowH: 48, headH: 30 }, 5);
    expect(w.start).toBe(995);
    expect(w.end).toBe(1015);
    expect(w.padTop).toBe(995 * 48);
    expect(w.padTop + (w.end - w.start) * 48 + w.padBottom).toBe(2115 * 48);
  });

  it('accounts for group header heights', () => {
    const rows: RegisterRow[] = [
      { kind: 'group', key: 'g', label: 'G', count: 3, top: 1 },
      ...Array.from({ length: 3 }, (_, k): RegisterRow => ({
        kind: 'issue',
        issue: makeIssue({ id: `i${k}` }),
      })),
    ];
    const w = rowWindow(rows, { scrollTop: 0, viewport: 1000, rowH: 48, headH: 30 }, 0);
    expect([w.start, w.end, w.padBottom]).toEqual([0, 4, 0]);
    expect(w.offsetOf(2)).toBe(30 + 48);
  });
});

describe('createSearch', () => {
  it('matches code, title, note, author and class label, case-insensitively', () => {
    const search = createSearch((id) => (id === 'crack' ? 'Crack' : id));
    const a = makeIssue({ id: 'a', code: 'D0001', title: 'Bleeding', note: 'km 7' });
    expect(search([a], 'd0001')).toEqual([a]);
    expect(search([a], 'BLEED')).toEqual([a]);
    expect(search([a], 'crack')).toEqual([a]);
    expect(search([a], 'pothole')).toEqual([]);
    expect(search([a], '  ')).toEqual([a]);
  });

  it('searches 2,115 issues in a few milliseconds once indexed', () => {
    const search = createSearch((id) => id);
    const many = Array.from({ length: 2115 }, (_, k) =>
      makeIssue({ id: `i${k}`, title: k % 3 ? 'Bleeding at km 7' : 'Longitudinal cracking' }),
    );
    search(many, 'warm up');
    const t = performance.now();
    const hits = search(many, 'longitudinal');
    expect(performance.now() - t).toBeLessThan(15);
    expect(hits).toHaveLength(705);
  });
});
