import { compareCodes as agentOrder } from '@aio/ai';
import { compareCodes as registerOrder, sortIssues } from '@aio/annotate';
import type { Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';

/**
 * The agent picks "the first by code" with its own copy of the register's code order (`@aio/ai`
 * must not depend on `@aio/annotate`). This app sees both, so it holds the two together: if one
 * changes, the finding the agent shows first is no longer the one the register lists first.
 */
const CODES = [
  // the number counts, not the text: F2 before F10, F05 between them
  'F2',
  'F10',
  'F05',
  'F1',
  'F100',
  // other prefixes, and prefixes of more than one letter
  'D9',
  'A01',
  'AG01',
  'AG12',
  'B3',
  // lower and upper case
  'f2',
  'f10',
  'Ab3',
  'd9',
  // without digits, and digits only
  'F',
  'AG',
  'NOTE',
  '7',
  '12',
  '',
  // neither prefix then number
  'F-12',
  'F 3',
  'TANK-2-F01',
  '3F',
  // the same code twice
  'F05',
  'D9',
];

const issue = (code: string, n: number): Issue => ({
  id: `i${String(n)}`,
  code,
  classId: 'corrosion',
  severityModelId: 'sev',
  severity: 3,
  status: 'draft',
  title: code,
  note: '',
  author: 'QA',
  createdAt: '2026-10-11T08:00:00Z',
  updatedAt: '2026-10-11T08:00:00Z',
  sightings: [],
  source: 'human',
});

describe('the agent orders codes as the issue register does', () => {
  it('agrees on every pair of codes, both ways round', () => {
    for (const a of CODES) {
      for (const b of CODES) {
        expect(Math.sign(agentOrder(a, b)), `"${a}" against "${b}"`).toBe(
          Math.sign(registerOrder(a, b)),
        );
      }
    }
  });

  it('sorts a list into the same order', () => {
    expect([...CODES].sort(agentOrder)).toEqual([...CODES].sort(registerOrder));
    expect([...CODES].reverse().sort(agentOrder)).toEqual([...CODES].reverse().sort(registerOrder));
  });

  it('lists findings in the order the register shows them, sorted by code', () => {
    const issues = CODES.map(issue);
    const byAgent = [...issues].sort((a, b) => agentOrder(a.code, b.code)).map((i) => i.id);
    expect(byAgent).toEqual(sortIssues(issues, 'code', 'asc').map((i) => i.id));
  });

  it('puts F2 before F10', () => {
    expect(agentOrder('F2', 'F10')).toBeLessThan(0);
    expect(agentOrder('F05', 'F05')).toBe(0);
  });
});
