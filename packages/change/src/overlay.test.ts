import { ChangeSet } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { changeMarkers } from './overlay';
import { issue } from './testing';

const set = ChangeSet.parse({
  schema: 'aio.change/1',
  id: 'd1-d2-issues',
  from: 'd1',
  to: 'd2',
  producer: 'issues',
  createdAt: '2026-10-06T08:00:00Z',
  items: [
    { kind: 'issue', id: 'issue:F01', verdict: 'grown', from: 'i-f01', to: 'i-f11', at: [1, 0, 0] },
    { kind: 'issue', id: 'issue:F02', verdict: 'resolved', from: 'i-f02', at: [10, 0, 0] },
    { kind: 'issue', id: 'issue:F12', verdict: 'new', to: 'i-f12', at: [20, 0, 0] },
    { kind: 'issue', id: 'issue:F09', verdict: 'unchanged' },
  ],
});
const issues = [
  issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] }),
  issue({ code: 'F11', layer: 'model-d2', at: [1, 0, 0] }),
];

describe('change pins on a view of one date', () => {
  it('puts each issue where it is on that date and ghosts what is not there', () => {
    const sel = { setId: 'd1-d2-issues', itemId: 'issue:F01' };
    const early = changeMarkers({ sets: [set], selected: sel, capture: 'd1', issues });
    expect(early.map((m) => [m.id, m.p, m.ghost, m.selected])).toEqual([
      ['issue:F12', [20, 0, 0], true, false],
      ['issue:F01', [0, 0, 0], false, true],
      ['issue:F02', [10, 0, 0], false, false],
    ]);
    const late = changeMarkers({ sets: [set], selected: sel, capture: 'd2', issues });
    expect(late.find((m) => m.id === 'issue:F01')?.p).toEqual([1, 0, 0]);
    expect(late.find((m) => m.id === 'issue:F02')?.ghost).toBe(true);
    expect(late.find((m) => m.id === 'issue:F12')?.color).toBe('#e5484d');
  });

  it('follows the register filter', () => {
    const m = changeMarkers({ sets: [set], selected: null, filter: { verdicts: ['new'] } });
    expect(m.map((x) => x.id)).toEqual(['issue:F12']);
  });
});
