import { canonicalJson } from '@aio/journal';
import type { Op } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { applyIssues, indexOps, project, stateFileText, type Projection } from './index';
import { randomHistory, seededRandom } from './testing/generator';

/**
 * Property tests with a seeded generator (fast-check is not in the lockfile): for any arrival
 * order, any duplication and any partition of a history, every copy projects the same state and
 * writes the same bytes; projecting is idempotent and commutative; no write is lost silently.
 */

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

function snapshot(p: Projection): string {
  return canonicalJson({
    file: stateFileText(applyIssues(null, p).value),
    issues: p.issues,
    sub: p.subRecords,
    boundaries: p.boundaries,
    narrative: p.narrative,
    collab: p.collab,
    conflicts: p.conflicts,
    quarantined: p.quarantined,
    held: p.held,
    recodes: p.recodes,
    applied: p.applied,
  });
}

function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function partition<T>(xs: readonly T[], parts: number, rnd: () => number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  for (const x of xs) out[Math.floor(rnd() * parts)]?.push(x);
  return out;
}

describe('convergence', () => {
  it.each(SEEDS)('any order and duplication gives the same bytes (seed %i)', (seed) => {
    const { ops } = randomHistory({ seed, people: 3, steps: 80 });
    const base = snapshot(project(ops));
    const rnd = seededRandom(seed * 7919);
    for (let k = 0; k < 4; k += 1) {
      const dup = [...ops, ...ops.filter(() => rnd() < 0.3)];
      expect(snapshot(project(shuffle(dup, rnd)))).toBe(base);
    }
  });

  it.each(SEEDS)('any partition merged in any order converges (seed %i)', (seed) => {
    const { ops } = randomHistory({ seed, people: 4, steps: 60 });
    const rnd = seededRandom(seed * 104729);
    const parts = partition(ops, 3, rnd);
    // each part alone projects without throwing (ops after a gap are held, not applied)
    for (const part of parts) expect(() => project(part)).not.toThrow();
    const a = parts.flat();
    const b = shuffle(parts, rnd).flat();
    expect(snapshot(project(b))).toBe(snapshot(project(a)));
  });

  it.each(SEEDS.slice(0, 15))(
    'every copy projects the same state after syncing (seed %i)',
    (seed) => {
      const { sim } = randomHistory({ seed, people: 3, steps: 60, syncChance: 0.4 });
      const views = [0, 1, 2].map((i) => snapshot(project(sim.known(i))));
      expect(views[1]).toBe(views[0]);
      expect(views[2]).toBe(views[0]);
    },
  );

  it('is idempotent and commutative', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const { ops } = randomHistory({ seed, people: 3, steps: 50 });
      const rnd = seededRandom(seed);
      const [a = [], b = []] = partition(ops, 2, rnd);
      expect(snapshot(project([...ops, ...ops]))).toBe(snapshot(project(ops)));
      expect(snapshot(project([...a, ...b]))).toBe(snapshot(project([...b, ...a])));
    }
  });
});

describe('no silent loss', () => {
  it.each(SEEDS.slice(0, 20))(
    'every overwritten value is in history or conflicts (seed %i)',
    (seed) => {
      const { ops } = randomHistory({ seed, people: 3, steps: 90 });
      const p = project(ops);
      const index = indexOps(ops);
      const applied = new Set(p.applied);
      const patches: Op[] = ops.filter((o) => o.kind === 'issue.patch' && applied.has(o.id));
      // 1. every value written stays in history
      for (const op of patches) {
        const set = (op.payload as { set?: Record<string, unknown> }).set ?? {};
        for (const field of Object.keys(set)) {
          const h = p.history(op.target, field);
          expect(h.some((w) => w.op === op.id)).toBe(true);
        }
      }
      // 2. a concurrent losing value nobody replaced is a conflict
      for (const issue of p.issues.filter((i) => i.state === 'live')) {
        for (const field of ['severity', 'title', 'note']) {
          const h = p.history({ rec: 'issue', id: issue.id }, field);
          const winner = h.at(-1);
          if (!winner) continue;
          const node = (id: string) => index.byId.get(id) ?? expect.fail(id);
          for (const w of h) {
            if (w.op === winner.op || canonicalJson(w.value) === canonicalJson(winner.value))
              continue;
            if (index.before(node(w.op), node(winner.op))) continue;
            if (h.some((x) => x.op !== w.op && index.before(node(w.op), node(x.op)))) continue;
            const listed = p.conflicts.some(
              (c) =>
                c.target.id === issue.id &&
                c.field === field &&
                [c.ours.value, c.theirs.value].some(
                  (v) => canonicalJson(v) === canonicalJson(w.value),
                ),
            );
            expect(listed, `${issue.id}.${field} = ${String(w.value)}`).toBe(true);
          }
        }
      }
    },
  );
});
