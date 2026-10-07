import { describe, expect, it } from 'vitest';
import { applyIssues, project, stateFileText } from './index';
import { issueRecord, seededRandom, TeamSim } from './testing/generator';

/**
 * Bench (M9 review focus "Scale"): 10,000 incoming ops on a 5,000-issue project merge in under
 * 3 s in the data process. Building the history is not timed.
 */
describe('scale', () => {
  it('merges 10k incoming ops on a 5k-issue project in under 3 s', () => {
    const sim = new TeamSim({ people: 3 });
    const at = '2026-10-07T08:00:00.000Z';
    for (let i = 0; i < 5000; i += 1) {
      const id = `i_${String(i).padStart(5, '0')}`;
      const code = `F${String(i + 1).padStart(4, '0')}`;
      sim.write(
        0,
        'issue.create',
        { rec: 'issue', id },
        { record: issueRecord(id, code, 'Rana Example', at) },
      );
    }
    sim.syncAll();
    const rnd = seededRandom(42);
    for (let k = 0; k < 10_000; k += 1) {
      const who = 1 + (k % 2);
      const id = `i_${String(Math.floor(rnd() * 5000)).padStart(5, '0')}`;
      sim.write(
        who,
        'issue.patch',
        { rec: 'issue', id },
        { set: { severity: 1 + (k % 5), updatedAt: at } },
      );
      if (k % 2000 === 0) sim.sync(who, 0);
    }
    const ops = sim.all();
    expect(ops.length).toBeGreaterThanOrEqual(15_000);
    const t0 = performance.now();
    const p = project(ops);
    const text = stateFileText(applyIssues(null, p).value);
    const ms = performance.now() - t0;
    expect(p.issues).toHaveLength(5000);
    expect(text.length).toBeGreaterThan(0);
    expect(p.conflicts.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(3000);
  }, 60_000);
});
