import { describe, expect, it } from 'vitest';
import { applyNarrative, project } from './index';
import { issueRecord, TeamSim } from './testing/generator';

/**
 * Keys a journal op names are untrusted: `__proto__` must stay a plain key (or be refused), never
 * reach an object's prototype, and never crash the merge (security review, Oct 2026).
 */
describe('untrusted keys in ops', () => {
  const v = (text: string) => ({
    text,
    source: 'user' as const,
    createdAt: '2026-10-07T08:00:00.000Z',
    author: 'Rana Example',
  });

  it('a narrative part named __proto__ is refused without crashing the merge', () => {
    const out = applyNarrative(null, {
      narrative: [
        { part: '__proto__', version: v('bad'), order: 0 },
        { part: 'constructor', version: v('bad2'), order: 1 },
        { part: 'summary', version: v('good'), order: 2 },
      ],
    });
    expect(out.value.parts.summary?.versions.map((x) => x.text)).toEqual(['good']);
    expect(Object.keys(out.value.parts)).toEqual(['summary']);
    expect(out.problems.join(' ')).toMatch(/__proto__/);
  });

  it('a narrative.version op aimed at __proto__ projects and applies', () => {
    const sim = new TeamSim({ people: 1 });
    sim.write(0, 'narrative.version', { rec: 'narrative', id: '__proto__' }, { record: v('x') });
    expect(() => applyNarrative(null, project(sim.all()))).not.toThrow();
  });

  it('an issue patch setting __proto__ never changes what other fields read', () => {
    const sim = new TeamSim({ people: 1 });
    sim.write(
      0,
      'issue.create',
      { rec: 'issue', id: 'i_f02' },
      {
        record: issueRecord('i_f02', 'F02', 'Rana Example', '2026-10-07T08:00:00.000Z'),
      },
    );
    const evil = JSON.parse(
      '{"set":{"__proto__":{"resolvedIn":"x_pwned","severity":5}}}',
    ) as unknown;
    sim.write(0, 'issue.patch', { rec: 'issue', id: 'i_f02' }, evil);
    const issue = project(sim.all()).issues[0];
    expect(issue?.record.severity).toBe(2);
    expect('resolvedIn' in (issue?.record ?? {})).toBe(false);
    expect(Object.getPrototypeOf(issue?.record)).toBe(Object.prototype);
  });

  it('an op whose kind or record names an Object.prototype member never crashes the merge', () => {
    const sim = new TeamSim({ people: 1 });
    sim.write(
      0,
      'issue.create',
      { rec: 'issue', id: 'i_f02' },
      {
        record: issueRecord('i_f02', 'F02', 'Rana Example', '2026-10-07T08:00:00.000Z'),
      },
    );
    for (const kind of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      sim.write(0, kind, { rec: 'constructor', id: 'x' }, { set: { a: 1 } });
    }
    sim.write(0, 'record.external', { rec: 'constructor', id: 'y' }, { patch: { set: { a: 1 } } });
    expect(() => project(sim.all())).not.toThrow();
    expect(project(sim.all()).issues[0]?.record.severity).toBe(2);
  });
});
