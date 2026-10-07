import { describe, expect, it } from 'vitest';
import { project } from './index';
import { randomHistory } from './testing/generator';

describe('randomHistory', () => {
  it('is deterministic for a seed', () => {
    const a = randomHistory({ seed: 3, steps: 40 })
      .ops.map((o) => o.id)
      .sort();
    const b = randomHistory({ seed: 3, steps: 40 })
      .ops.map((o) => o.id)
      .sort();
    expect(a).toEqual(b);
  });

  it('plants every kind of conflict the inbox shows across seeds', () => {
    const kinds = new Set<string>();
    const fields = new Set<string>();
    let deleted = 0;
    let recodes = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const p = project(randomHistory({ seed, people: 3, steps: 80 }).ops);
      for (const c of p.conflicts) {
        kinds.add(c.kind);
        fields.add(`${c.target.rec}.${c.field}`);
      }
      deleted += p.issues.filter((i) => i.state === 'deleted').length;
      recodes += p.recodes.length;
    }
    expect([...kinds].sort()).toEqual(['code', 'delete-edit', 'merge', 'status', 'value']);
    expect(fields).toContain('issue.severity');
    expect(fields).toContain('issue.assignee');
    expect(fields).toContain('change-item.status');
    expect(deleted).toBeGreaterThan(0);
    expect(recodes).toBeGreaterThan(0);
  });
});
